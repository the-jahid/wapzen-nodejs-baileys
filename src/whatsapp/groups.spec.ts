import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { HttpException } from '@nestjs/common';
import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { PrismaPg } from '@prisma/adapter-pg';
import type { ConfigService } from '@nestjs/config';
import { ChatConversationsService } from '../chat-conversations/chat-conversations.service';
import { PrismaClient } from '../generated/prisma/client';
import type { IndexerService } from '../knowledge-bases/indexer.service';
import type { OrdersService } from '../orders/orders.service';
import type { AgentFilesService } from '../agent-files/agent-files.service';
import type { PrismaService } from '../prisma/prisma.service';
import { ChatResponderService } from './chat-responder.service';
import { WhatsAppService } from './whatsapp.service';

// The real WhatsAppService and ChatResponderService on a real Postgres (PGlite,
// in this process) with the project's migrations. Only WhatsApp's socket and
// the model are fakes, so this shows what the server does with a group message,
// not what WhatsApp does with the reply.

type FakeSocket = {
  config: { shouldIgnoreJid: (jid: string) => boolean };
  ev: EventEmitter;
  user: { id: string; lid: string };
  sent: { jid: string; text: string }[];
  fetches: number;
};

const sockets: FakeSocket[] = [];
let waGroups: Record<string, unknown> = {};

// Baileys is ESM-only, which Jest can't load.
jest.mock('baileys', () => {
  const bare = (jid: string) =>
    jid.replace(/:\d+(?=@)/, '').replace('@c.us', '@s.whatsapp.net');
  return {
    __esModule: true,
    default: (config: FakeSocket['config']) => {
      const sock = {
        config,
        ev: new EventEmitter(),
        user: { id: '8801700000000:5@s.whatsapp.net', lid: '999:5@lid' },
        sent: [] as { jid: string; text: string }[],
        fetches: 0,
        signalRepository: { lidMapping: {} },
        serverProps: {},
        sendMessage(jid: string, { text }: { text: string }) {
          sock.sent.push({ jid, text });
          return Promise.resolve();
        },
        sendPresenceUpdate: () => Promise.resolve(),
        groupFetchAllParticipating() {
          sock.fetches += 1;
          return Promise.resolve(waGroups);
        },
        end: () => undefined,
      };
      sockets.push(sock);
      return sock;
    },
    Browsers: { macOS: () => ['Mac OS', 'Chrome', '1'] },
    DisconnectReason: {},
    fetchLatestWaWebVersion: () =>
      Promise.resolve({ version: [2, 3000, 1], isLatest: true }),
    isJidBroadcast: (jid: string) => jid.endsWith('@broadcast'),
    isJidGroup: (jid: string) => jid.endsWith('@g.us'),
    isJidNewsletter: (jid: string) => jid.endsWith('@newsletter'),
    isLidUser: (jid?: string) => !!jid?.endsWith('@lid'),
    isPnUser: (jid?: string) => !!jid?.endsWith('@s.whatsapp.net'),
    jidDecode: (jid?: string) =>
      jid ? { user: bare(jid).split('@')[0] } : undefined,
    jidNormalizedUser: bare,
    makeCacheableSignalKeyStore: (keys: unknown) => keys,
    normalizeMessageContent: (message: unknown) => message ?? undefined,
    toNumber: Number,
  };
});
jest.mock('./auth-state', () => ({
  usePrismaAuthState: () =>
    Promise.resolve({
      state: { creds: {}, keys: {} },
      saveCreds: () => Promise.resolve(),
    }),
}));
// The model: every call is kept, and every call answers the same.
const modelCalls: { prompt: string; messages: BaseMessage[] }[] = [];
jest.mock('./reply-agent', () => ({
  CHAT_REMEMBER_MESSAGES: 40,
  CHAT_SUMMARY_AT: 50,
  isChatSummary: () => false,
  createConfirmationCheck: () => () =>
    Promise.resolve({ confirmed: false, missing: [] }),
  createReplyAgent: () => ({
    invoke: (
      { messages }: { messages: BaseMessage[] },
      { context }: { context: { prompt: string } },
    ) => {
      modelCalls.push({ prompt: context.prompt, messages });
      return Promise.resolve({
        messages: [...messages, new AIMessage('The AI reply')],
      });
    },
  }),
}));
// Neither is used here, and both pull in ESM-only packages.
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('../knowledge-bases/indexer.service', () => ({
  IndexerService: class {},
}));
jest.mock('../orders/orders.service', () => ({ OrdersService: class {} }));
jest.setTimeout(60_000);

