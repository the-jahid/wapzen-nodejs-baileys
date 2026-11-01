import { HttpStatus } from '@nestjs/common';
import type {
  BulkCampaign,
  BulkRecipient,
  MessageTemplate,
} from '../generated/prisma/client';
import {
  apiError,
  requireObject,
  validationFailed,
  type FieldError,
} from '../tools/tools.types';

// Wire types and validation for /v1/bulk-messages and /v1/message-templates.
// The dashboard reads the uploaded spreadsheet itself and sends the rows as
// JSON, so the server only ever sees phone numbers and column values.

export const CAMPAIGN_STATUSES = [
  'running',
  'paused',
  'completed',
  'cancelled',
] as const;
export const RECIPIENT_STATUSES = [
  'pending',
  'sending',
  'sent',
  'failed',
  'skipped',
] as const;

export const DEFAULT_INTERVAL_SECONDS = 30;
// Mirrors bulk_campaigns_interval_check. Faster than one message every ten
// seconds from one number is what gets numbers banned.
export const MIN_INTERVAL_SECONDS = 10;
export const MAX_INTERVAL_SECONDS = 3600;
export const MAX_RECIPIENTS = 5000;
export const DEFAULT_RECIPIENT_PAGE = 50;
export const MAX_RECIPIENT_PAGE = 200;

const MAX_NAME_LENGTH = 120;
// WhatsApp's own limit on a text message.
const MAX_MESSAGE_LENGTH = 4096;
const MAX_VARIABLES = 30;
const MAX_VARIABLE_KEY_LENGTH = 60;
const MAX_VARIABLE_VALUE_LENGTH = 1000;
const E164 = /^\+[1-9]\d{6,14}$/;
const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;

export type NewRecipient = { phone: string; variables: Record<string, string> };

export type NewCampaign = {
  name: string;
  phoneNumberId: string;
  message: string;
  intervalSeconds: number;
  recipients: NewRecipient[];
  // Numbers dropped because they were already on the list.
  duplicates: number;
};

export type TemplateInput = { name?: string; body?: string };

export function notFound(what = 'bulk message') {
  return apiError(HttpStatus.NOT_FOUND, `${what} not found`);
}

export function conflict(message: string) {
  return apiError(HttpStatus.CONFLICT, message);
}

// Fills {{column}} placeholders from a recipient's row. Keys match without
// regard to case or spacing; {{phone}} is always the number. A column the row
// doesn't have becomes empty rather than leaving braces in the message.
export function renderMessage(
  template: string,
  phone: string,
  variables: Record<string, string>,
) {
  return template
    .replace(PLACEHOLDER, (_match, key: string) => {
      const name = variableKey(key);
      if (name === 'phone' && !variables.phone) return phone;
      return variables[name] ?? '';
    })
    .trim();
}

