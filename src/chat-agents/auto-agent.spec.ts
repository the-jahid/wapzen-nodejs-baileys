import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { AUTO_AGENT_NAME, ensureAgentForNumber } from './auto-agent';

jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));

// Linking a number gives it an agent with no naming step. Runs on PGlite with
// the real migrations, because the agent limit and unique number live there.

jest.setTimeout(60_000);

const PORT = 55493;
const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');

let pg: PGlite;
let server: PGLiteSocketServer;
let prisma: PrismaClient;

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
});

afterAll(async () => {
  await prisma?.$disconnect();
  await server?.stop();
  await pg?.close();
});

let n = 0;
async function account(data: Record<string, unknown> = {}) {
  n++;
  return prisma.user.create({
    data: { email: `u${n}@example.com`, oauthId: `user_${n}`, ...data },
  });
}
async function number(userId: string) {
  return prisma.phoneNumber.create({ data: { userId } });
}

it('creates a live agent with the default name for a new account', async () => {
  const user = await account();
  const pn = await number(user.id);
  const r = await ensureAgentForNumber(prisma, user.id, pn.id);
  expect(r.kind).toBe('created');
  const agent = await prisma.chatAgent.findFirstOrThrow({
    where: { userId: user.id },
  });
  expect(agent).toMatchObject({
    agentName: AUTO_AGENT_NAME,
    phoneNumberId: pn.id,
    status: 'active',
  });
});

it('does nothing more for a number that already has an agent', async () => {
  const user = await account();
  const pn = await number(user.id);
  const first = await ensureAgentForNumber(prisma, user.id, pn.id);
  const again = await ensureAgentForNumber(prisma, user.id, pn.id);
  expect(again).toEqual({
    kind: 'existing',
    agentId: 'agentId' in first ? first.agentId : '',
  });
  expect(await prisma.chatAgent.count({ where: { userId: user.id } })).toBe(1);
});

it('gives the number to an agent that has none instead of creating one', async () => {
  const user = await account();
  const old = await prisma.chatAgent.create({
    data: { userId: user.id, agentName: 'Support' },
  });
  const pn = await number(user.id);
  const r = await ensureAgentForNumber(prisma, user.id, pn.id);
  expect(r).toEqual({ kind: 'assigned', agentId: old.id });
  const agent = await prisma.chatAgent.findUniqueOrThrow({
    where: { id: old.id },
  });
  expect(agent).toMatchObject({ phoneNumberId: pn.id, status: 'active' });
  expect(await prisma.chatAgent.count({ where: { userId: user.id } })).toBe(1);
});

it('creates nothing at the agent limit', async () => {
  const user = await account();
  const first = await number(user.id);
  await ensureAgentForNumber(prisma, user.id, first.id);
  const second = await number(user.id);
  expect(await ensureAgentForNumber(prisma, user.id, second.id)).toEqual({
    kind: 'at_limit',
  });
  expect(await prisma.chatAgent.count({ where: { userId: user.id } })).toBe(1);
});

it('numbers the name when the account may have more agents', async () => {
  const user = await account({ maxChatAgents: 2 });
  await ensureAgentForNumber(prisma, user.id, (await number(user.id)).id);
  await ensureAgentForNumber(prisma, user.id, (await number(user.id)).id);
  const names = (
    await prisma.chatAgent.findMany({ where: { userId: user.id } })
  ).map((a) => a.agentName);
  expect(names.sort()).toEqual([AUTO_AGENT_NAME, `${AUTO_AGENT_NAME} 2`]);
});

it('keeps the agent off when the free trial is over', async () => {
  const user = await account({ trialEndedAt: new Date() });
  const pn = await number(user.id);
  await ensureAgentForNumber(prisma, user.id, pn.id);
  const agent = await prisma.chatAgent.findFirstOrThrow({
    where: { userId: user.id },
  });
  expect(agent.status).toBe('inactive');
});