const PORT = 55435;
const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');
const GROUP = '120363000000000001@g.us';
const OTHER_GROUP = '120363000000000002@g.us';
const ADMINS_ONLY = '120363000000000003@g.us';
const ADMINS_ONLY_MINE = '120363000000000004@g.us';
const COMMUNITY = '120363000000000005@g.us';

let pg: PGlite;
let server: PGLiteSocketServer;
let prisma: PrismaClient;
let responder: ChatResponderService;
let whatsapp: WhatsAppService;
let n = 0;

function group(id: string, subject: string, extra = {}) {
  return {
    id,
    subject,
    size: 3,
    participants: [{ id: '111@lid', admin: 'admin' }, { id: '999@lid' }],
    ...extra,
  };
}

// A linked number with an open socket and an active agent.
async function linkedNumber() {
  n += 1;
  const user = await prisma.user.create({
    data: { email: `group${n}@example.com`, oauthId: `user_group${n}` },
  });
  const phone = await prisma.phoneNumber.create({
    data: {
      userId: user.id,
      phoneNumber: `+880190000${n}`,
      waJid: `880190000${n}:5@s.whatsapp.net`,
      status: 'connected',
    },
  });
  await prisma.chatAgent.create({
    data: {
      userId: user.id,
      agentName: 'Sales',
      phoneNumberId: phone.id,
      status: 'active',
    },
  });
  const sock = await connect(phone.id);
  return { userId: user.id, id: phone.id, sock };
}

async function connect(id: string) {
  await (whatsapp as unknown as { connect(id: string): Promise<void> }).connect(
    id,
  );
  return sockets[sockets.length - 1];
}

let messageId = 0;

// A message as Baileys hands it over; sent an instant ago unless told otherwise.
function incoming(
  sock: FakeSocket,
  jid: string,
  message: unknown,
  extra: Record<string, unknown> = {},
) {
  messageId += 1;
  sock.ev.emit('messages.upsert', {
    messages: [
      {
        key: { remoteJid: jid, id: `MSG${messageId}`, fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        pushName: 'Rahim',
        message,
        ...extra,
      },
    ],
  });
}

function tagged(text: string, jid = '8801700000000@s.whatsapp.net') {
  return {
    extendedTextMessage: { text, contextInfo: { mentionedJid: [jid] } },
  };
}

// Waits out the wait for more messages from the same person.
async function repliesOn(sock: FakeSocket, count = 1) {
  const deadline = Date.now() + 15_000;
  while (sock.sent.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // A later reply or save would land about now.
  await new Promise((resolve) => setTimeout(resolve, 200));
  return sock.sent;
}

function threadOf(id: string, jid: string) {
  return prisma.chatConversation.findFirst({
    where: { phoneNumberId: id, peerJid: jid },
    include: { messages: { orderBy: { seq: 'asc' } } },
  });
}

function agentOn(id: string) {
  return prisma.chatAgent.findFirstOrThrow({ where: { phoneNumberId: id } });
}

// Puts the agent part way through its group hour, without waiting for it. Set
// with the database's clock, as the claim does: a JS Date reaches a session in
// another time zone hours off.
function spendGroupHour(id: string, count: number, minutesAgo = 0) {
  return prisma.$executeRaw`
    UPDATE chat_agents SET
      group_hourly_reply_count = ${count}::int,
      group_hourly_window_started_at =
        now() - ${minutesAgo}::int * interval '1 minute'
    WHERE phone_number_id = ${id}`;
}

// The HTTP status a call fails with, or 0 if it doesn't.
function statusOf(call: Promise<unknown>) {
  return call.then(
    () => 0,
    (err: unknown) => (err instanceof HttpException ? err.getStatus() : -1),
  );
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
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
      max: 1,
    }),
  });
  responder = new ChatResponderService(
    prisma as unknown as PrismaService,
    { get: () => 'test-key' } as unknown as ConfigService,
    { enabled: false } as unknown as IndexerService,
    {} as unknown as OrdersService,
    { listForReply: () => Promise.resolve([]) } as unknown as AgentFilesService,
  );
  whatsapp = new WhatsAppService(prisma as unknown as PrismaService, responder);
  waGroups = {
    [GROUP]: group(GROUP, 'Dhaka customers'),
    [OTHER_GROUP]: group(OTHER_GROUP, 'Another group'),
    [ADMINS_ONLY]: group(ADMINS_ONLY, 'Announcements', { announce: true }),
    [ADMINS_ONLY_MINE]: group(ADMINS_ONLY_MINE, 'Our news', {
      announce: true,
      participants: [{ id: '999@lid', admin: 'admin' }],
    }),
    [COMMUNITY]: group(COMMUNITY, 'A community', { isCommunity: true }),
  };
});

