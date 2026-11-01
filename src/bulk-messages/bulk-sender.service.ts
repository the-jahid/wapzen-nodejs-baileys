import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  appendMessage,
  ensureConversation,
} from '../chat-conversations/chat-conversations.store';
import { PrismaService } from '../prisma/prisma.service';
import {
  NotOnWhatsAppError,
  NumberNotConnectedError,
  WhatsAppService,
} from '../whatsapp/whatsapp.service';
import { renderMessage } from './bulk-messages.types';

// How often the sender looks for a send whose next message is due. It only
// decides when a message may go out; the gap between two messages of one
// send is that send's interval_seconds.
const TICK_MS = 2_000;
// Sends handled in one tick, each on its own number.
const MAX_CLAIMED = 25;
// A message that hasn't gone after this long is given up on.
const SEND_TIMEOUT_MS = 45_000;
// A recipient still marked sending after this long belongs to a server that
// stopped mid-send.
const STUCK_AFTER = '2 minutes';
const RECOVER_EVERY_MS = 5 * 60_000;

type DueCampaign = {
  id: string;
  userId: string;
  phoneNumberId: string | null;
  message: string;
};

type ClaimedRecipient = {
  id: string;
  phone: string;
  variables: Record<string, string>;
};

// Sends bulk messages one at a time per send, from a timer, so they keep
// going with nobody watching the dashboard and pick up again after a restart.
//
// Claiming is done in the database, not in memory: the send's next_send_at
// is moved forward in the same statement that picks it, and the recipient is
// marked sending in the statement that picks it. During a deploy the old and
// new servers both run this loop, and neither can send a message the other
// already took.
@Injectable()
export class BulkSenderService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(BulkSenderService.name);
  private readonly inFlight = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsAppService,
  ) {}

  onApplicationBootstrap() {
    const recover = () =>
      this.recoverInterrupted().catch((err: Error) =>
        this.logger.error(`recovering bulk sends failed: ${err.message}`),
      );
    void recover();
    this.timers = [
      setInterval(() => void this.tick(), TICK_MS),
      setInterval(() => void recover(), RECOVER_EVERY_MS),
    ];
  }

  onModuleDestroy() {
    this.timers.forEach(clearInterval);
  }

  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const due = await this.claimDue();
      for (const campaign of due) {
        this.inFlight.add(campaign.id);
        void this.sendNext(campaign)
          .catch((err: Error) =>
            this.logger.error(
              `bulk send ${campaign.id} failed: ${err.message}`,
            ),
          )
          .finally(() => this.inFlight.delete(campaign.id));
      }
    } catch (err) {
      this.logger.error(
        `claiming bulk sends failed: ${(err as Error).message}`,
      );
    } finally {
      this.ticking = false;
    }
  }

  // Takes every running send whose next message is due and books its next
  // turn one interval ahead, so the gap holds whatever this message does.
  private claimDue() {
    return this.prisma.$queryRaw<DueCampaign[]>`
      UPDATE bulk_campaigns c
      SET next_send_at = now() + make_interval(secs => c.interval_seconds),
        updated_at = now()
      WHERE c.id IN (
        SELECT id FROM bulk_campaigns
        WHERE status = 'running' AND next_send_at <= now()
          AND NOT (id = ANY(${[...this.inFlight]}::text[]))
        ORDER BY next_send_at
        LIMIT ${MAX_CLAIMED}
        FOR UPDATE SKIP LOCKED)
      RETURNING c.id, c.user_id AS "userId",
        c.phone_number_id AS "phoneNumberId", c.message`;
  }

  private async sendNext(campaign: DueCampaign) {
    if (!campaign.phoneNumberId) {
      await this.prisma.bulkCampaign.updateMany({
        where: { id: campaign.id, status: 'running' },
        data: {
          status: 'paused',
          lastError: 'The number this send used was removed from the account.',
        },
      });
      return;
    }

    const [recipient] = await this.prisma.$queryRaw<ClaimedRecipient[]>`
      UPDATE bulk_recipients SET status = 'sending'
      WHERE id = (
        SELECT id FROM bulk_recipients
        WHERE campaign_id = ${campaign.id} AND status = 'pending'
        ORDER BY position
        LIMIT 1
        FOR UPDATE SKIP LOCKED)
      RETURNING id, phone, variables`;
    if (!recipient) {
      await this.completeIfDone(campaign.id);
      return;
    }

    const text = renderMessage(
      campaign.message,
      recipient.phone,
      recipient.variables,
    );
    if (!text) {
      await this.finish(
        campaign.id,
        recipient.id,
        'failed',
        'The message came out empty for this row.',
      );
      await this.completeIfDone(campaign.id);
      return;
    }

    let sent: { pnJid: string; lidJid: string | null };
    try {
      sent = await withTimeout(
        this.whatsapp.sendToPhone(
          campaign.phoneNumberId,
          recipient.phone,
          text,
        ),
        SEND_TIMEOUT_MS,
      );
    } catch (err) {
      if (err instanceof NumberNotConnectedError) {
        // Nothing was sent: the number goes back in the queue and the send
        // waits for the phone to come back online.
        await this.prisma.$transaction([
          this.prisma.bulkRecipient.updateMany({
            where: { id: recipient.id, status: 'sending' },
            data: { status: 'pending' },
          }),
          this.prisma.bulkCampaign.updateMany({
            where: { id: campaign.id },
            data: {
              lastError:
                'Waiting for the number to reconnect. Open Phone Numbers if it stays offline.',
            },
          }),
        ]);
        return;
      }
      const reason =
        err instanceof NotOnWhatsAppError
          ? 'This number is not on WhatsApp.'
          : `WhatsApp refused the message: ${(err as Error).message}`;
      await this.finish(campaign.id, recipient.id, 'failed', reason);
      await this.completeIfDone(campaign.id);
      return;
    }

    await this.finish(campaign.id, recipient.id, 'sent');
    await this.completeIfDone(campaign.id);
    await this.recordInChat(
      { ...campaign, phoneNumberId: campaign.phoneNumberId },
      recipient,
      sent,
      text,
    );
  }

  private finish(
    campaignId: string,
    recipientId: string,
    status: 'sent' | 'failed',
    error?: string,
  ) {
    return this.prisma.$transaction([
      this.prisma.bulkRecipient.updateMany({
        where: { id: recipientId },
        data: {
          status,
          error: error ?? null,
          sentAt: status === 'sent' ? new Date() : null,
        },
      }),
      this.prisma.bulkCampaign.updateMany({
        where: { id: campaignId },
        data:
          status === 'sent'
            ? { sentCount: { increment: 1 }, lastError: null }
            : { failedCount: { increment: 1 } },
      }),
    ]);
  }

  private completeIfDone(campaignId: string) {
    return this.prisma.$executeRaw`
      UPDATE bulk_campaigns
      SET status = 'completed', completed_at = now(), updated_at = now()
      WHERE id = ${campaignId} AND status = 'running'
        AND NOT EXISTS (
          SELECT 1 FROM bulk_recipients
          WHERE campaign_id = ${campaignId} AND status IN ('pending', 'sending'))`;
  }

  // Puts the message in Conversations, on the thread the contact's reply
  // will land on. Replies usually arrive from the contact's "@lid", so that
  // is used unless the number already has a thread under the phone JID.
  // Failing to save it is logged; the message did go out.
  private async recordInChat(
    campaign: DueCampaign & { phoneNumberId: string },
    recipient: ClaimedRecipient,
    sent: { pnJid: string; lidJid: string | null },
    text: string,
  ) {
    try {
      const jids = [sent.lidJid, sent.pnJid].filter((j): j is string => !!j);
      const [existing, agent] = await Promise.all([
        this.prisma.chatConversation.findFirst({
          where: {
            phoneNumberId: campaign.phoneNumberId,
            peerJid: { in: jids },
          },
          select: { peerJid: true },
        }),
        this.prisma.chatAgent.findFirst({
          where: { phoneNumberId: campaign.phoneNumberId },
          select: { id: true },
        }),
      ]);
      const conversationId = await ensureConversation(this.prisma, {
        userId: campaign.userId,
        phoneNumberId: campaign.phoneNumberId,
        chatAgentId: agent?.id,
        peerJid: existing?.peerJid ?? jids[0],
        peerPhone: recipient.phone,
        peerName: recipient.variables.name,
      });
      await appendMessage(this.prisma, conversationId, 'assistant', text);
    } catch (err) {
      this.logger.error(
        `saving bulk message to ${recipient.phone} failed: ${(err as Error).message}`,
      );
    }
  }

  // A server that stopped mid-send leaves its recipient marked sending. It
  // can't be known whether that message went, so it is counted as failed
  // rather than sent twice.
  private async recoverInterrupted() {
    await this.prisma.$executeRaw`
      WITH stuck AS (
        UPDATE bulk_recipients r
        SET status = 'failed',
          error = 'The server restarted while this message was being sent; it may not have arrived.'
        FROM bulk_campaigns c
        WHERE r.campaign_id = c.id AND r.status = 'sending'
          AND c.updated_at < now() - ${STUCK_AFTER}::interval
        RETURNING r.campaign_id)
      UPDATE bulk_campaigns c
      SET failed_count = c.failed_count + s.n, updated_at = now()
      FROM (SELECT campaign_id, count(*)::int AS n FROM stuck GROUP BY campaign_id) s
      WHERE c.id = s.campaign_id`;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
