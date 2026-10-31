import { HttpStatus } from '@nestjs/common';
import type { Order } from '../generated/prisma/client';
import {
  apiError,
  invalidBody,
  isObject,
  requireObject,
  validationFailed,
  type FieldError,
} from '../tools/tools.types';

// Wire types and validation for /v1/orders, plus the checks an order goes
// through when an agent places one. Everything a customer typed passes through
// cleanText before it is stored.

export const ORDER_STATUSES = [
  'new',
  'confirmed',
  'processing',
  'completed',
  'cancelled',
] as const;

export const LIST_PATH = '/v1/orders';
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;
// A guess at the most anyone needs in one file; a filter narrows the rest.
export const MAX_EXPORT_ROWS = 10_000;

const MAX_NAME_LENGTH = 120;
const MAX_EMAIL_LENGTH = 254;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_ADDRESS_LENGTH = 500;
const MAX_ITEMS = 50;
const MAX_ITEM_NAME_LENGTH = 200;
const MAX_ITEM_NOTE_LENGTH = 500;
const MAX_NOTE_LENGTH = 2000;
const MAX_INT = 2_147_483_647;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164 = /^\+[1-9]\d{7,14}$/;
const DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/;
// What a model writes when it has nothing to put in an optional field.
const PLACEHOLDER = /^(n\/?a|none|null|unknown|not provided|-+)$/i;

export type OrderItem = { name: string; quantity?: number; note?: string };

// An order after validation, ready to be stored.
export type NewOrder = {
  customerName: string;
  phone: string;
  email: string | null;
  description: string;
  items: OrderItem[];
  deliveryAddress: string | null;
};

export type OrderFilter = {
  search?: string;
  status?: string;
  agentId?: string;
  from?: Date;
  to?: Date;
};

export type OrderListQuery = {
  page: number;
  limit: number;
  filter: OrderFilter;
};

export type OrderUpdate = { status?: string; internalNote?: string | null };

type OrderRow = Order & { agent: { agentName: string } | null };