afterAll(async () => {
  await prisma?.$disconnect();
  await server?.stop();
  await pg?.close();
});

beforeEach(() => {
  modelCalls.length = 0;
});

describe('the switch', () => {
  it('starts off in every group, and the socket ignores them all', async () => {
    const { userId, id, sock } = await linkedNumber();
    const { groups, chat_agent } = await whatsapp.listGroups(userId, id);

    expect(chat_agent).toMatchObject({ name: 'Sales', status: 'active' });
    expect(groups.map((g) => g.name)).toEqual([
      'Announcements',
      'Another group',
      'Dhaka customers',
      'Our news',
    ]);
    expect(groups.every((g) => !g.ai_enabled)).toBe(true);
    for (const g of groups) {
      expect(sock.config.shouldIgnoreJid(g.jid)).toBe(true);
    }
  });

  it('opens only the group switched on, and shuts it again', async () => {
    const { userId, id, sock } = await linkedNumber();
    const ignored = sock.config.shouldIgnoreJid;

    await expect(whatsapp.setGroupAi(userId, id, GROUP, true)).resolves.toEqual(
      { jid: GROUP, ai_enabled: true },
    );
    expect(ignored(GROUP)).toBe(false);
    expect(ignored(OTHER_GROUP)).toBe(true);
    const { groups } = await whatsapp.listGroups(userId, id);
    expect(groups.filter((g) => g.ai_enabled).map((g) => g.jid)).toEqual([
      GROUP,
    ]);

    await whatsapp.setGroupAi(userId, id, GROUP, false);
    expect(ignored(GROUP)).toBe(true);
    await expect(
      prisma.aiGroup.count({ where: { phoneNumberId: id } }),
    ).resolves.toBe(0);
  });

  it('leaves private chats, status and channels as they were', async () => {
    const { sock } = await linkedNumber();
    const ignored = sock.config.shouldIgnoreJid;
    expect(ignored('8801711111111@s.whatsapp.net')).toBe(false);
    expect(ignored('12345@lid')).toBe(false);
    expect(ignored('status@broadcast')).toBe(true);
    expect(ignored('12345@newsletter')).toBe(true);
  });

  it('stays on after the number reconnects', async () => {
    const { userId, id } = await linkedNumber();
    await whatsapp.setGroupAi(userId, id, GROUP, true);
    const next = await connect(id);
    expect(next.config.shouldIgnoreJid(GROUP)).toBe(false);
    expect(next.config.shouldIgnoreJid(OTHER_GROUP)).toBe(true);
  });

  it("can't be switched on where the AI couldn't reply", async () => {
    const { userId, id, sock } = await linkedNumber();
    const { groups } = await whatsapp.listGroups(userId, id);
    const canSend = (jid: string) =>
      groups.find((g) => g.jid === jid)?.can_send;
    expect(canSend(ADMINS_ONLY)).toBe(false);
    expect(canSend(ADMINS_ONLY_MINE)).toBe(true);

    expect(
      await statusOf(whatsapp.setGroupAi(userId, id, ADMINS_ONLY, true)),
    ).toBe(409);
    expect(
      await statusOf(whatsapp.setGroupAi(userId, id, '99999@g.us', true)),
    ).toBe(404);
    expect(sock.config.shouldIgnoreJid(ADMINS_ONLY)).toBe(true);
  });

  it("doesn't touch someone else's number", async () => {
    const mine = await linkedNumber();
    const theirs = await linkedNumber();
    expect(
      await statusOf(whatsapp.setGroupAi(mine.userId, theirs.id, GROUP, true)),
    ).toBe(404);
    expect(await statusOf(whatsapp.listGroups(mine.userId, theirs.id))).toBe(
      404,
    );
    expect(theirs.sock.config.shouldIgnoreJid(GROUP)).toBe(true);
  });

  it('needs the number online to go on, but not to go off', async () => {
    const { userId, id } = await linkedNumber();
    await whatsapp.setGroupAi(userId, id, GROUP, true);
    await prisma.phoneNumber.update({
      where: { id },
      data: { status: 'disconnected' },
    });
    expect(await statusOf(whatsapp.listGroups(userId, id))).toBe(409);
    expect(
      await statusOf(whatsapp.setGroupAi(userId, id, OTHER_GROUP, true)),
    ).toBe(409);
    await expect(
      whatsapp.setGroupAi(userId, id, GROUP, false),
    ).resolves.toMatchObject({ ai_enabled: false });
  });

  it('asks WhatsApp once, however many groups go on in a row', async () => {
    const { userId, id, sock } = await linkedNumber();
    await whatsapp.listGroups(userId, id);
    await whatsapp.setGroupAi(userId, id, GROUP, true);
    await whatsapp.setGroupAi(userId, id, OTHER_GROUP, true);
    await whatsapp.listGroups(userId, id);
    expect(sock.fetches).toBe(1);
  });
});

