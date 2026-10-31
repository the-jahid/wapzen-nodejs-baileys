import { Injectable, Logger } from '@nestjs/common';
import { activity } from '../activity/activity';
import { ensureConversation } from '../chat-conversations/chat-conversations.store';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { FieldError } from '../tools/tools.types';
import { DEFAULT_ORDER_FIELDS, type OrderField } from './order-tool';
import {
  fingerprint,
  MAX_EXPORT_ROWS,
  notFound,
  orderNumberIn,
  ordersCsv,
  parseOrderArgs,
  toResource,
  type NewOrder,
  type OrderCustomField,
  type OrderFilter,
  type OrderItem,
  type OrderUpdate,
} from './orders.types';

// The same order arriving twice from a conversation within this long is one
// order: a redelivered message or a model repeating its call.
const DUPLICATE_WINDOW_MS = 2 * 60_000;

const withAgent = {
  agent: { select: { agentName: true } },
} satisfies Prisma.OrderInclude;

// Who an order is being placed for, known to the reply path and not the model.
export type OrderContext = {
  userId: string;
  ownerEmail: string;
  agentId: string;
  agentName: string;
  phoneNumberId: string;
  peerJid: string;
  // The sender's number (E.164), when WhatsApp gave one.
  customerPhone?: string;
  peerName?: string;
  // The number the agent answers on, for the country code of a local number.
  agentPhone?: string | null;
};

// What create_order hands back to the model.
export type OrderResult =
  | { success: true; order_id: string; order_number: number }
  | { success: false; error: string; errors?: FieldError[] };

// Orders belong to one account: every query is scoped to the signed-in user, so
// somebody else's id simply isn't found.
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Places the order an agent's create_order call describes. It never throws:
  // a problem comes back as text the agent can act on.
  async place(
    context: OrderContext,
    args: Record<string, unknown>,
    fields: OrderField[] = DEFAULT_ORDER_FIELDS,
  ): Promise<OrderResult> {
    const { order, errors } = parseOrderArgs(args, context, fields);
    if (!order) {
      return {
        success: false,
        error: `The order was not placed. ${errors.map((e) => e.message).join('; ')}.`,
        errors,
      };
    }
    try {
      // On a customer's first message the thread isn't saved until after the
      // reply, so it may not exist yet.
      const conversationId = await ensureConversation(this.prisma, {
        userId: context.userId,
        phoneNumberId: context.phoneNumberId,
        chatAgentId: context.agentId,
        peerJid: context.peerJid,
        peerPhone: context.customerPhone,
        peerName: context.peerName,
      });
      const { id, orderNumber, created } = await this.store(
        context,
        conversationId,
        order,
      );
      if (created) {
        activity(
          `order placed: ${context.ownerEmail} - #${orderNumber} by ${context.agentName}`,
        );
      }
      return { success: true, order_id: id, order_number: orderNumber };
    } catch (err) {
      this.logger.error(
        `chat agent ${context.agentId} order failed: ${(err as Error).message}`,
      );
      return {
        success: false,
        error:
          "The order could not be saved. Tell them it wasn't placed and to try again shortly.",
      };
    }
  }

  // The user row is locked first, so two calls at once can't both find no
  // duplicate, and order numbers can't race.
  private store(
    context: OrderContext,
    conversationId: string,
    order: NewOrder,
  ) {
    const { userId, agentId } = context;
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${userId} FOR UPDATE`;

      const recent = await tx.order.findMany({
        where: {
          userId,
          conversationId,
          status: { not: 'cancelled' },
          createdAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
        },
      });
      const same = recent.find(
        (row) =>
          fingerprint({
            ...row,
            items: row.items as OrderItem[],
            customFields: row.customFields as OrderCustomField[],
          }) === fingerprint(order),
      );
      if (same) {
        return { id: same.id, orderNumber: same.orderNumber, created: false };
      }

      const { lastOrderNumber } = await tx.user.update({
        where: { id: userId },
        data: { lastOrderNumber: { increment: 1 } },
        select: { lastOrderNumber: true },
      });
      const row = await tx.order.create({
        data: {
          ...order,
          userId,
          agentId,
          conversationId,
          orderNumber: lastOrderNumber,
          channel: 'chat',
        },
      });
      return { id: row.id, orderNumber: row.orderNumber, created: true };
    });
  }

  // One page, newest first. newOrders counts the account's new orders whatever
  // the filter, for the badge on the tab.
  async list(userId: string, filter: OrderFilter, page: number, limit: number) {
    const where = whereFor(userId, filter);
    const [total, newOrders, rows] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.count({ where: { userId, status: 'new' } }),
      this.prisma.order.findMany({
        where,
        include: withAgent,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return { total, newOrders, orders: rows.map(toResource) };
  }

  async get(userId: string, id: string) {
    const row = await this.prisma.order.findFirst({
      where: { id, userId },
      include: withAgent,
    });
    if (!row) throw notFound();
    return toResource(row);
  }

  async update(userId: string, id: string, update: OrderUpdate) {
    const { count } = await this.prisma.order.updateMany({
      where: { id, userId },
      data: { ...update, updatedAt: new Date() },
    });
    if (count === 0) throw notFound();
    return this.get(userId, id);
  }

  async remove(userId: string, id: string) {
    const { count } = await this.prisma.order.deleteMany({
      where: { id, userId },
    });
    if (count === 0) throw notFound();
  }

  async exportCsv(userId: string, filter: OrderFilter) {
    const rows = await this.prisma.order.findMany({
      where: whereFor(userId, filter),
      include: withAgent,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_EXPORT_ROWS,
    });
    return ordersCsv(rows.map(toResource));
  }
}

function whereFor(userId: string, filter: OrderFilter): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = { userId };
  if (filter.status) where.status = filter.status;
  if (filter.agentId) where.agentId = filter.agentId;
  if (filter.from || filter.to) {
    where.createdAt = { gte: filter.from, lte: filter.to };
  }
  if (filter.search) {
    const contains = { contains: filter.search, mode: 'insensitive' as const };
    const orderNumber = orderNumberIn(filter.search);
    where.OR = [
      { customerName: contains },
      { phone: contains },
      { email: contains },
      ...(orderNumber !== null ? [{ orderNumber }] : []),
    ];
  }
  return where;
}
