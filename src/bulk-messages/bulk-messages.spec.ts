import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { HttpException } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  NotOnWhatsAppError,
  NumberNotConnectedError,
  type WhatsAppService,
} from '../whatsapp/whatsapp.service';
import { BulkMessagesService } from './bulk-messages.service';
import { parseCampaign, renderMessage } from './bulk-messages.types';
import { BulkSenderService } from './bulk-sender.service';
import { MessageTemplatesService } from './message-templates.service';

// Runs against a real Postgres (PGlite, in this process) with the project's own
// migrations: the claiming that keeps two servers from sending one message
// twice lives in SQL, and so does the one-running-send-per-number rule.

// Baileys is ESM-only, which Jest can't load; the sender only needs the
// service's errors and sendToPhone, which each test fakes.
jest.mock('../whatsapp/whatsapp.service', () => ({
  NumberNotConnectedError: class NumberNotConnectedError extends Error {},
  NotOnWhatsAppError: class NotOnWhatsAppError extends Error {},
  WhatsAppService: class {},
}));
// Nothing here reads config, and the package is ESM-only.
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.setTimeout(60_000);

const PORT = 55434;
const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');

let pg: PGlite;
let server: PGLiteSocketServer;
let prisma: PrismaClient;
let bulk: BulkMessagesService;
let templates: MessageTemplatesService;
let n = 0;

type Sent = { phone: string; text: string };

async function newAccount() {
  n += 1;
  const user = await prisma.user.create({
    data: { email: `bulk${n}@example.com`, oauthId: `user_bulk${n}` },
  });
  const phone = await prisma.phoneNumber.create({
    data: {
      userId: user.id,
      phoneNumber: `+8801800000${n}`,
      status: 'connected',
    },
  });
  return { user, phone };
}

// A sender whose WhatsApp is a function the test controls.
function senderWith(send: (phone: string, text: string) => Promise<unknown>) {
  const whatsapp = {
    sendToPhone: (_id: string, phone: string, text: string) =>
      send(phone, text),
  } as unknown as WhatsAppService;
  return new BulkSenderService(prisma as unknown as PrismaService, whatsapp);
}

// One tick that waits for the sends it started, and makes every running send
// due first, so a test doesn't wait out the interval.
async function tick(sender: BulkSenderService) {
  await prisma.bulkCampaign.updateMany({
    where: { status: 'running' },
    data: { nextSendAt: new Date(Date.now() - 1000) },
  });
  const internals = sender as unknown as {
    claimDue(): Promise<{ id: string }[]>;
    sendNext(c: unknown): Promise<void>;
  };
  const due = await internals.claimDue();
  await Promise.all(due.map((c) => internals.sendNext(c)));
  return due.length;
}

function input(phoneNumberId: string, phones: string[], extra = {}) {
  return parseCampaign({
    name: 'Eid offer',
    phone_number_id: phoneNumberId,
    message: 'Hi {{Name}}, your code is {{ code }}.',
    recipients: phones.map((phone, i) => ({
      phone,
      variables: { Name: `Person ${i}`, Code: `C${i}` },
    })),
    ...extra,
  });
}

function statusOf(err: unknown) {
  return err instanceof HttpException ? err.getStatus() : 0;
}