export function variableKey(header: string) {
  return header.trim().toLowerCase().replace(/\s+/g, ' ');
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseCampaign(body: unknown): NewCampaign {
  const input = requireObject(body);
  const errors: FieldError[] = [];

  const name = text(input.name);
  if (!name) errors.push({ field: 'name', message: 'name is required' });
  else if (name.length > MAX_NAME_LENGTH)
    errors.push({
      field: 'name',
      message: `name must be at most ${MAX_NAME_LENGTH} characters`,
    });

  const phoneNumberId = text(input.phone_number_id);
  if (!phoneNumberId)
    errors.push({
      field: 'phone_number_id',
      message: 'choose the number to send from',
    });

  const message = text(input.message);
  if (!message)
    errors.push({ field: 'message', message: 'message is required' });
  else if (message.length > MAX_MESSAGE_LENGTH)
    errors.push({
      field: 'message',
      message: `message must be at most ${MAX_MESSAGE_LENGTH} characters`,
    });

  let intervalSeconds = DEFAULT_INTERVAL_SECONDS;
  if (input.interval_seconds !== undefined && input.interval_seconds !== null) {
    const value = input.interval_seconds;
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < MIN_INTERVAL_SECONDS ||
      value > MAX_INTERVAL_SECONDS
    ) {
      errors.push({
        field: 'interval_seconds',
        message: `interval_seconds must be a whole number from ${MIN_INTERVAL_SECONDS} to ${MAX_INTERVAL_SECONDS}`,
      });
    } else intervalSeconds = value;
  }

  const recipients: NewRecipient[] = [];
  let duplicates = 0;
  if (!Array.isArray(input.recipients) || input.recipients.length === 0) {
    errors.push({
      field: 'recipients',
      message: 'add at least one phone number',
    });
  } else if (input.recipients.length > MAX_RECIPIENTS) {
    errors.push({
      field: 'recipients',
      message: `one send can reach at most ${MAX_RECIPIENTS} numbers`,
    });
  } else {
    const seen = new Set<string>();
    input.recipients.forEach((raw: unknown, index: number) => {
      const field = `recipients[${index}]`;
      const row =
        typeof raw === 'object' && raw !== null
          ? (raw as Record<string, unknown>)
          : {};
      const phone = text(row.phone).replace(/[\s().-]/g, '');
      if (!E164.test(phone)) {
        errors.push({
          field: `${field}.phone`,
          message: `"${text(row.phone)}" is not a phone number with its country code`,
        });
        return;
      }
      if (seen.has(phone)) {
        duplicates++;
        return;
      }
      seen.add(phone);
      const variables: Record<string, string> = {};
      const given = row.variables;
      if (given !== undefined && given !== null) {
        if (typeof given !== 'object' || Array.isArray(given)) {
          errors.push({
            field: `${field}.variables`,
            message: 'variables must be an object',
          });
          return;
        }
        const entries = Object.entries(given as Record<string, unknown>);
        if (entries.length > MAX_VARIABLES) {
          errors.push({
            field: `${field}.variables`,
            message: `at most ${MAX_VARIABLES} columns`,
          });
          return;
        }
        for (const [key, value] of entries) {
          const name = variableKey(key).slice(0, MAX_VARIABLE_KEY_LENGTH);
          if (!name) continue;
          variables[name] = (
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean'
              ? String(value)
              : ''
          )
            .trim()
            .slice(0, MAX_VARIABLE_VALUE_LENGTH);
        }
      }
      recipients.push({ phone, variables });
    });
  }

  // A long file with one bad column would otherwise list thousands of errors.
  if (errors.length) throw validationFailed(errors.slice(0, 20));
  return {
    name,
    phoneNumberId,
    message,
    intervalSeconds,
    recipients,
    duplicates,
  };
}

export function parseTemplate(body: unknown, partial: boolean): TemplateInput {
  const input = requireObject(body);
  const errors: FieldError[] = [];
  const out: TemplateInput = {};

  if (input.name !== undefined || !partial) {
    const name = text(input.name);
    if (!name) errors.push({ field: 'name', message: 'name is required' });
    else if (name.length > MAX_NAME_LENGTH)
      errors.push({
        field: 'name',
        message: `name must be at most ${MAX_NAME_LENGTH} characters`,
      });
    else out.name = name;
  }
  if (input.body !== undefined || !partial) {
    const value = text(input.body);
    if (!value) errors.push({ field: 'body', message: 'message is required' });
    else if (value.length > MAX_MESSAGE_LENGTH)
      errors.push({
        field: 'body',
        message: `message must be at most ${MAX_MESSAGE_LENGTH} characters`,
      });
    else out.body = value;
  }

  if (errors.length) throw validationFailed(errors);
  return out;
}

export function parseRecipientQuery(q: Record<string, string | undefined>) {
  const page = Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1);
  const limit = Math.min(
    MAX_RECIPIENT_PAGE,
    Math.max(1, Number.parseInt(q.limit ?? '', 10) || DEFAULT_RECIPIENT_PAGE),
  );
  const status = (RECIPIENT_STATUSES as readonly string[]).includes(
    q.status ?? '',
  )
    ? q.status
    : undefined;
  return { page, limit, status };
}

type CampaignRow = BulkCampaign & {
  phoneNumber: { phoneNumber: string | null; status: string } | null;
};

export function toCampaignResource(row: CampaignRow) {
  return {
    id: row.id,
    name: row.name,
    phone_number_id: row.phoneNumberId,
    phone_number: row.phoneNumber?.phoneNumber ?? null,
    phone_number_status: row.phoneNumber?.status ?? null,
    message: row.message,
    interval_seconds: row.intervalSeconds,
    status: row.status,
    total_count: row.totalCount,
    sent_count: row.sentCount,
    failed_count: row.failedCount,
    pending_count: Math.max(
      0,
      row.totalCount - row.sentCount - row.failedCount,
    ),
    // Only meaningful while running: when the next message goes out.
    next_send_at:
      row.status === 'running' ? row.nextSendAt.toISOString() : null,
    last_error: row.lastError,
    completed_at: row.completedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export function toRecipientResource(row: BulkRecipient) {
  return {
    id: row.id,
    position: row.position,
    phone: row.phone,
    variables: row.variables as Record<string, string>,
    status: row.status,
    error: row.error,
    sent_at: row.sentAt?.toISOString() ?? null,
  };
}

export function toTemplateResource(row: MessageTemplate) {
  return {
    id: row.id,
    name: row.name,
    body: row.body,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
