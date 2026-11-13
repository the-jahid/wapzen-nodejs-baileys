import type { PhoneNumber } from '../generated/prisma/client';
import { toResource, type LoginState } from './phone-number.types';

// The dashboard asks about a waiting login every 2 seconds. The QR picture is
// most of the answer, so it goes out once per code.

const row = (qrCode: string | null, status = 'pending_qr') =>
  ({
    id: 'phone-1',
    userId: 'user-1',
    phoneNumber: null,
    label: null,
    waJid: null,
    status,
    qrCode,
    lastConnectedAt: null,
    createdAt: new Date('2026-11-12T10:00:00Z'),
    updatedAt: new Date('2026-11-12T10:00:00Z'),
  }) as PhoneNumber;

const qrLogin = (): LoginState => ({
  email: 'owner@example.com',
  byCode: false,
  startedAt: Date.now(),
  qrAt: Date.now(),
  qrCount: 1,
});

const FIRST = 'https://wa.me/settings/linked_devices#2@first,aaa,bbb,ccc';
const SECOND = 'https://wa.me/settings/linked_devices#2@second,aaa,bbb,ccc';

describe('the QR picture of a waiting login', () => {
  it('is sent, with its id, to a caller that has none', async () => {
    const resource = await toResource(row(FIRST), qrLogin());
    expect(resource.qr_code).toMatch(/^data:image\/png;base64,/);
    expect(resource.qr_id).toMatch(/^[\w-]{16}$/);
    expect(resource.qr_expires_in_ms).toBeGreaterThan(0);
  });

  it('is left out for a caller that already holds it', async () => {
    const first = await toResource(row(FIRST), qrLogin());
    const again = await toResource(row(FIRST), qrLogin(), first.qr_id);
    expect(again.qr_code).toBeUndefined();
    expect(again.qr_id).toBe(first.qr_id);
    expect(again.qr_expires_in_ms).toBeGreaterThan(0);
    expect(again.status).toBe('pending_qr');
  });

  it('is sent again as soon as WhatsApp hands out a new code', async () => {
    const first = await toResource(row(FIRST), qrLogin());
    const next = await toResource(row(SECOND), qrLogin(), first.qr_id);
    expect(next.qr_id).not.toBe(first.qr_id);
    expect(next.qr_code).toMatch(/^data:image\/png;base64,/);
    expect(next.qr_code).not.toBe(first.qr_code);
  });

  it('is sent to a caller whose id is not one this server gave', async () => {
    const resource = await toResource(row(FIRST), qrLogin(), 'something-else');
    expect(resource.qr_code).toMatch(/^data:image\/png;base64,/);
  });

  it('is the same picture as before for the same code', async () => {
    const one = await toResource(row(FIRST), qrLogin());
    const two = await toResource(row(FIRST), qrLogin());
    expect(two.qr_code).toBe(one.qr_code);
    expect(two.qr_id).toBe(one.qr_id);
  });

  it('has no id once the login is over or uses a pairing code', async () => {
    const linked = await toResource(row(null, 'connected'), undefined, 'abc');
    expect(linked.qr_id).toBeUndefined();
    expect(linked.qr_code).toBeUndefined();

    const byCode = await toResource(
      row(null),
      { ...qrLogin(), byCode: true, qrAt: undefined, pairingCode: 'ABCDEFGH' },
      'abc',
    );
    expect(byCode.pairing_code).toBe('ABCD-EFGH');
    expect(byCode.qr_id).toBeUndefined();
  });
});
