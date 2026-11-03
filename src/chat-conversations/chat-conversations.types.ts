import { HttpException, HttpStatus } from '@nestjs/common';
import type { ChatConversation, ChatMessage } from '../generated/prisma/client';
import { apiError } from '../chat-agents/chat-agents.types';

// Wire types and validation for /v1/chat-conversations, ported from the Go
// server's chat_conversation_handler.go and models/chat_conversation.go.

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
// A dashboard-sent message longer than this is a paste accident, not a reply.
export const MAX_MESSAGE_LENGTH = 4096;
export const STATUSES = ['open', 'closed'];

export type ConversationFilter = {
  chatAgentId?: string;
  phoneNumberId?: string;
  status?: string;
  // Matches the contact's JID, phone or name, ignoring case.
  search?: string;
  // true: only the ones waiting for a person (the dashboard's red count).
  needsAttention?: boolean;
};

// One saved message as the API returns it (ChatConversationMessage).
export type ChatMessageResource = {
  seq: number;
  role: string;
  content: string;
  created_at: string;
};

// One thread as the API returns it (ChatConversation). messages is only
// filled in by Get.
export type ChatConversationResource = {
  id: string;
  phone_number_id: string | null;
  chat_agent_id: string | null;
  peer_jid: string;
  peer_phone: string | null;
  peer_name: string | null;
  status: string;
  ai_reply_enabled: boolean;
  needs_attention: boolean;
  message_count: number;
  last_message_role: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
  messages?: ChatMessageResource[];
};

// The PATCH body once checked: whichever fields were sent.
export type ConversationUpdate = {
  status?: string;
  aiReplyEnabled?: boolean;
  needsAttention?: boolean;
};

export function toResource(
  row: ChatConversation,
  messages?: ChatMessage[],
): ChatConversationResource {
  return {
    id: row.id,
    phone_number_id: row.phoneNumberId,
    chat_agent_id: row.chatAgentId,
    peer_jid: row.peerJid,
    peer_phone: row.peerPhone,
    peer_name: row.peerName,
    status: row.status,
    ai_reply_enabled: row.aiReplyEnabled,
    needs_attention: row.needsAttention,
    message_count: row.messageCount,
    last_message_role: row.lastMessageRole,
    last_message_at: row.lastMessageAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    ...(messages ? { messages: messages.map(toMessageResource) } : {}),
  };
}

export function toMessageResource(row: {
  seq: number;
  role: string;
  content: string;
  createdAt: Date;
}): ChatMessageResource {
  return {
    seq: row.seq,
    role: row.role,
    content: row.content,
    created_at: row.createdAt.toISOString(),
  };
}

type FieldError = { field: string; message: string };

// Validates paging and filters in one pass, so a request with two bad
// parameters hears about both (400 with errors[], like Go).
export function parseListQuery(q: Record<string, string | undefined>) {
  let page = 1;
  let limit = DEFAULT_LIMIT;
  const filter: ConversationFilter = {};
  const errors: FieldError[] = [];

  const rawPage = q.page?.trim();
  if (rawPage) {
    const value = Number(rawPage);
    if (Number.isInteger(value) && value >= 1) page = value;
    else
      errors.push({
        field: 'page',
        message: 'page must be an integer greater than or equal to 1',
      });
  }
  const rawLimit = q.limit?.trim();
  if (rawLimit) {
    const value = Number(rawLimit);
    if (Number.isInteger(value) && value >= 1 && value <= MAX_LIMIT)
      limit = value;
    else
      errors.push({
        field: 'limit',
        message: `limit must be an integer between 1 and ${MAX_LIMIT}`,
      });
  }
  const status = q.status?.trim();
  if (status) {
    if (STATUSES.includes(status)) filter.status = status;
    else
      errors.push({
        field: 'status',
        message: 'status must be one of open, closed',
      });
  }
  filter.chatAgentId = q.chat_agent_id?.trim() || undefined;
  filter.phoneNumberId = q.phone_number_id?.trim() || undefined;
  filter.search = q.search?.trim() || undefined;
  const attention = q.needs_attention?.trim();
  if (attention) {
    if (attention === 'true' || attention === 'false')
      filter.needsAttention = attention === 'true';
    else
      errors.push({
        field: 'needs_attention',
        message: 'needs_attention must be true or false',
      });
  }

  if (errors.length > 0) {
    throw new HttpException(
      { success: false, message: 'Invalid query parameters', errors },
      HttpStatus.BAD_REQUEST,
    );
  }
  return { page, limit, filter };
}

const UPDATE_FIELDS = ['status', 'ai_reply_enabled', 'needs_attention'];

// The PATCH body: status, the AI switch and the red "needs a person" flag
// (false = marked done) may change, at least one of them; the messages are
// what happened.
export function parseUpdate(body: unknown): ConversationUpdate {
  const fields = asObject(body);
  const unknown = Object.keys(fields).find(
    (key) => !UPDATE_FIELDS.includes(key),
  );
  if (unknown) {
    throw apiError(
      HttpStatus.BAD_REQUEST,
      `Invalid request body: json: unknown field "${unknown}"`,
    );
  }
  const update: ConversationUpdate = {};
  if (fields.status !== undefined && fields.status !== null) {
    const status =
      typeof fields.status === 'string' ? fields.status.trim() : undefined;
    if (!status || !STATUSES.includes(status)) {
      throw apiError(
        HttpStatus.BAD_REQUEST,
        'status must be one of open, closed',
      );
    }
    update.status = status;
  }
  update.aiReplyEnabled = optionalBoolean(fields, 'ai_reply_enabled');
  update.needsAttention = optionalBoolean(fields, 'needs_attention');
  if (Object.values(update).every((value) => value === undefined)) {
    throw apiError(
      HttpStatus.BAD_REQUEST,
      'status, ai_reply_enabled or needs_attention is required',
    );
  }
  return update;
}

function optionalBoolean(fields: Record<string, unknown>, key: string) {
  const value = fields[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw apiError(HttpStatus.BAD_REQUEST, `${key} must be true or false`);
  }
  return value;
}

// The send-message body: { content }, 1–4096 characters once trimmed.
export function parseSend(body: unknown): string {
  const fields = asObject(body);
  const unknown = Object.keys(fields).find((key) => key !== 'content');
  if (unknown) {
    throw apiError(
      HttpStatus.BAD_REQUEST,
      `Invalid request body: json: unknown field "${unknown}"`,
    );
  }
  if (fields.content !== undefined && typeof fields.content !== 'string') {
    throw apiError(
      HttpStatus.BAD_REQUEST,
      'Invalid request body: content must be a string',
    );
  }
  const content = (fields.content ?? '').trim();
  if (!content) throw apiError(HttpStatus.BAD_REQUEST, 'content is required');
  if (content.length > MAX_MESSAGE_LENGTH) {
    throw apiError(
      HttpStatus.BAD_REQUEST,
      `content must be at most ${MAX_MESSAGE_LENGTH} characters`,
    );
  }
  return content;
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw apiError(
      HttpStatus.BAD_REQUEST,
      'Invalid request body: expected a JSON object',
    );
  }
  return body as Record<string, unknown>;
}