export function toResource(row: OrderRow) {
  return {
    id: row.id,
    order_number: row.orderNumber,
    customer_name: row.customerName,
    phone: row.phone,
    email: row.email,
    description: row.description,
    items: row.items as OrderItem[],
    delivery_address: row.deliveryAddress,
    status: row.status,
    channel: row.channel,
    internal_note: row.internalNote,
    agent_id: row.agentId,
    agent_name: row.agent?.agentName ?? null,
    conversation_id: row.conversationId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

// Strips HTML tags and control characters, keeping line breaks.
export function cleanText(value: string) {
  return (
    value
      .replace(/<\/?[a-z!][^>]*>/gi, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim()
  );
}

// The number in E.164, or null when it can't be made into one. A number written
// without a country code takes the one from reference, the sender's or the
// agent's own number; a leading 0 is the local trunk prefix.
export function toE164(raw: string, reference?: string | null): string | null {
  let value = raw.replace(/[\s().\-/]/g, '');
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  if (value.startsWith('+')) return E164.test(value) ? value : null;
  if (!/^\d+$/.test(value) || !reference) return null;

  const code = callingCode(reference);
  // Already international, just missing its +: it is as long as a number in
  // that country and starts with the code.
  const international =
    value.startsWith(code) && value.length === reference.length - 1;
  const number = international
    ? `+${value}`
    : `+${code}${value.replace(/^0+/, '')}`;
  return E164.test(number) ? number : null;
}

// Calling codes are prefix-free: 1 and 7 stand alone, these are the two-digit
// ones, and everything else has three.
const TWO_DIGIT_CODES = new Set(
  (
    '20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 ' +
    '51 52 53 54 55 56 57 58 60 61 62 63 64 65 66 81 82 84 86 ' +
    '90 91 92 93 94 95 98'
  ).split(' '),
);

function callingCode(e164: string) {
  const digits = e164.replace(/^\+/, '');
  if (digits[0] === '1' || digits[0] === '7') return digits[0];
  return TWO_DIGIT_CODES.has(digits.slice(0, 2))
    ? digits.slice(0, 2)
    : digits.slice(0, 3);
}

// Checks create_order's arguments, which come from the model. Every problem is
// named, so the agent can ask for the right thing instead of failing silently.
export function parseOrderArgs(
  args: Record<string, unknown>,
  context: { customerPhone?: string | null; agentPhone?: string | null },
): { order?: NewOrder; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const { customerPhone, agentPhone } = context;

  const customerName = text(args.customer_name);
  if (!customerName) {
    errors.push({
      field: 'customer_name',
      message: "ask for the customer's name",
    });
  } else if (customerName.length > MAX_NAME_LENGTH) {
    errors.push({ field: 'customer_name', message: 'the name is too long' });
  }

  // Only something with digits in it counts as a number they gave.
  const given = text(args.phone);
  const hasNumber = /\d/.test(given);
  const phone = hasNumber
    ? toE164(given, customerPhone ?? agentPhone)
    : (customerPhone ?? null);
  if (!phone) {
    errors.push({
      field: 'phone',
      message: hasNumber
        ? 'that phone number is not valid: ask for it again with the country code'
        : "ask for the customer's phone number with the country code",
    });
  }

  const email = optionalText(args.email);
  if (email && (email.length > MAX_EMAIL_LENGTH || !EMAIL.test(email))) {
    errors.push({
      field: 'email',
      message:
        'that email address is not valid: ask for it again or leave it out',
    });
  }

  const description = text(args.description);
  if (!description) {
    errors.push({
      field: 'description',
      message: 'ask what the customer wants to order',
    });
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push({
      field: 'description',
      message: 'the description is too long',
    });
  }

  const deliveryAddress = optionalText(args.delivery_address);
  if (deliveryAddress && deliveryAddress.length > MAX_ADDRESS_LENGTH) {
    errors.push({
      field: 'delivery_address',
      message: 'the address is too long',
    });
  }

  const items = parseItems(args.items, errors);
  if (errors.length) return { errors };
  return {
    errors,
    order: {
      customerName,
      phone: phone!,
      email: email ? email.toLowerCase() : null,
      description,
      items,
      deliveryAddress,
    },
  };
}

function parseItems(raw: unknown, errors: FieldError[]): OrderItem[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_ITEMS) {
    errors.push({
      field: 'items',
      message: `items must be a list of at most ${MAX_ITEMS}`,
    });
    return [];
  }
  const items: OrderItem[] = [];
  raw.forEach((entry: unknown, i) => {
    const field = `items[${i}]`;
    const item = isObject(entry) ? entry : {};
    const name = text(item.name);
    if (!name || name.length > MAX_ITEM_NAME_LENGTH) {
      errors.push({
        field: `${field}.name`,
        message: 'each item needs a name',
      });
      return;
    }
    const parsed: OrderItem = { name };
    if (item.quantity !== undefined && item.quantity !== null) {
      const quantity = Number(item.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        errors.push({
          field: `${field}.quantity`,
          message: 'quantity must be a positive number',
        });
        return;
      }
      parsed.quantity = quantity;
    }
    const note = optionalText(item.note);
    if (note) parsed.note = note.slice(0, MAX_ITEM_NOTE_LENGTH);
    items.push(parsed);
  });
  return items;
}

// Two orders with the same fingerprint are the same order: case, spacing, the
// order of the items and how they were worded don't change what was asked for.
export function fingerprint(order: NewOrder) {
  const norm = (value: string | null | undefined) =>
    (value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  // The model rewords the description from one call to the next, so the items
  // say what was ordered when it listed them.
  const items = order.items
    .map((i) => `${norm(i.name)} x${i.quantity ?? 1}`)
    .sort();
  return JSON.stringify([
    norm(order.customerName),
    order.phone,
    norm(order.deliveryAddress),
    items.length ? items : norm(order.description),
  ]);
}

// The query of the list and of the export, which filters the same way.
export function parseFilter(query: Record<string, string | undefined>) {
  const errors: FieldError[] = [];
  const filter: OrderFilter = {};

  const search = query.search?.trim();
  if (search) filter.search = search;

  const status = query.status?.trim();
  if (status) {
    if ((ORDER_STATUSES as readonly string[]).includes(status)) {
      filter.status = status;
    } else {
      errors.push({
        field: 'status',
        message: `status must be one of ${ORDER_STATUSES.join(', ')}`,
      });
    }
  }

  const agentId = query.agent_id?.trim();
  if (agentId) filter.agentId = agentId;

  filter.from = parseDate(query.date_from, 'date_from', errors);
  filter.to = parseDate(query.date_to, 'date_to', errors);
  return { filter, errors };
}

export function parseListQuery(
  query: Record<string, string | undefined>,
): OrderListQuery {
  const { filter, errors } = parseFilter(query);
  const page = parsePositive(query.page, 1);
  if (page === null) {
    errors.push({ field: 'page', message: 'page must be a positive integer' });
  }
  const limit = parsePositive(query.limit, DEFAULT_LIST_LIMIT);
  if (limit === null || limit > MAX_LIST_LIMIT) {
    errors.push({
      field: 'limit',
      message: `limit must be between 1 and ${MAX_LIST_LIMIT}`,
    });
  }
  if (page === null || limit === null || errors.length) {
    throw validationFailed(errors, 'Invalid query parameters');
  }
  return { page, limit, filter };
}

// The PATCH body. Only the status and the owner's note can change: the rest is
// what the customer ordered.
export function parseUpdate(body: unknown): OrderUpdate {
  const b = requireObject(body);
  const unknown = Object.keys(b).find(
    (key) => key !== 'status' && key !== 'internal_note',
  );
  if (unknown) throw invalidBody();

  const errors: FieldError[] = [];
  const update: OrderUpdate = {};

  if (b.status !== undefined) {
    if (
      typeof b.status === 'string' &&
      (ORDER_STATUSES as readonly string[]).includes(b.status)
    ) {
      update.status = b.status;
    } else {
      errors.push({
        field: 'status',
        message: `status must be one of ${ORDER_STATUSES.join(', ')}`,
      });
    }
  }

  if (b.internal_note === null) {
    update.internalNote = null;
  } else if (typeof b.internal_note === 'string') {
    const note = cleanText(b.internal_note);
    if (note.length > MAX_NOTE_LENGTH) {
      errors.push({
        field: 'internal_note',
        message: `internal_note must be at most ${MAX_NOTE_LENGTH} characters`,
      });
    }
    update.internalNote = note || null;
  } else if (b.internal_note !== undefined) {
    errors.push({
      field: 'internal_note',
      message: 'internal_note must be a string',
    });
  }

  if (!errors.length && !Object.keys(update).length) {
    errors.push({
      field: 'body',
      message: 'supply at least one field to update',
    });
  }
  if (errors.length) throw validationFailed(errors);
  return update;
}

// The search term as an order number, or null when it can't be one.
export function orderNumberIn(search: string) {
  const digits = /^#?(\d{1,10})$/.exec(search)?.[1];
  const number = digits ? Number(digits) : null;
  return number !== null && number <= MAX_INT ? number : null;
}

export function notFound() {
  return apiError(HttpStatus.NOT_FOUND, 'order not found');
}

const CSV_COLUMNS: [string, (row: ReturnType<typeof toResource>) => unknown][] =
  [
    ['Order #', (o) => o.order_number],
    ['Customer name', (o) => csvText(o.customer_name)],
    // Validated E.164, so its leading + can't start a formula.
    ['Phone', (o) => o.phone],
    ['Email', (o) => csvText(o.email)],
    ['Description', (o) => csvText(o.description)],
    ['Items', (o) => csvText(itemsLine(o.items))],
    ['Delivery address', (o) => csvText(o.delivery_address)],
    ['Agent', (o) => csvText(o.agent_name)],
    ['Status', (o) => o.status],
    ['Channel', (o) => o.channel],
    ['Internal note', (o) => csvText(o.internal_note)],
    ['Created at', (o) => o.created_at],
  ];

// The BOM makes Excel read the file as UTF-8, or Bangla names turn to garbage.
export function ordersCsv(orders: ReturnType<typeof toResource>[]) {
  const row = (cells: unknown[]) => cells.map(quote).join(',');
  return (
    '﻿' +
    [
      row(CSV_COLUMNS.map(([title]) => title)),
      ...orders.map((order) => row(CSV_COLUMNS.map(([, cell]) => cell(order)))),
    ].join('\r\n') +
    '\r\n'
  );
}

function itemsLine(items: OrderItem[]) {
  return items
    .map((item) =>
      [
        item.quantity !== undefined ? `${item.quantity} x` : '',
        item.name,
        item.note ? `(${item.note})` : '',
      ]
        .filter(Boolean)
        .join(' '),
    )
    .join('; ');
}

// Customers write these cells, and a spreadsheet runs a cell that starts like
// a formula, so those are made plain text.
function csvText(value: string | null) {
  if (!value) return '';
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function quote(cell: unknown) {
  return `"${String(cell).replace(/"/g, '""')}"`;
}

function text(value: unknown) {
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' ? cleanText(value) : '';
}

function optionalText(value: unknown) {
  const cleaned = text(value);
  return cleaned && !PLACEHOLDER.test(cleaned) ? cleaned : null;
}

function parseDate(
  raw: string | undefined,
  field: string,
  errors: FieldError[],
) {
  const value = raw?.trim();
  if (!value) return undefined;
  const date = new Date(value);
  if (!DATE.test(value) || Number.isNaN(date.getTime())) {
    errors.push({ field, message: `${field} must be an ISO 8601 date` });
    return undefined;
  }
  return date;
}

// The query value as a positive integer, fallback when absent, null when it
// isn't one.
function parsePositive(raw: string | undefined, fallback: number) {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : null;
}
