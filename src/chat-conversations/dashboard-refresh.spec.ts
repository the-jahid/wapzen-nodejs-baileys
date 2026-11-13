import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { AgentFilesService } from '../agent-files/agent-files.service';
import { ClerkAuthGuard } from '../auth/auth.guard';
import { ChatAgentsController } from '../chat-agents/chat-agents.controller';
import { ChatAgentsService } from '../chat-agents/chat-agents.service';
import { HOURLY_LIMITS_ON } from '../chat-agents/chat-agents.types';
import { PrismaClient } from '../generated/prisma/client';
import { OrdersController } from '../orders/orders.controller';
import { OrdersService } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChatResponderService } from '../whatsapp/chat-responder.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { ChatConversationsController } from './chat-conversations.controller';
import { ChatConversationsService } from './chat-conversations.service';
import { appendMessage } from './chat-conversations.store';

// What the dashboard re-reads on a timer, through the real routes on a real
// Postgres (PGlite) with the project's migrations and triggers.

const mockUser = { id: '' };

jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../activity/activity');
jest.mock('../auth/auth.guard', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createParamDecorator } = require('@nestjs/common') as {
    createParamDecorator: typeof import('@nestjs/common').createParamDecorator;
  };
  return {
    ClerkAuthGuard: class {},
    CurrentUser: createParamDecorator(() => mockUser),
  };
});
// Neither is used on these routes, and both pull in ESM-only packages.
jest.mock('../whatsapp/whatsapp.service', () => ({
  WhatsAppService: class {},
  NumberNotConnectedError: class extends Error {},
}));
jest.mock('../whatsapp/chat-responder.service', () => ({
  ChatResponderService: class {},
}));
jest.mock('../agent-files/agent-files.service', () => ({
  AgentFilesService: class {},
}));
jest.setTimeout(60_000);

const PORT = 55491;
const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');
const CONVERSATIONS = '/v1/dashboard/chat-conversations';
const AGENTS = '/v1/dashboard/chat-agents';
const HOUR = 60 * 60_000;

let pg: PGlite;
let server: PGLiteSocketServer;
let prisma: PrismaClient;
let app: INestApplication;
let n = 0;

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
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
      max: 1,
    }),
  });
  const moduleRef = await Test.createTestingModule({
    controllers: [
      ChatConversationsController,
      ChatAgentsController,
      OrdersController,
    ],
    providers: [
      ChatConversationsService,
      ChatAgentsService,
      OrdersService,
      { provide: PrismaService, useValue: prisma },
      { provide: WhatsAppService, useValue: {} },
      { provide: ChatResponderService, useValue: {} },
      { provide: AgentFilesService, useValue: {} },
    ],
  })
    .overrideGuard(ClerkAuthGuard)
    .useValue({ canActivate: () => true })
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await server.stop();
  await pg.close();
});

// An account with one number, one agent and one thread, signed in.
async function account() {
  n += 1;
  const user = await prisma.user.create({
    data: { email: `refresh${n}@example.com`, oauthId: `user_refresh${n}` },
  });
  const phone = await prisma.phoneNumber.create({
    data: {
      userId: user.id,
      phoneNumber: `+880180000${n}`,
      waJid: `880180000${n}:5@s.whatsapp.net`,
      status: 'connected',
    },
  });
  const agent = await prisma.chatAgent.create({
    data: {
      userId: user.id,
      agentName: 'Sales',
      phoneNumberId: phone.id,
      status: 'active',
      systemPrompt: 'A long and private prompt.',
    },
  });
  const thread = await prisma.chatConversation.create({
    data: {
      userId: user.id,
      phoneNumberId: phone.id,
      chatAgentId: agent.id,
      peerJid: '111@lid',
    },
  });
  mockUser.id = user.id;
  return { userId: user.id, phoneId: phone.id, agentId: agent.id, thread };
}

const http = () => request(app.getHttpServer() as never);

async function version(query = '') {
  const res = await http().get(`${CONVERSATIONS}/version${query}`).expect(200);
  return (res.body as { data: { version: string } }).data.version;
}