beforeAll(async () => {
  pg = await PGlite.create();
  const names = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    await pg.exec(
      readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8'),
    );
  }
  server = new PGLiteSocketServer({ db: pg, port: PORT, host: '127.0.0.1' });
  await server.start();
  prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`,
      max: 1,
    }),
  });
  bulk = new BulkMessagesService(prisma as unknown as PrismaService);
  templates = new MessageTemplatesService(prisma as unknown as PrismaService);
});

afterAll(async () => {
  await prisma?.$disconnect();
  await server?.stop();
  await pg?.close();
});

describe('parsing', () => {
  it('drops repeated numbers, keeps the default interval, keys columns by lower case', () => {
    const parsed = parseCampaign({
      name: ' Promo ',
      phone_number_id: 'x',
      message: 'Hi',
      recipients: [
        { phone: '+880 1711-111111', variables: { 'First  Name': 'Ana' } },
        { phone: '+8801711111111' },
      ],
    });
    expect(parsed.name).toBe('Promo');
    expect(parsed.intervalSeconds).toBe(30);
    expect(parsed.duplicates).toBe(1);
    expect(parsed.recipients).toEqual([
      { phone: '+8801711111111', variables: { 'first name': 'Ana' } },
    ]);
  });

  it('refuses a number without a country code and an interval under 10s', () => {
    try {
      parseCampaign({
        name: 'x',
        phone_number_id: 'x',
        message: 'Hi',
        interval_seconds: 5,
        recipients: [{ phone: '01711111111' }],
      });
      throw new Error('expected a validation error');
    } catch (err) {
      expect(statusOf(err)).toBe(400);
      const body = (err as HttpException).getResponse() as {
        errors: { field: string }[];
      };
      expect(body.errors.map((e) => e.field)).toEqual([
        'interval_seconds',
        'recipients[0].phone',
      ]);
    }
  });

  it('fills placeholders whatever their case, and {{phone}} from the number', () => {
    expect(
      renderMessage('Hi {{ NAME }} ({{phone}}) {{missing}}!', '+1555', {
        name: 'Bo',
      }),
    ).toBe('Hi Bo (+1555) !');
  });
});

describe('templates', () => {
  it('are scoped to their account', async () => {
    const a = await newAccount();
    const b = await newAccount();
    const t = await templates.create(a.user.id, {
      name: 'Welcome',
      body: 'Hi {{name}}',
    });
    expect(await templates.list(b.user.id)).toEqual([]);
    await expect(templates.remove(b.user.id, t.id)).rejects.toThrow(
      HttpException,
    );
    const updated = await templates.update(a.user.id, t.id, {
      body: 'Hello {{name}}',
    });
    expect(updated.body).toBe('Hello {{name}}');
  });
});

describe('sends', () => {
  it('allow one running send per number', async () => {
    const { user, phone } = await newAccount();
    const first = await bulk.create(
      user.id,
      input(phone.id, ['+8801711000001']),
    );
    expect(first.status).toBe('running');
    await expect(
      bulk.create(user.id, input(phone.id, ['+8801711000002'])),
    ).rejects.toMatchObject({ status: 409 });

    await bulk.pause(user.id, first.id);
    const second = await bulk.create(
      user.id,
      input(phone.id, ['+8801711000002']),
    );
    // The first can't come back while the second runs.
    await expect(bulk.resume(user.id, first.id)).rejects.toMatchObject({
      status: 409,
    });

    const cancelled = await bulk.cancel(user.id, second.id);
    expect(cancelled.status).toBe('cancelled');
    const { recipients } = await bulk.recipients(user.id, second.id, 1, 50);
    expect(recipients.map((r) => r.status)).toEqual(['skipped']);
    expect((await bulk.resume(user.id, first.id)).status).toBe('running');
    await bulk.remove(user.id, first.id);
  });

  it('are not visible to another account', async () => {
    const a = await newAccount();
    const b = await newAccount();
    const send = await bulk.create(
      a.user.id,
      input(a.phone.id, ['+8801711000003']),
    );
    await expect(bulk.get(b.user.id, send.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(bulk.pause(b.user.id, send.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      bulk.create(b.user.id, input(a.phone.id, ['+8801711000004'])),
    ).rejects.toMatchObject({ status: 404 });
    await bulk.remove(a.user.id, send.id);
  });
});

describe('sender', () => {
  it('sends in file order, records failures, completes, and saves the chat', async () => {
    const { user, phone } = await newAccount();
    const send = await bulk.create(
      user.id,
      input(phone.id, ['+8801711000010', '+8801711000011', '+8801711000012']),
    );
    const sent: Sent[] = [];
    const sender = senderWith((to, text) => {
      if (to === '+8801711000011')
        return Promise.reject(new NotOnWhatsAppError());
      sent.push({ phone: to, text });
      return Promise.resolve({
        pnJid: `${to.slice(1)}@s.whatsapp.net`,
        lidJid: `9${to.slice(-4)}@lid`,
      });
    });

    expect(await tick(sender)).toBe(1);
    // The interval holds: nothing is due straight after a message.
    const internals = sender as unknown as { claimDue(): Promise<unknown[]> };
    expect(await internals.claimDue()).toEqual([]);
    await tick(sender);
    await tick(sender);

    expect(sent).toEqual([
      { phone: '+8801711000010', text: 'Hi Person 0, your code is C0.' },
      { phone: '+8801711000012', text: 'Hi Person 2, your code is C2.' },
    ]);
    const done = await bulk.get(user.id, send.id);
    expect(done).toMatchObject({
      status: 'completed',
      sent_count: 2,
      failed_count: 1,
      pending_count: 0,
    });
    const failed = await bulk.recipients(user.id, send.id, 1, 50, 'failed');
    expect(failed.recipients[0]).toMatchObject({
      phone: '+8801711000011',
      error: 'This number is not on WhatsApp.',
    });

    const thread = await prisma.chatConversation.findFirstOrThrow({
      where: { phoneNumberId: phone.id, peerPhone: '+8801711000010' },
      include: { messages: true },
    });
    expect(thread.peerJid).toBe('90010@lid');
    expect(thread.peerName).toBe('Person 0');
    expect(thread.messages.map((m) => [m.role, m.content])).toEqual([
      ['assistant', 'Hi Person 0, your code is C0.'],
    ]);
    expect(await tick(sender)).toBe(0);
  });

  it('keeps a number in the queue while the phone is offline', async () => {
    const { user, phone } = await newAccount();
    const send = await bulk.create(
      user.id,
      input(phone.id, ['+8801711000020']),
    );
    let online = false;
    const sender = senderWith(() =>
      online
        ? Promise.resolve({
            pnJid: '8801711000020@s.whatsapp.net',
            lidJid: null,
          })
        : Promise.reject(new NumberNotConnectedError()),
    );

    await tick(sender);
    let state = await bulk.get(user.id, send.id);
    expect(state).toMatchObject({
      status: 'running',
      sent_count: 0,
      failed_count: 0,
    });
    expect(state.last_error).toMatch(/reconnect/);

    online = true;
    await tick(sender);
    state = await bulk.get(user.id, send.id);
    expect(state).toMatchObject({
      status: 'completed',
      sent_count: 1,
      last_error: null,
    });
  });

  it('does not send for a paused send', async () => {
    const { user, phone } = await newAccount();
    const send = await bulk.create(
      user.id,
      input(phone.id, ['+8801711000030']),
    );
    await bulk.pause(user.id, send.id);
    const sender = senderWith(() => Promise.reject(new Error('must not send')));
    expect(await tick(sender)).toBe(0);
  });

  it('counts a message interrupted by a restart as failed, not resent', async () => {
    const { user, phone } = await newAccount();
    const send = await bulk.create(
      user.id,
      input(phone.id, ['+8801711000040']),
    );
    await prisma.bulkRecipient.updateMany({
      where: { campaignId: send.id },
      data: { status: 'sending' },
    });
    await pg.exec(
      `UPDATE bulk_campaigns SET updated_at = now() - interval '10 minutes' WHERE id = '${send.id}'`,
    );
    const sender = senderWith(() => Promise.reject(new Error('must not send')));
    await (
      sender as unknown as { recoverInterrupted(): Promise<void> }
    ).recoverInterrupted();
    await tick(sender);
    expect(await bulk.get(user.id, send.id)).toMatchObject({
      status: 'completed',
      failed_count: 1,
    });
  });
});
