import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { BaseMessage } from '@langchain/core/messages';
import type { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import type { AgentFilesService } from '../agent-files/agent-files.service';
import { ChatConversationsService } from '../chat-conversations/chat-conversations.service';
import { PrismaClient } from '../generated/prisma/client';
import type { IndexerService } from '../knowledge-bases/indexer.service';
import type { OrdersService } from '../orders/orders.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  ChatResponderService,
  type IncomingChat,
} from './chat-responder.service';
import type { WhatsAppService } from './whatsapp.service';

// What an agent remembers of a chat, on a real Postgres (PGlite) with the
// project's migrations. Only the model and WhatsApp are fakes.

const modelCalls: BaseMessage[][] = [];
jest.mock('./reply-language', () => ({
  ...jest.requireActual<object>('./reply-language'),
  createLanguageGuard: () => ({
    languageOf: () => Promise.resolve(''),
    customerLanguageOf: () => Promise.resolve(''),
    inLanguage: (text: string) => Promise.resolve({ text, rewritten: false }),
  }),
}));
jest.mock('./reply-agent', () => ({
  CHAT_REMEMBER_MESSAGES: 40,
  CHAT_TRANSCRIPT_MESSAGES: 60,
  createReplyAgent: () => ({
    invoke: ({ messages }: { messages: BaseMessage[] }) => {
      modelCalls.push(messages);
      return Promise.resolve({ reply: 'The AI reply' });
    },
  }),
}));
// None is used here, and they pull in ESM-only packages.
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('./whatsapp.service', () => ({
  WhatsAppService: class {},
  NumberNotConnectedError: class extends Error {},
}));
jest.mock('../knowledge-bases/indexer.service', () => ({
  IndexerService: class {},
}));
jest.mock('../orders/orders.service', () => ({ OrdersService: class {} }));
jest.setTimeout(60_000);

const PORT = 55447;
const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');
const BACKFILL = '20261124000001_backfill_chat_message_agent';
const PEER = '111@lid';

let pg: PGlite;
let server: PGLiteSocketServer;
let prisma: PrismaClient;
let n = 0;

const sql = (name: string) =>
  readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8');

// A server process: nothing in memory yet.
function boot() {
  return new ChatResponderService(
    prisma as unknown as PrismaService,
    { get: () => 'test-key' } as unknown as ConfigService,
    { enabled: false } as unknown as IndexerService,
    {} as unknown as OrdersService,
    { listForReply: () => Promise.resolve([]) } as unknown as AgentFilesService,
  );
}

// The customer writes; returns what the model was given, oldest first.
async function write(
  responder: ChatResponderService,
  phoneNumberId: string,
  text: string,
) {
  n += 1;
  const chat: IncomingChat = {
    phoneNumberId,
    peerJid: PEER,
    messageId: `M${n}`,
    text,
    send: () => Promise.resolve(),
    sendFile: () => Promise.resolve(),
    setTyping: () => Promise.resolve(),
  };
  await (
    responder as unknown as { answer(c: IncomingChat[]): Promise<void> }
  ).answer([chat]);
  return modelCalls[modelCalls.length - 1].map((m) => m.text);
}

async function linkedNumber() {
  n += 1;
  const user = await prisma.user.create({
    data: { email: `memory${n}@example.com`, oauthId: `user_memory${n}` },
  });
  const phone = await prisma.phoneNumber.create({
    data: {
      userId: user.id,
      phoneNumber: `+88019000${n}`,
      waJid: `88019000${n}:5@s.whatsapp.net`,
      status: 'connected',
    },
  });
  return { userId: user.id, phoneId: phone.id };
}

const newAgent = (userId: string, phoneNumberId: string, agentName: string) =>
  prisma.chatAgent.create({
    data: { userId, agentName, phoneNumberId, status: 'active' },
  });

const unplug = (id: string) =>
  prisma.chatAgent.update({
    where: { id },
    data: { phoneNumberId: null, status: 'inactive' },
  });

const plug = (id: string, phoneNumberId: string) =>
  prisma.chatAgent.update({
    where: { id },
    data: { phoneNumberId, status: 'active' },
  });