describe('messages in a group', () => {
  it('answers nothing in a group that is off, even when tagged', async () => {
    const { id, sock } = await linkedNumber();
    const respond = jest.spyOn(responder, 'respond');
    incoming(sock, GROUP, tagged('@8801700000000 price?'), {
      key: { remoteJid: GROUP, id: 'OFF1', fromMe: false },
    });
    expect(respond).not.toHaveBeenCalled();
    respond.mockRestore();
    await expect(threadOf(id, GROUP)).resolves.toBeNull();
  });

  it("ignores and does not save what isn't for this number", async () => {
    const { userId, id, sock } = await linkedNumber();
    await whatsapp.setGroupAi(userId, id, GROUP, true);
    const respond = jest.spyOn(responder, 'respond');
    incoming(sock, GROUP, { conversation: 'Good morning everyone' });
    incoming(sock, GROUP, tagged('@222 are you there?', '222@lid'));
    incoming(sock, GROUP, {
      extendedTextMessage: {
        text: 'I agree',
        contextInfo: {
          participant: '222@lid',
          quotedMessage: { conversation: 'Shall we meet?' },
        },
      },
    });
    expect(respond).not.toHaveBeenCalled();
    respond.mockRestore();
    await expect(threadOf(id, GROUP)).resolves.toBeNull();
  });

  it('answers a tag in the group, saying who wrote it', async () => {
    const { userId, id, sock } = await linkedNumber();
    await whatsapp.setGroupAi(userId, id, GROUP, true);
    incoming(sock, GROUP, tagged('@8801700000000 what is the price?'));

    expect(await repliesOn(sock)).toEqual([
      { jid: GROUP, text: 'The AI reply' },
    ]);
    const [call] = modelCalls;
    expect(call.prompt).toContain('This chat is a WhatsApp group.');
    expect(call.messages.at(-1)?.text).toBe('Rahim: what is the price?');

    const thread = await threadOf(id, GROUP);
    expect(thread?.peerName).toBe('Dhaka customers');
    expect(thread?.peerPhone).toBeNull();
    expect(thread?.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Rahim: what is the price?'],
      ['assistant', 'The AI reply'],
    ]);
  });

  it('answers a tag by "@lid" too', async () => {
    const { userId, id, sock } = await linkedNumber();
    await whatsapp.setGroupAi(userId, id, GROUP, true);
    incoming(sock, GROUP, tagged('@999 hello', '999@lid'));
    await repliesOn(sock);
    expect(sock.sent).toHaveLength(1);
    expect(modelCalls[0].messages.at(-1)?.text).toBe('Rahim: hello');
  });

  it('answers a reply to its own message, without the quote', async () => {
    const { userId, id, sock } = await linkedNumber();
    await whatsapp.setGroupAi(userId, id, GROUP, true);
    incoming(sock, GROUP, {
      extendedTextMessage: {
        text: 'and in blue?',
        contextInfo: {
          participant: '999@lid',
          quotedMessage: { conversation: 'The AI said this' },
        },
      },
    });
    await repliesOn(sock);
    expect(modelCalls[0].messages.at(-1)?.text).toBe('Rahim: and in blue?');
  });

  it("reads the question it's tagged under", async () => {
    const { userId, id, sock } = await linkedNumber();
    await whatsapp.setGroupAi(userId, id, GROUP, true);
    incoming(sock, GROUP, {
      extendedTextMessage: {
        text: '@8801700000000',
        contextInfo: {
          mentionedJid: ['8801700000000@s.whatsapp.net'],
          participant: '222@lid',
          quotedMessage: { conversation: 'Do you deliver to Sylhet?' },
        },
      },
    });
    await repliesOn(sock);
    expect(modelCalls[0].messages.at(-1)?.text).toBe(
      'Rahim: @8801700000000\n(Replying to: "Do you deliver to Sylhet?")',
    );
  });

  it('ignores what the owner writes there from the phone', async () => {
    const { userId, id, sock } = await linkedNumber();
    await whatsapp.setGroupAi(userId, id, GROUP, true);
    const respond = jest.spyOn(responder, 'respond');
    incoming(sock, GROUP, tagged('@8801700000000 hi'), {
      key: { remoteJid: GROUP, id: 'MINE1', fromMe: true },
    });
    expect(respond).not.toHaveBeenCalled();
    respond.mockRestore();
    await expect(threadOf(id, GROUP)).resolves.toBeNull();
  });

  it('skips a message that waited too long', async () => {
    const { userId, id, sock } = await linkedNumber();
    await whatsapp.setGroupAi(userId, id, GROUP, true);
    const respond = jest.spyOn(responder, 'respond');
    incoming(sock, GROUP, tagged('@8801700000000 hi'), {
      messageTimestamp: Math.floor(Date.now() / 1000) - 3600,
    });
    expect(respond).not.toHaveBeenCalled();
    respond.mockRestore();
  });

  it('keeps quiet when switched off while a message waits', async () => {
    const { userId, id, sock } = await linkedNumber();
    await whatsapp.setGroupAi(userId, id, GROUP, true);
    incoming(sock, GROUP, tagged('@8801700000000 hi'));
    await whatsapp.setGroupAi(userId, id, GROUP, false);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(sock.sent).toEqual([]);
    await expect(threadOf(id, GROUP)).resolves.toBeNull();
  });

  it('counts against the agent like any other reply', async () => {
    const { userId, id, sock } = await linkedNumber();
    await whatsapp.setGroupAi(userId, id, GROUP, true);
    incoming(sock, GROUP, tagged('@8801700000000 hi'));
    await repliesOn(sock);
    const agent = await prisma.chatAgent.findFirstOrThrow({
      where: { phoneNumberId: id },
    });
    expect(agent.hourlyReplyCount).toBe(1);
    expect(agent.groupHourlyReplyCount).toBe(1);
  });

  it('counts a private reply against the hour only, not the group hour', async () => {
    const { id, sock } = await linkedNumber();
    incoming(sock, '8801711111111@s.whatsapp.net', { conversation: 'hello' });
    await repliesOn(sock);
    const agent = await agentOn(id);
    expect(agent.hourlyReplyCount).toBe(1);
    expect(agent.groupHourlyReplyCount).toBe(0);
    expect(agent.groupHourlyWindowStartedAt).toBeNull();
  });

  it('stops at 50 replies an hour across all groups, keeping the messages', async () => {
    const { userId, id, sock } = await linkedNumber();
    await whatsapp.setGroupAi(userId, id, GROUP, true);
    await whatsapp.setGroupAi(userId, id, OTHER_GROUP, true);
    await spendGroupHour(id, 49);

    // The 50th, in one group, still goes out.
    incoming(sock, GROUP, tagged('@8801700000000 last one'));
    await repliesOn(sock);
    expect(sock.sent).toHaveLength(1);
    expect((await agentOn(id)).groupHourlyReplyCount).toBe(50);

    // The 51st gets no model call and no reply, in that group or another.
    modelCalls.length = 0;
    incoming(sock, GROUP, tagged('@8801700000000 one more'));
    incoming(sock, OTHER_GROUP, tagged('@8801700000000 me too'));
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(sock.sent).toHaveLength(1);
    expect(modelCalls).toHaveLength(0);
    const agent = await agentOn(id);
    expect(agent.groupHourlyReplyCount).toBe(50);
    expect(agent.status).toBe('active');
    const thread = await threadOf(id, GROUP);
    expect(thread?.messages.at(-1)?.content).toBe('Rahim: one more');
  });

  it('keeps answering private chats at the group limit', async () => {
    const { userId, id, sock } = await linkedNumber();
    await whatsapp.setGroupAi(userId, id, GROUP, true);
    await spendGroupHour(id, 50);
    const contact = '8801711111111@s.whatsapp.net';
    incoming(sock, contact, { conversation: 'hello' });
    expect(await repliesOn(sock)).toEqual([
      { jid: contact, text: 'The AI reply' },
    ]);
    expect((await agentOn(id)).groupHourlyReplyCount).toBe(50);
  });

  it('answers in groups again once the hour is up', async () => {
    const { userId, id, sock } = await linkedNumber();
    await whatsapp.setGroupAi(userId, id, GROUP, true);
    await spendGroupHour(id, 50, 59);
    incoming(sock, GROUP, tagged('@8801700000000 hi'));
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(sock.sent).toEqual([]);

    await spendGroupHour(id, 50, 61);
    incoming(sock, GROUP, tagged('@8801700000000 hi again'));
    await repliesOn(sock);
    expect(sock.sent).toHaveLength(1);
    expect((await agentOn(id)).groupHourlyReplyCount).toBe(1);
  });

  it('stays quiet in groups at the overall limit too', async () => {
    const { userId, id, sock } = await linkedNumber();
    await whatsapp.setGroupAi(userId, id, GROUP, true);
    await prisma.$executeRaw`
      UPDATE chat_agents SET
        hourly_reply_count = 100, hourly_window_started_at = now()
      WHERE phone_number_id = ${id}`;
    incoming(sock, GROUP, tagged('@8801700000000 hi'));
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(sock.sent).toEqual([]);
    expect((await agentOn(id)).groupHourlyReplyCount).toBe(0);
  });

  it('hands the reply back to both counts when none goes out', async () => {
    const { userId, id, sock } = await linkedNumber();
    await whatsapp.setGroupAi(userId, id, GROUP, true);
    const failing = jest
      .spyOn(sock, 'sendMessage' as never)
      .mockRejectedValue(new Error('offline') as never);
    incoming(sock, GROUP, tagged('@8801700000000 hi'));
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    failing.mockRestore();
    const agent = await agentOn(id);
    expect(agent.hourlyReplyCount).toBe(0);
    expect(agent.groupHourlyReplyCount).toBe(0);
  });

  it('takes no orders in a group', async () => {
    const { userId, id, sock } = await linkedNumber();
    await prisma.chatAgent.updateMany({
      where: { phoneNumberId: id },
      data: { orderEnabled: true },
    });
    const ordersFor = jest.spyOn(
      responder as unknown as { ordersFor(...args: unknown[]): unknown },
      'ordersFor',
    );
    await whatsapp.setGroupAi(userId, id, GROUP, true);
    incoming(sock, GROUP, tagged('@8801700000000 I want to order'));
    await repliesOn(sock);
    await expect(ordersFor.mock.results[0].value).resolves.toBeUndefined();
    ordersFor.mockRestore();
  });
});

