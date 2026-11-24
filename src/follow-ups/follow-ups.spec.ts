import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { ClerkAuthGuard } from '../auth/auth.guard';
import { appendMessage } from '../chat-conversations/chat-conversations.store';
import { PrismaClient } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { ChatResponderService } from '../whatsapp/chat-responder.service';
import type { WhatsAppService } from '../whatsapp/whatsapp.service';
import { FollowUpsController } from './follow-ups.controller';
import { FollowUpsService } from './follow-ups.service';

jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('../auth/auth.guard', () => {
  const { createParamDecorator } =
    jest.requireActual<typeof import('@nestjs/common')>('@nestjs/common');
  return {
    ClerkAuthGuard: class {},
    CurrentUser: createParamDecorator((_data, context) => ({
      id: context
        .switchToHttp()
        .getRequest<{ headers: Record<string, string> }>().headers[
        'x-test-account'
      ],
    })),
  };
});
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../whatsapp/chat-responder.service', () => ({
  ChatResponderService: class {},
}));
jest.mock('../whatsapp/whatsapp.service', () => ({
  WhatsAppService: class {},
  NumberNotConnectedError: class extends Error {},
}));
const mockReview = jest.fn();
jest.mock('./follow-up-model', () => ({
  createFollowUpReviewer: () => mockReview,
}));
jest.setTimeout(60_000);

const migrations = join(__dirname, '..', '..', 'prisma', 'migrations');
const settings = {
  prompt: 'Follow up on unanswered orders',
  intervalHours: 5,
  enabled: false,
};
const sendText = jest.fn();
let db: PGlite;
let socket: PGLiteSocketServer;
let prisma: PrismaClient;
let store: PrismaService;
let service: FollowUpsService;
let app: INestApplication;

beforeAll(async () => {
  db = await PGlite.create();
  for (const folder of readdirSync(migrations, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()) {
    await db.exec(
      readFileSync(join(migrations, folder, 'migration.sql'), 'utf8'),
    );
  }
  socket = new PGLiteSocketServer({ db, port: 55497, host: '127.0.0.1' });
  await socket.start();
  prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString:
        'postgresql://postgres:postgres@127.0.0.1:55497/postgres',
      max: 1,
    }),
  });
  store = prisma as unknown as PrismaService;
  service = new FollowUpsService(
    store,
    { get: () => 'fixture-key' } as unknown as ConfigService,
    { sendText } as unknown as WhatsAppService,
    {
      hasPendingReply: () => false,
      sendWithFollowUpQuota: async (
        _agent: unknown,
        send: () => Promise<boolean>,
      ) => ((await send()) ? 'sent' : 'skipped'),
    } as unknown as ChatResponderService,
  );
  const module = await Test.createTestingModule({
    controllers: [FollowUpsController],
    providers: [{ provide: FollowUpsService, useValue: service }],
  })
    .overrideGuard(ClerkAuthGuard)
    .useValue({ canActivate: () => true })
    .compile();
  app = module.createNestApplication();
  await app.init();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await socket.stop();
  await db.close();
});

let nextAccount = 0;
async function account() {
  const suffix = String(++nextAccount);
  const owner = await prisma.user.create({
    data: {
      email: `follow-up-${suffix}@example.com`,
      oauthId: `follow-up-${suffix}`,
    },
  });
  const number = await prisma.phoneNumber.create({
    data: {
      phoneNumber: `+1202555010${suffix}`,
      userId: owner.id,
      status: 'connected',
    },
  });
  const agent = await prisma.chatAgent.create({
    data: {
      userId: owner.id,
      phoneNumberId: number.id,
      agentName: 'Orders',
      status: 'active',
    },
  });
  const thread = await prisma.chatConversation.create({
    data: {
      userId: owner.id,
      phoneNumberId: number.id,
      chatAgentId: agent.id,
      peerJid: '111@lid',
      peerName: 'Customer',
    },
  });
  await appendMessage(store, thread.id, 'user', 'Is my order ready?');
  await appendMessage(
    store,
    thread.id,
    'assistant',
    'Would you like to pick it up today?',
  );
  return { userId: owner.id, numberId: number.id, threadId: thread.id };
}

async function due(numberId: string) {
  await prisma.chatFollowUp.update({
    where: { phoneNumberId: numberId },
    data: { nextRunAt: new Date(0) },
  });
  await service['tick']();
}

async function waitForReview(userId: string, numberId: string) {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    const result = await service.get(userId, numberId, 1);
    if (
      result.config?.last_run_at &&
      !result.config.running &&
      !result.config.queued
    )
      return result;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('Review did not finish');
}

beforeEach(() => {
  sendText.mockReset().mockResolvedValue(undefined);
  mockReview.mockReset().mockResolvedValue({
    reason: 'Pickup is still undecided.',
    message: 'Would you still like to pick up the order?',
  });
});

it('saves per-number settings and previews only the owner’s stored conversation without sending', async () => {
  const owner = await account();
  const other = await account();
  const path = `/v1/dashboard/follow-ups/${owner.numberId}`;
  const http = () => request(app.getHttpServer() as never);
  const payload = {
    prompt: settings.prompt,
    interval_hours: settings.intervalHours,
    enabled: false,
  };
  await http().get(path).set('x-test-account', other.userId).expect(404);
  await http()
    .put(path)
    .set('x-test-account', other.userId)
    .send(payload)
    .expect(404);
  await http()
    .put(path)
    .set('x-test-account', owner.userId)
    .send(payload)
    .expect(200);
  await http()
    .post(`${path}/review`)
    .set('x-test-account', owner.userId)
    .expect(202);
  const result = await waitForReview(owner.userId, owner.numberId);
  expect(result.config).toMatchObject({
    interval_hours: 5,
    enabled: false,
    next_run_at: null,
  });
  expect(result.results).toEqual([
    expect.objectContaining({
      conversation_id: owner.threadId,
      status: 'draft',
    }),
  ]);
  expect(sendText).not.toHaveBeenCalled();
});

it('sends on the scheduled number, records the message and prevents repeated or stale follow-ups', async () => {
  const owner = await account();
  await service.save(owner.userId, owner.numberId, {
    ...settings,
    enabled: true,
  });
  await due(owner.numberId);
  expect(sendText).toHaveBeenCalledTimes(1);
  expect(sendText).toHaveBeenCalledWith(
    owner.userId,
    owner.numberId,
    '111@lid',
    'Would you still like to pick up the order?',
  );
  expect(
    await prisma.chatMessage.count({
      where: { conversationId: owner.threadId, role: 'assistant' },
    }),
  ).toBe(2);
  const state = await service.get(owner.userId, owner.numberId, 1);
  expect(state.counts).toEqual({ sent: 1 });
  expect(state.config?.next_run_at?.getTime()).toBeGreaterThan(
    Date.now() + 4 * 3_600_000,
  );

  await due(owner.numberId);
  expect(sendText).toHaveBeenCalledTimes(1);
  expect((await service.get(owner.userId, owner.numberId, 1)).counts).toEqual({
    skipped: 1,
  });

  await appendMessage(
    store,
    owner.threadId,
    'user',
    'Which day can I collect it?',
  );
  mockReview.mockImplementationOnce(async () => {
    await appendMessage(
      store,
      owner.threadId,
      'user',
      'I collected it already. Thanks!',
    );
    return {
      reason: 'Pickup may be undecided.',
      message: 'Would you still like to pick up the order?',
    };
  });
  await due(owner.numberId);
  expect(sendText).toHaveBeenCalledTimes(1);
  expect((await service.get(owner.userId, owner.numberId, 1)).counts).toEqual({
    skipped: 1,
  });
});