const threadOn = (phoneNumberId: string) =>
  prisma.chatConversation.findFirstOrThrow({
    where: { phoneNumberId, peerJid: PEER },
  });

beforeAll(async () => {
  pg = await PGlite.create();
  // As on the server: Prisma sends times as UTC without saying so.
  await pg.exec(
    "ALTER DATABASE postgres SET timezone TO 'UTC'; SET timezone TO 'UTC'",
  );
  const names = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of names) await pg.exec(sql(name));
  server = new PGLiteSocketServer({ db: pg, port: PORT, host: '127.0.0.1' });
  await server.start();
  prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
      max: 1,
    }),
  });
});

afterAll(async () => {
  await prisma?.$disconnect();
  await server?.stop();
  await pg?.close();
});

describe('what an agent remembers', () => {
  it('nothing a deleted agent said on the number, only its own chat', async () => {
    const { userId, phoneId } = await linkedNumber();
    const old = await newAgent(userId, phoneId, 'Pizza');
    const responder = boot();
    await write(responder, phoneId, 'a pizza please');
    await prisma.chatAgent.delete({ where: { id: old.id } });

    await newAgent(userId, phoneId, 'Dentist');
    expect(await write(responder, phoneId, 'hello')).toEqual(['hello']);
    // Nor after a restart, which reloads the saved messages.
    expect(await write(boot(), phoneId, 'again')).toEqual([
      'hello',
      'The AI reply',
      'again',
    ]);
    // The owner's record of the thread still has everything.
    expect((await threadOn(phoneId)).messageCount).toBe(6);
  });

  it('its own chat each, when two agents take turns on a number', async () => {
    const { userId, phoneId } = await linkedNumber();
    // Both existed before any message.
    const second = await newAgent(userId, phoneId, 'Second');
    await unplug(second.id);
    const first = await newAgent(userId, phoneId, 'First');
    await write(boot(), phoneId, 'to the first');
    await unplug(first.id);
    await plug(second.id, phoneId);
    expect(await write(boot(), phoneId, 'to the second')).toEqual([
      'to the second',
    ]);
    await unplug(second.id);
    await plug(first.id, phoneId);
    expect(await write(boot(), phoneId, 'back')).toEqual([
      'to the first',
      'The AI reply',
      'back',
    ]);
  });

  it('what the owner sends while it is the one on the number', async () => {
    const { userId, phoneId } = await linkedNumber();
    const old = await newAgent(userId, phoneId, 'Old');
    await write(boot(), phoneId, 'before');
    await unplug(old.id);
    const now = await newAgent(userId, phoneId, 'Now');

    const responder = boot();
    const dashboard = new ChatConversationsService(
      prisma as unknown as PrismaService,
      { sendText: () => Promise.resolve() } as unknown as WhatsAppService,
    );
    const thread = await threadOn(phoneId);
    await dashboard.send(userId, thread.id, 'from the dashboard');
    await responder.personSent({
      phoneNumberId: phoneId,
      peerJids: [PEER],
      peerJid: PEER,
      messageId: `P${n}`,
      text: 'from the phone',
    });
    const saved = await prisma.chatMessage.findMany({
      where: { conversationId: thread.id },
      orderBy: { seq: 'asc' },
      select: { content: true, chatAgentId: true },
    });
    expect(saved.map((m) => [m.content, m.chatAgentId])).toEqual([
      ['before', old.id],
      ['The AI reply', old.id],
      ['from the dashboard', now.id],
      ['from the phone', now.id],
    ]);
  });

  it('older messages from its own time, once they are backfilled', async () => {
    const { userId, phoneId } = await linkedNumber();
    const old = await newAgent(userId, phoneId, 'Old');
    await write(boot(), phoneId, 'before');
    await prisma.chatAgent.delete({ where: { id: old.id } });
    await newAgent(userId, phoneId, 'Now');
    await write(boot(), phoneId, 'since');

    // As they were saved before the column existed.
    await prisma.$executeRaw`UPDATE chat_messages SET chat_agent_id = NULL`;
    await prisma.$executeRawUnsafe(sql(BACKFILL));
    expect(await write(boot(), phoneId, 'now')).toEqual([
      'since',
      'The AI reply',
      'now',
    ]);
  });
});