// Long enough that a write lands on a later millisecond than the one before.
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("the orders' version", () => {
  const ORDERS = '/v1/dashboard/orders';
  type Version = { data: { version: string; new_orders: number } };

  async function ordersVersion() {
    const res = await http().get(`${ORDERS}/version`).expect(200);
    return (res.body as Version).data;
  }

  async function order(userId: string, orderNumber: number) {
    return prisma.order.create({
      data: {
        userId,
        orderNumber,
        customerName: 'Ayesha Rahman',
        phone: '+8801712345678',
        description: '2 large pizzas',
      },
    });
  }

  it('is what the /:order_id route would otherwise read as an order id', async () => {
    await account();
    expect(await ordersVersion()).toEqual({ version: '0:0', new_orders: 0 });
  });

  it('counts new orders the way the list does, and moves when one changes', async () => {
    const { userId } = await account();
    const first = await order(userId, 1001);
    await order(userId, 1002);
    const before = await ordersVersion();
    expect(before.new_orders).toBe(2);
    expect(await ordersVersion()).toEqual(before);

    const listed = await http().get(`${ORDERS}?page=1&limit=1`).expect(200);
    expect(
      (listed.body as { meta: { new_orders: number } }).meta.new_orders,
    ).toBe(before.new_orders);

    await tick();
    await http()
      .patch(`${ORDERS}/${first.id}`)
      .send({ status: 'completed' })
      .expect(200);
    const after = await ordersVersion();
    expect(after.version).not.toBe(before.version);
    expect(after.new_orders).toBe(1);

    await http().delete(`${ORDERS}/${first.id}`).expect(200);
    expect((await ordersVersion()).version).not.toBe(after.version);
  });
});

describe("the inbox's version", () => {
  it('stays the same while nothing changes', async () => {
    await account();
    const first = await version();
    await tick();
    expect(await version()).toBe(first);
  });

  it('is what the /:id route would otherwise read as a thread id', async () => {
    await account();
    expect(await version()).toMatch(/^1:\d+$/);
  });

  it('changes when a message arrives', async () => {
    const { thread } = await account();
    const before = await version();
    await tick();
    await appendMessage(prisma, thread.id, 'user', 'hello');
    expect(await version()).not.toBe(before);
  });

  it('changes when a thread is closed or its AI switched off', async () => {
    const { thread } = await account();
    const open = await version();
    await tick();
    await http()
      .patch(`${CONVERSATIONS}/${thread.id}`)
      .send({ status: 'closed' })
      .expect(200);
    const closed = await version();
    expect(closed).not.toBe(open);
    await tick();
    await http()
      .patch(`${CONVERSATIONS}/${thread.id}`)
      .send({ ai_reply_enabled: false })
      .expect(200);
    expect(await version()).not.toBe(closed);
  });

  it('changes when a thread is added or deleted', async () => {
    const { userId, phoneId, thread } = await account();
    const one = await version();
    await tick();
    await prisma.chatConversation.create({
      data: { userId, phoneNumberId: phoneId, peerJid: '222@lid' },
    });
    const two = await version();
    expect(two).not.toBe(one);
    await http().delete(`${CONVERSATIONS}/${thread.id}`).expect(200);
    expect(await version()).not.toBe(two);
  });

  it("ignores another agent's thread when filtered to one agent", async () => {
    const { userId, phoneId, agentId } = await account();
    const query = `?chat_agent_id=${agentId}`;
    const mine = await version(query);
    await tick();
    await prisma.chatConversation.create({
      data: { userId, phoneNumberId: phoneId, peerJid: '222@lid' },
    });
    expect(await version(query)).toBe(mine);
    expect(await version()).not.toBe(mine);
  });

  it("isn't moved by another account", async () => {
    await account();
    const mine = await version();
    const myId = mockUser.id;
    const other = await account();
    await tick();
    await appendMessage(prisma, other.thread.id, 'user', 'hello');
    mockUser.id = myId;
    expect(await version()).toBe(mine);
  });

  it('refuses a bad filter like the listing does', async () => {
    await account();
    await http().get(`${CONVERSATIONS}/version?status=nope`).expect(400);
  });
});