describe('private chats', () => {
  it('still answers every message, with no group note', async () => {
    const { id, sock } = await linkedNumber();
    const contact = '8801711111111@s.whatsapp.net';
    incoming(sock, contact, { conversation: 'hello' });
    expect(await repliesOn(sock)).toEqual([
      { jid: contact, text: 'The AI reply' },
    ]);
    expect(modelCalls[0].prompt).not.toContain('WhatsApp group');
    expect(modelCalls[0].messages.at(-1)?.text).toBe('hello');
    const thread = await threadOf(id, contact);
    expect(thread?.peerName).toBe('Rahim');
  });
});

describe("a group's thread in Conversations", () => {
  function conversations() {
    return new ChatConversationsService(
      prisma as unknown as PrismaService,
      whatsapp,
      responder,
    );
  }

  it('switches the group itself, and the Groups page follows', async () => {
    const { userId, id, sock } = await linkedNumber();
    await whatsapp.setGroupAi(userId, id, GROUP, true);
    incoming(sock, GROUP, tagged('@8801700000000 hi'));
    await repliesOn(sock);
    const thread = await threadOf(id, GROUP);

    await conversations().update(userId, thread!.id, { aiReplyEnabled: false });
    expect(sock.config.shouldIgnoreJid(GROUP)).toBe(true);
    let { groups } = await whatsapp.listGroups(userId, id);
    expect(groups.find((g) => g.jid === GROUP)?.ai_enabled).toBe(false);

    await conversations().update(userId, thread!.id, { aiReplyEnabled: true });
    expect(sock.config.shouldIgnoreJid(GROUP)).toBe(false);
    ({ groups } = await whatsapp.listGroups(userId, id));
    expect(groups.find((g) => g.jid === GROUP)?.ai_enabled).toBe(true);
  });

  it('follows the Groups page', async () => {
    const { userId, id, sock } = await linkedNumber();
    await whatsapp.setGroupAi(userId, id, GROUP, true);
    incoming(sock, GROUP, tagged('@8801700000000 hi'));
    await repliesOn(sock);

    await whatsapp.setGroupAi(userId, id, GROUP, false);
    expect((await threadOf(id, GROUP))?.aiReplyEnabled).toBe(false);
    await whatsapp.setGroupAi(userId, id, GROUP, true);
    expect((await threadOf(id, GROUP))?.aiReplyEnabled).toBe(true);
  });

  it("leaves a private contact's switch to itself", async () => {
    const { userId, id, sock } = await linkedNumber();
    const contact = '8801711111111@s.whatsapp.net';
    const setGroupAi = jest.spyOn(whatsapp, 'setGroupAi');
    incoming(sock, contact, { conversation: 'hello' });
    await repliesOn(sock);
    const thread = await threadOf(id, contact);
    await conversations().update(userId, thread!.id, { aiReplyEnabled: false });
    expect(setGroupAi).not.toHaveBeenCalled();
    setGroupAi.mockRestore();
    expect((await threadOf(id, contact))?.aiReplyEnabled).toBe(false);
  });
});
