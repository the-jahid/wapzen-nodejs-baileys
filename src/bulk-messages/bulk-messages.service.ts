import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  conflict,
  notFound,
  toCampaignResource,
  toRecipientResource,
  type NewCampaign,
} from './bulk-messages.types';

const withNumber = {
  phoneNumber: { select: { phoneNumber: true, status: true } },
} satisfies Prisma.BulkCampaignInclude;

// The longest list the dashboard shows; older sends drop off the end.
const MAX_LISTED = 200;

// Bulk sends belong to one account: every query is scoped to the signed-in
// user, so somebody else's id simply isn't found. The sending itself is
// BulkSenderService's; this only creates sends and moves them between states.
@Injectable()
export class BulkMessagesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string) {
    const rows = await this.prisma.bulkCampaign.findMany({
      where: { userId },
      include: withNumber,
      orderBy: { createdAt: 'desc' },
      take: MAX_LISTED,
    });
    return rows.map(toCampaignResource);
  }

  async get(userId: string, id: string) {
    const row = await this.prisma.bulkCampaign.findFirst({
      where: { id, userId },
      include: withNumber,
    });
    if (!row) throw notFound();
    return toCampaignResource(row);
  }

  async recipients(
    userId: string,
    id: string,
    page: number,
    limit: number,
    status?: string,
  ) {
    const owned = await this.prisma.bulkCampaign.count({
      where: { id, userId },
    });
    if (!owned) throw notFound();
    const where = { campaignId: id, ...(status ? { status } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.bulkRecipient.findMany({
        where,
        orderBy: { position: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.bulkRecipient.count({ where }),
    ]);
    return { recipients: rows.map(toRecipientResource), total };
  }

  // Starts sending straight away: the first message goes out on the sender's
  // next tick, the rest interval_seconds apart.
  async create(userId: string, input: NewCampaign) {
    const number = await this.prisma.phoneNumber.findFirst({
      where: { id: input.phoneNumberId, userId, phoneNumber: { not: null } },
      select: { id: true },
    });
    if (!number) throw notFound('phone number');
    await this.ensureNumberFree(input.phoneNumberId);

    try {
      const id = await this.prisma.$transaction(async (tx) => {
        const campaign = await tx.bulkCampaign.create({
          data: {
            userId,
            phoneNumberId: input.phoneNumberId,
            name: input.name,
            message: input.message,
            intervalSeconds: input.intervalSeconds,
            totalCount: input.recipients.length,
          },
          select: { id: true },
        });
        await tx.bulkRecipient.createMany({
          data: input.recipients.map((recipient, position) => ({
            campaignId: campaign.id,
            position,
            phone: recipient.phone,
            variables: recipient.variables,
          })),
        });
        return campaign.id;
      });
      return this.get(userId, id);
    } catch (err) {
      throw this.numberBusy(err) ?? err;
    }
  }

  async pause(userId: string, id: string) {
    const { count } = await this.prisma.bulkCampaign.updateMany({
      where: { id, userId, status: 'running' },
      data: { status: 'paused' },
    });
    if (!count)
      await this.refuse(userId, id, 'only a running send can be paused');
    return this.get(userId, id);
  }

  async resume(userId: string, id: string) {
    const row = await this.prisma.bulkCampaign.findFirst({
      where: { id, userId },
      select: { status: true, phoneNumberId: true },
    });
    if (!row) throw notFound();
    if (row.status !== 'paused')
      throw conflict('only a paused send can be resumed');
    if (!row.phoneNumberId) {
      throw conflict(
        'the number this send used was removed; start a new send from another number',
      );
    }
    await this.ensureNumberFree(row.phoneNumberId);
    try {
      await this.prisma.bulkCampaign.updateMany({
        where: { id, userId, status: 'paused' },
        data: { status: 'running', nextSendAt: new Date(), lastError: null },
      });
    } catch (err) {
      throw this.numberBusy(err) ?? err;
    }
    return this.get(userId, id);
  }

  // Stops for good. The numbers not yet reached are marked skipped, so the
  // send's counts still add up.
  async cancel(userId: string, id: string) {
    const { count } = await this.prisma.bulkCampaign.updateMany({
      where: { id, userId, status: { in: ['running', 'paused'] } },
      data: { status: 'cancelled', completedAt: new Date() },
    });
    if (!count) await this.refuse(userId, id, 'this send has already finished');
    await this.prisma.bulkRecipient.updateMany({
      where: { campaignId: id, status: 'pending' },
      data: { status: 'skipped' },
    });
    return this.get(userId, id);
  }

  // Deleting a running send stops it: the sender finds no row to claim.
  async remove(userId: string, id: string) {
    const { count } = await this.prisma.bulkCampaign.deleteMany({
      where: { id, userId },
    });
    if (!count) throw notFound();
  }

  private async ensureNumberFree(phoneNumberId: string) {
    const running = await this.prisma.bulkCampaign.findFirst({
      where: { phoneNumberId, status: 'running' },
      select: { name: true },
    });
    if (running) {
      throw conflict(
        `this number is already sending "${running.name}"; pause it or wait for it to finish`,
      );
    }
  }

  // The partial unique index catches two sends started on one number at the
  // same moment, which the check above can't.
  private numberBusy(err: unknown) {
    return err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
      ? conflict('this number is already sending another bulk message')
      : null;
  }

  private async refuse(
    userId: string,
    id: string,
    message: string,
  ): Promise<never> {
    const exists = await this.prisma.bulkCampaign.count({
      where: { id, userId },
    });
    throw exists ? conflict(message) : notFound();
  }
}
