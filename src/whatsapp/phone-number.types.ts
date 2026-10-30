import { HttpStatus } from '@nestjs/common';
import QRCode from 'qrcode';
import type { PhoneNumber } from '../generated/prisma/client';
import { apiError } from '../chat-agents/chat-agents.types';

// Wire format and request checks for /v1/phone-number, matching the Go
// server's phone_number_handler.go and docs/openapi.json.

export const E164 = /^\+[1-9][0-9]{1,14}$/;

// WhatsApp gives the first QR code of a login 60s and each later one 20s.
const FIRST_QR_MS = 60_000;
const NEXT_QR_MS = 20_000;
// A pairing code lives as long as the login, which WhatsApp ends about 160s
// after it started.
const PAIRING_CODE_MS = 160_000;

// What the server knows about a login that is still waiting for the phone.
export type LoginState = {
  email: string;
  byCode: boolean;
  // Set once the user has been given a QR or pairing code to use.
  codeShown?: boolean;
  startedAt: number;
  qrAt?: number;
  qrCount: number;
  pairingCode?: string;
};

export type PhoneNumberResource = {
  id: string;
  phone_number: string | null;
  label: string | null;
  wa_jid: string | null;
  status: string;
  qr_code?: string;
  qr_expires_in_ms?: number;
  pairing_code?: string;
  pairing_expires_in_ms?: number;
  last_connected_at: string | null;
  created_at: string;
  updated_at: string;
};

export async function toResource(
  row: PhoneNumber,
  login: LoginState | undefined,
): Promise<PhoneNumberResource> {
  const resource: PhoneNumberResource = {
    id: row.id,
    phone_number: row.phoneNumber,
    label: row.label,
    wa_jid: row.waJid,
    status: row.status,
    last_connected_at: row.lastConnectedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
  if (row.status !== 'pending_qr' || !login) return resource;

  const now = Date.now();
  if (login.pairingCode) {
    // Shown the way WhatsApp's own screen asks for it: ABCD-EFGH.
    const code = login.pairingCode;
    resource.pairing_code = `${code.slice(0, 4)}-${code.slice(4)}`;
    resource.pairing_expires_in_ms = Math.max(
      0,
      login.startedAt + PAIRING_CODE_MS - now,
    );
  } else if (row.qrCode && login.qrAt) {
    // The dashboard puts this straight into an <img>, so it's a PNG data URL
    // of the QR text WhatsApp handed out.
    resource.qr_code = await QRCode.toDataURL(row.qrCode, { margin: 1 });
    const lifetime = login.qrCount <= 1 ? FIRST_QR_MS : NEXT_QR_MS;
    resource.qr_expires_in_ms = Math.max(0, login.qrAt + lifetime - now);
  }
  return resource;
}

export type LoginRequest = {
  label?: string;
  phoneNumber?: string;
  byCode: boolean;
  phoneNumberId?: string;
  forceRepair: boolean;
};

// The login body is optional and every field in it is. Unknown fields (such
// as the voice-agent agent_id older clients send) are ignored, as in Go.
export function parseLoginRequest(body: unknown): LoginRequest {
  const b: Record<string, unknown> = isObject(body) ? body : {};
  const text = (field: string) => {
    const value = b[field];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw badRequest('Invalid request body');
    return value.trim() || undefined;
  };

  const label = text('label');
  if (label && label.length > 80) {
    throw badRequest('label must be 80 characters or fewer');
  }
  const phoneNumber = text('phone_number');
  if (phoneNumber && !E164.test(phoneNumber)) {
    throw badRequest('phone_number must be in E.164 format');
  }
  const method = text('pairing_method') ?? 'qr';
  if (method !== 'qr' && method !== 'phone_code') {
    throw badRequest('pairing_method must be qr or phone_code');
  }
  const phoneNumberId = text('phone_number_id');
  const forceRepair = b.force_repair === true;

  if (forceRepair && !phoneNumberId) {
    throw badRequest('phone_number_id is required when force_repair is true');
  }
  const byCode = method === 'phone_code';
  if (byCode && (!phoneNumber || phoneNumberId)) {
    throw badRequest(
      'pairing_method phone_code needs phone_number and no phone_number_id',
    );
  }
  return { label, phoneNumber, byCode, phoneNumberId, forceRepair };
}

export function parseLogoutRequest(body: unknown): string {
  if (!isObject(body)) throw badRequest('Invalid request body');
  const id = body.phone_number_id;
  if (id !== undefined && typeof id !== 'string') {
    throw badRequest('Invalid request body');
  }
  if (!id?.trim()) throw badRequest('phone_number_id is required');
  return id.trim();
}

function badRequest(message: string) {
  return apiError(HttpStatus.BAD_REQUEST, message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
