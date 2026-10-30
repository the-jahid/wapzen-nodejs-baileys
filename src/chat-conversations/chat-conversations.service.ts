import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { apiError } from '../chat-agents/chat-agents.types';
import { PrismaService } from '../prisma/prisma.service';
import { ChatResponderService } from '../whatsapp/chat-responder.service';
import {
  NumberNotConnectedError,
  WhatsAppService,
} from '../whatsapp/whatsapp.service';
import { appendMessage, resolvePeerPhones } from './chat-conversations.store';
import {
  ConversationFilter,
  toMessageResource,
  toResource,
} from './chat-conversations.types';

// The saved WhatsApp threads of the Go server's internal/chatconversations:
// the reply path writes them, this reads them, closes or deletes one, and
// sends a message on one from the dashboard. Every query is scoped to the
// signed-in user, so somebody else's id simply isn't found.
@Injectable()
export class ChatConversationsService {
  private readonly logger = new Logger(ChatConversationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsAppService,
    private readonly responder: ChatResponderService,
  ) {}

  // One page of the user's threads, most recently active first. A thread
  // that was never written to sorts last.
  async list(
    userId: string,
    filter: ConversationFilter,
    page: number,
    limit: number,
  ) {
    const where = whereFor(userId, filter);
    const [total, rows] = await Promise.all([
      this.prisma.chatConversation.count({ where }),
      this.prisma.chatConversation.findMany({
        where,
        orderBy: [
          { lastMessageAt: { sort: 'desc', nulls: 'last' } },
          { createdAt: 'desc' },
          { id: 'desc' },
        ],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    const resolved = await resolvePeerPhones(this.prisma, rows);
    return { total, conversations: resolved.map((row) => toResource(row)) };
  }

  // One thread with its whole transcript.
  async get(userId: string, id: string) {
    const row = await this.prisma.chatConversation.findFirst({
      where: { id, userId },
      include: { messages: { orderBy: { seq: 'asc' } } },
    });
    if (!row) throw notFound();
    const [resolved] = await resolvePeerPhones(this.prisma, [row]);
    return toResource(resolved, row.messages);
  }

  // Closing is bookkeeping for whoever reads the inbox; it doesn't stop the
  // agent answering (pausing the agent does that).
  async updateStatus(userId: string, id: string, status: string) {
    const { count } = await this.prisma.chatConversation.updateMany({
      where: { id, userId },
      data: { status, updatedAt: new Date() },
    });
    if (count === 0) throw notFound();
    const row = await this.prisma.chatConversation.findUniqueOrThrow({
      where: { id },
    });
    const [resolved] = await resolvePeerPhones(this.prisma, [row]);
    return toResource(resolved);
  }

  async remove(userId: string, id: string) {
    const { count } = await this.prisma.chatConversation.deleteMany({
      where: { id, userId },
    });
    if (count === 0) throw notFound();
  }

  // A person taking over from the agent. The message goes out on the
  // thread's number to the JID the contact wrote from, and is saved with the
  // 'assistant' role: to the contact it's the same party speaking.
  async send(userId: string, id: string, content: string) {
    const conversation = await this.prisma.chatConversation.findFirst({
      where: { id, userId },
    });
    if (!conversation) throw notFound();
    // The number was removed: the history stays, but nothing can send.
    if (!conversation.phoneNumberId) {
      throw apiError(
        HttpStatus.CONFLICT,
        "this conversation's phone number is no longer connected to the account",
      );
    }

    try {
      await this.whatsapp.sendText(
        userId,
        conversation.phoneNumberId,
        conversation.peerJid,
        content,
      );
    } catch (err) {
      if (err instanceof NumberNotConnectedError) {
        throw apiError(
          HttpStatus.CONFLICT,
          'phone number is not connected; reconnect it to send messages',
        );
      }
      this.logger.error(
        `sending on conversation ${id} failed: ${(err as Error).message}`,
      );
      throw apiError(HttpStatus.BAD_GATEWAY, 'WhatsApp refused the message');
    }

    if (conversation.chatAgentId) {
      this.responder.rememberSent(
        conversation.chatAgentId,
        conversation.phoneNumberId,
        conversation.peerJid,
        content,
      );
    }

    // It was sent, which is what matters to the contact; failing to save the
    // copy is logged, not reported as a failed send.
    try {
      return toMessageResource(
        await appendMessage(this.prisma, id, 'assistant', content),
      );
    } catch (err) {
      this.logger.error(
        `saving the sent message on ${id} failed: ${(err as Error).message}`,
      );
      return toMessageResource({
        seq: conversation.messageCount,
        role: 'assistant',
        content,
        createdAt: new Date(),
      });
    }
  }
}

function whereFor(
  userId: string,
  filter: ConversationFilter,
): Prisma.ChatConversationWhereInput {
  const where: Prisma.ChatConversationWhereInput = { userId };
  if (filter.chatAgentId) where.chatAgentId = filter.chatAgentId;
  if (filter.phoneNumberId) where.phoneNumberId = filter.phoneNumberId;
  if (filter.status) where.status = filter.status;
  // The contact is searched by whichever of these the person typing knows.
  if (filter.search) {
    const contains = { contains: filter.search, mode: 'insensitive' as const };
    where.OR = [
      { peerJid: contains },
      { peerPhone: contains },
      { peerName: contains },
    ];
  }
  return where;
}

function notFound() {
  return apiError(HttpStatus.NOT_FOUND, 'conversation not found');
}