describe('a thread after a message it already has', () => {
  async function withMessages(count: number) {
    const { thread } = await account();
    for (let i = 0; i < count; i += 1) {
      await appendMessage(prisma, thread.id, 'user', `message ${i}`);
    }
    return thread.id;
  }
  type Thread = {
    message_count: number;
    messages: { seq: number; content: string }[];
  };
  const get = async (path: string) =>
    (await http().get(path).expect(200)).body as { data: Thread };

  it('still returns the whole transcript when not asked otherwise', async () => {
    const id = await withMessages(3);
    const { data } = await get(`${CONVERSATIONS}/${id}`);
    expect(data.messages.map((m) => m.seq)).toEqual([0, 1, 2]);
    expect(data.message_count).toBe(3);
  });

  it('returns only the newer messages, with the full count', async () => {
    const id = await withMessages(4);
    const { data } = await get(`${CONVERSATIONS}/${id}?after_seq=1`);
    expect(data.messages.map((m) => m.content)).toEqual([
      'message 2',
      'message 3',
    ]);
    expect(data.message_count).toBe(4);
  });

  it('counts the very first message as one it has', async () => {
    const id = await withMessages(2);
    const { data } = await get(`${CONVERSATIONS}/${id}?after_seq=0`);
    expect(data.messages.map((m) => m.seq)).toEqual([1]);
  });

  it('returns no messages when there is nothing new', async () => {
    const id = await withMessages(2);
    const { data } = await get(`${CONVERSATIONS}/${id}?after_seq=1`);
    expect(data.messages).toEqual([]);
    expect(data.message_count).toBe(2);
  });

  it('also works on the public path', async () => {
    const id = await withMessages(2);
    const { data } = await get(`/v1/chat-conversations/${id}?after_seq=0`);
    expect(data.messages.map((m) => m.seq)).toEqual([1]);
  });

  it.each(['abc', '-1', '1.5', '99999999999'])('refuses %s', async (bad) => {
    const id = await withMessages(1);
    await http().get(`${CONVERSATIONS}/${id}?after_seq=${bad}`).expect(400);
  });

  it("doesn't find another account's thread", async () => {
    const id = await withMessages(1);
    await account();
    await http().get(`${CONVERSATIONS}/${id}?after_seq=0`).expect(404);
  });
});

describe("an agent's live state", () => {
  type Live = { id: string; hourly_limit_resets_at?: string };
  const live = async () =>
    ((await http().get(`${AGENTS}/live`).expect(200)).body as { data: Live[] })
      .data;

  it('is only the id and status while the agent is under its limit', async () => {
    const { agentId } = await account();
    expect(await live()).toEqual([{ id: agentId, status: 'active' }]);
  });

  (HOURLY_LIMITS_ON ? it : it.skip)(
    'says when an agent at its limit answers again',
    async () => {
      const { agentId } = await account();
      const started = new Date(Date.now() - HOUR / 2);
      await prisma.chatAgent.update({
        where: { id: agentId },
        data: { hourlyReplyCount: 50, hourlyWindowStartedAt: started },
      });
      expect(await live()).toEqual([
        {
          id: agentId,
          status: 'active',
          hourly_limit_resets_at: new Date(
            started.getTime() + HOUR,
          ).toISOString(),
        },
      ]);
    },
  );

  (HOURLY_LIMITS_ON ? it : it.skip)(
    'matches what the full agent says, at the limit and past it',
    async () => {
      const { agentId } = await account();
      const full = async () =>
        (
          (await http().get(`${AGENTS}/${agentId}`).expect(200)).body as {
            data: Live;
          }
        ).data.hourly_limit_resets_at;

      await prisma.chatAgent.update({
        where: { id: agentId },
        data: { hourlyReplyCount: 50, hourlyWindowStartedAt: new Date() },
      });
      expect((await live())[0].hourly_limit_resets_at).toBe(await full());
      expect(await full()).toBeDefined();

      await prisma.chatAgent.update({
        where: { id: agentId },
        data: { hourlyWindowStartedAt: new Date(Date.now() - 2 * HOUR) },
      });
      expect((await live())[0].hourly_limit_resets_at).toBeUndefined();
      expect(await full()).toBeUndefined();
    },
  );

  it('leaves the prompt and other settings out', async () => {
    await account();
    const res = await http().get(`${AGENTS}/live`).expect(200);
    expect(res.text).not.toContain('private prompt');
  });

  it("shows only this account's agents", async () => {
    await account();
    const { agentId } = await account();
    expect((await live()).map((agent) => agent.id)).toEqual([agentId]);
  });
});
