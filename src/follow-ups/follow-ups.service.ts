import { randomUUID } from 'node:crypto';
import {
  HttpStatus,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { apiError } from '../chat-agents/chat-agents.types';
import { appendMessage } from '../chat-conversations/chat-conversations.store';
import type { ChatFollowUp, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ChatResponderService } from '../whatsapp/chat-responder.service';
import {
  NumberNotConnectedError,
  WhatsAppService,
} from '../whatsapp/whatsapp.service';
import { createFollowUpReviewer } from './follow-up-model';

const HOUR_MS = 3_600_000;
const POLL_MS = 10_000;
const LEASE_MS = 120_000;
const PAGE_SIZE = 40;
const REVIEW_CONCURRENCY = 4;
const CHAT_HISTORY_SIZE = 30;

type Settings = { prompt: string; intervalHours: number; enabled: boolean };
type ResultStatus = 'skipped' | 'draft' | 'sending' | 'sent' | 'failed';
type ReviewResult = {
  status: ResultStatus;
  reason: string;
  message?: string | null;
};
type Agent = NonNullable<Awaited<ReturnType<FollowUpsService['findAgent']>>>;
type Thread = Prisma.ChatConversationGetPayload<{
  include: { messages: true; followUpResults: true };
}>;
type Job = ChatFollowUp & { token: string; userId: string; manual: boolean };

@Injectable()
export class FollowUpsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FollowUpsService.name);
  private timer?: NodeJS.Timeout;
  private active = false;
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly whatsapp: WhatsAppService,
    private readonly responder: ChatResponderService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.timer);
  }

  private async number(userId: string, phoneNumberId: string) {
    const number = await this.prisma.phoneNumber.findFirst({
      where: { id: phoneNumberId, userId },
      select: { phoneNumber: true, chatAgent: { select: { status: true } } },
    });
    if (!number)
      throw apiError(HttpStatus.NOT_FOUND, 'WhatsApp number not found');
    return number;
  }

  async get(userId: string, phoneNumberId: string, page: number) {
    await this.number(userId, phoneNumberId);
    const config = await this.prisma.chatFollowUp.findUnique({
      where: { phoneNumberId },
    });
    if (!config)
      return {
        config: null,
        results: [],
        total: 0,
        counts: {},
        page_size: PAGE_SIZE,
      };

    const running = Boolean(
      config.leaseUntil && config.leaseUntil.getTime() > Date.now(),
    );
    const runToken = running ? config.leaseToken : config.lastRunToken;
    const where = {
      phoneNumberId,
      runToken: runToken ?? '',
      conversation: { userId, phoneNumberId },
    };
    const [rows, groups] = runToken
      ? await Promise.all([
          this.prisma.chatFollowUpResult.findMany({
            where,
            orderBy: { conversationId: 'asc' },
            skip: (page - 1) * PAGE_SIZE,
            take: PAGE_SIZE,
            include: {
              conversation: { select: { peerName: true, peerPhone: true } },
            },
          }),
          this.prisma.chatFollowUpResult.groupBy({
            by: ['status'],
            where,
            _count: { _all: true },
          }),
        ])
      : [[], []];

    return {
      config: {
        prompt: config.prompt,
        interval_hours: config.intervalHours,
        enabled: config.enabled,
        next_run_at: config.nextRunAt,
        last_run_at: config.lastRunAt,
        last_error: config.lastError,
        running,
        queued: Boolean(config.requestedAt),
      },
      results: rows.map((row) => ({
        conversation_id: row.conversationId,
        peer_name: row.conversation.peerName,
        peer_phone: row.conversation.peerPhone,
        status: row.status,
        reason: row.reason,
        message: row.message,
      })),
      total: groups.reduce((total, group) => total + group._count._all, 0),
      counts: Object.fromEntries(
        groups.map((group) => [group.status, group._count._all]),
      ),
      page_size: PAGE_SIZE,
    };
  }

  async save(userId: string, phoneNumberId: string, settings: Settings) {
    const number = await this.number(userId, phoneNumberId);
    if (!number.phoneNumber)
      throw apiError(HttpStatus.CONFLICT, 'Link this WhatsApp number first');
    if (settings.enabled && number.chatAgent?.status !== 'active') {
      throw apiError(
        HttpStatus.CONFLICT,
        'Activate the chat agent on this number before enabling automatic follow-ups',
      );
    }
    const nextRunAt = settings.enabled
      ? new Date(Date.now() + settings.intervalHours * HOUR_MS)
      : null;
    await this.prisma.chatFollowUp.upsert({
      where: { phoneNumberId },
      create: { phoneNumberId, ...settings, nextRunAt },
      update: {
        ...settings,
        nextRunAt,
        revision: { increment: 1 },
        requestedAt: null,
        lastError: null,
      },
    });
    return this.get(userId, phoneNumberId, 1);
  }

  async requestReview(userId: string, phoneNumberId: string) {
    await this.number(userId, phoneNumberId);
    const config = await this.prisma.chatFollowUp.findUnique({
      where: { phoneNumberId },
    });
    if (!config)
      throw apiError(HttpStatus.CONFLICT, 'Save follow-up instructions first');
    const now = new Date();
    const queued = await this.prisma.chatFollowUp.updateMany({
      where: { phoneNumberId, requestedAt: null, ...this.available(now) },
      data: { requestedAt: now, lastError: null },
    });
    if (queued.count) void this.tick(phoneNumberId);
    return this.get(userId, phoneNumberId, 1);
  }

  private available(now: Date) {
    return { OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] };
  }

  private async tick(requestedNumberId?: string) {
    if (this.active || this.stopping) return;
    this.active = true;
    try {
      const now = new Date();
      const manual = { requestedAt: { not: null } };
      const due = {
        AND: [
          this.available(now),
          requestedNumberId
            ? { ...manual, phoneNumberId: requestedNumberId }
            : { OR: [manual, { enabled: true, nextRunAt: { lte: now } }] },
        ],
        phoneNumber: { user: { blockedAt: null } },
      } satisfies Prisma.ChatFollowUpWhereInput;
      const candidate = await this.prisma.chatFollowUp.findFirst({
        where: due,
        orderBy: [
          { requestedAt: { sort: 'asc', nulls: 'last' } },
          { nextRunAt: 'asc' },
        ],
        include: { phoneNumber: { select: { userId: true } } },
      });
      if (!candidate) return;
      const token = randomUUID();
      const claimed = await this.prisma.chatFollowUp.updateMany({
        where: {
          ...due,
          phoneNumberId: candidate.phoneNumberId,
          revision: candidate.revision,
          requestedAt: candidate.requestedAt,
        },
        data: {
          leaseToken: token,
          leaseUntil: new Date(Date.now() + LEASE_MS),
        },
      });
      if (claimed.count) {
        await this.run({
          ...candidate,
          token,
          userId: candidate.phoneNumber.userId,
          manual: Boolean(candidate.requestedAt),
        });
      }
    } catch (error) {
      this.logger.error(
        'Could not process follow-up queue',
        error instanceof Error ? error.name : undefined,
      );
    } finally {
      this.active = false;
    }
  }

  private scope(job: Job) {
    return {
      phoneNumberId: job.phoneNumberId,
      revision: job.revision,
      leaseToken: job.token,
    };
  }

  private findAgent(userId: string, phoneNumberId: string) {
    return this.prisma.chatAgent.findFirst({
      where: { userId, phoneNumberId },
      select: {
        id: true,
        userId: true,
        agentName: true,
        systemPrompt: true,
        status: true,
        user: { select: { email: true, noReplyLimitUntil: true } },
        phoneNumber: { select: { phoneNumber: true, status: true } },
      },
    });
  }

  private async run(job: Job) {
    let lastError: string | null = null;
    try {
      const agent = await this.findAgent(job.userId, job.phoneNumberId);
      const key = this.config.get<string>('ANTHROPIC_API_KEY');
      if (!key) throw new ReviewError('The AI review provider is unavailable');
      if (!job.manual && agent?.status !== 'active')
        throw new ReviewError('The chat agent on this number is inactive');
      if (!job.manual && agent?.phoneNumber?.status !== 'connected')
        throw new ReviewError(
          'Reconnect the WhatsApp number to send follow-ups',
        );

      const review = createFollowUpReviewer(
        key,
        agent?.systemPrompt ?? '',
        job.prompt,
      );
      let cursor: string | undefined;
      while (!this.stopping) {
        const threads: Thread[] = await this.prisma.chatConversation.findMany({
          where: {
            userId: job.userId,
            phoneNumberId: job.phoneNumberId,
            id: cursor ? { gt: cursor } : undefined,
          },
          orderBy: { id: 'asc' },
          take: PAGE_SIZE,
          include: {
            messages: { orderBy: { seq: 'desc' }, take: CHAT_HISTORY_SIZE },
            followUpResults: { where: { phoneNumberId: job.phoneNumberId } },
          },
        });
        if (!threads.length) break;
        for (
          let offset = 0;
          offset < threads.length;
          offset += REVIEW_CONCURRENCY
        ) {
          if (this.stopping) return;
          const lease = await this.prisma.chatFollowUp.updateMany({
            where: {
              ...this.scope(job),
              leaseUntil: { gt: new Date() },
              phoneNumber: { user: { blockedAt: null } },
            },
            data: { leaseUntil: new Date(Date.now() + LEASE_MS) },
          });
          if (!lease.count) return;
          const batch = threads.slice(offset, offset + REVIEW_CONCURRENCY);
          await Promise.all(
            batch.map((thread) =>
              this.reviewThread(job, thread, review, agent),
            ),
          );
        }
        cursor = threads[threads.length - 1].id;
      }
    } catch (error) {
      lastError =
        error instanceof ReviewError
          ? error.message
          : 'Review could not finish. Run another review to retry.';
      if (!(error instanceof ReviewError))
        this.logger.error(
          'Follow-up review failed',
          error instanceof Error ? error.name : undefined,
        );
    } finally {
      const now = new Date();
      if (!this.stopping) {
        await this.prisma.chatFollowUp.updateMany({
          where: this.scope(job),
          data: {
            leaseToken: null,
            leaseUntil: null,
            requestedAt: job.manual ? null : undefined,
            nextRunAt: job.manual
              ? undefined
              : new Date(now.getTime() + job.intervalHours * HOUR_MS),
            lastRunToken: job.token,
            lastRunAt: now,
            lastError,
          },
        });
      }
      // Editing the settings invalidates the run but leaves its lease in place until it stops.
      await this.prisma.chatFollowUp.updateMany({
        where: { phoneNumberId: job.phoneNumberId, leaseToken: job.token },
        data: { leaseToken: null, leaseUntil: null },
      });
    }
  }

  private async store(job: Job, thread: Thread, result: ReviewResult) {
    const key = { phoneNumberId: job.phoneNumberId, conversationId: thread.id };
    const data = {
      ...result,
      runToken: job.token,
      message: result.message ?? null,
      checkedAt: new Date(),
    };
    await this.prisma.chatFollowUpResult.upsert({
      where: { phoneNumberId_conversationId: key },
      create: { ...key, ...data },
      update: data,
    });
  }

  private async reviewThread(
    job: Job,
    thread: Thread,
    review: ReturnType<typeof createFollowUpReviewer>,
    agent: Agent | null,
  ) {
    const reason = this.skipReason(thread);
    if (reason) return this.store(job, thread, { status: 'skipped', reason });

    const inbound =
      thread.messages.find((message) => message.role === 'user') ??
      (await this.prisma.chatMessage.findFirst({
        where: { conversationId: thread.id, role: 'user' },
        orderBy: { seq: 'desc' },
      }));
    if (!inbound)
      return this.store(job, thread, {
        status: 'skipped',
        reason: 'This conversation has no customer message.',
      });
    if ((thread.followUpResults[0]?.attemptedUserSeq ?? -1) >= inbound.seq) {
      return this.store(job, thread, {
        status: 'skipped',
        reason:
          'A follow-up was already attempted since the last customer message.',
      });
    }

    let decision: Awaited<ReturnType<typeof review>>;
    try {
      decision = await review(new Date(), thread.messages.toReversed());
    } catch {
      return this.store(job, thread, {
        status: 'failed',
        reason: 'The AI could not review this conversation.',
      });
    }
    if (!decision.message || job.manual || !agent) {
      return this.store(job, thread, {
        ...decision,
        status: decision.message ? 'draft' : 'skipped',
      });
    }
    await this.store(job, thread, { ...decision, status: 'draft' });
    return this.deliver(job, thread, inbound.seq, agent, {
      reason: decision.reason,
      message: decision.message,
    });
  }

  private skipReason(thread: Thread) {
    if (!/@(?:s\.whatsapp\.net|lid)$/.test(thread.peerJid))
      return 'Follow-ups are available for direct chats.';
    if (thread.status !== 'open') return 'This conversation is closed.';
    if (!thread.aiReplyEnabled || thread.needsAttention)
      return 'AI replies are paused for this conversation.';
    return null;
  }

  private async deliver(
    job: Job,
    thread: Thread,
    inboundSeq: number,
    agent: Agent,
    decision: { reason: string; message: string },
  ) {
    const where = {
      phoneNumberId: job.phoneNumberId,
      conversationId: thread.id,
      runToken: job.token,
    };
    let reserved = false;
    let outcome: Awaited<
      ReturnType<ChatResponderService['sendWithFollowUpQuota']>
    >;
    try {
      outcome = await this.responder.sendWithFollowUpQuota(agent, async () => {
        if (
          this.stopping ||
          this.responder.hasPendingReply(job.phoneNumberId, thread.peerJid)
        )
          return false;
        const claim = await this.prisma.chatFollowUpResult.updateMany({
          where: {
            ...where,
            OR: [
              { attemptedUserSeq: null },
              { attemptedUserSeq: { lt: inboundSeq } },
            ],
            followUp: {
              ...this.scope(job),
              enabled: true,
              leaseUntil: { gt: new Date() },
              phoneNumber: {
                userId: job.userId,
                status: 'connected',
                user: { blockedAt: null },
                chatAgent: { id: agent.id, status: 'active' },
              },
            },
            conversation: {
              userId: job.userId,
              phoneNumberId: job.phoneNumberId,
              status: 'open',
              aiReplyEnabled: true,
              needsAttention: false,
              messageCount: thread.messageCount,
              lastMessageAt: thread.lastMessageAt,
              messages: { none: { seq: { gt: thread.messages[0].seq } } },
            },
          },
          data: { attemptedUserSeq: inboundSeq, status: 'sending' },
        });
        reserved = Boolean(claim.count);
        if (!reserved) return false;
        if (
          this.stopping ||
          this.responder.hasPendingReply(job.phoneNumberId, thread.peerJid)
        ) {
          await this.prisma.chatFollowUpResult.updateMany({
            where,
            data: {
              attemptedUserSeq:
                thread.followUpResults[0]?.attemptedUserSeq ?? null,
            },
          });
          return false;
        }
        await this.whatsapp.sendText(
          job.userId,
          job.phoneNumberId,
          thread.peerJid,
          decision.message,
        );
        return true;
      });
    } catch (error) {
      const disconnected = error instanceof NumberNotConnectedError;
      await this.prisma.chatFollowUpResult.updateMany({
        where,
        data: {
          status: 'failed',
          reason: disconnected
            ? 'Reconnect the WhatsApp number to send this follow-up.'
            : 'WhatsApp delivery could not be confirmed.',
          attemptedUserSeq:
            disconnected && reserved
              ? (thread.followUpResults[0]?.attemptedUserSeq ?? null)
              : undefined,
        },
      });
      return;
    }

    if (outcome !== 'sent') {
      return this.store(job, thread, {
        status: 'skipped',
        reason:
          outcome === 'limited'
            ? 'The chat agent has reached its reply limit.'
            : 'The conversation or follow-up settings changed before sending.',
      });
    }

    await appendMessage(
      this.prisma,
      thread.id,
      'assistant',
      decision.message,
      undefined,
      agent.id,
    ).catch(() => {
      this.logger.error(
        `Could not record sent follow-up on conversation ${thread.id}`,
      );
    });
    await this.prisma.chatFollowUpResult.updateMany({
      where,
      data: { status: 'sent' },
    });
  }
}

class ReviewError extends Error {}
