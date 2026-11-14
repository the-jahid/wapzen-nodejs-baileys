import { createConnection, createServer, type Server } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service';

// @nestjs/config is ESM-only, which this Jest can't load; the service only
// needs the class for Nest's DI metadata.
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));

jest.setTimeout(60_000);

const DB_PORT = 55441;
const PROXY_PORT = 55442;

let pg: PGlite;
let db: PGLiteSocketServer;
let proxy: Server;
// How many of the next incoming connections the proxy hangs up on, the way
// Supavisor drops a connection whose handshake timed out.
let dropNext = 0;
let accepted = 0;

function service() {
  const url = `postgresql://postgres:postgres@127.0.0.1:${PROXY_PORT}/postgres?sslmode=disable`;
  return new PrismaService({
    getOrThrow: () => url,
  } as unknown as ConfigService);
}

beforeAll(async () => {
  pg = await PGlite.create();
  db = new PGLiteSocketServer({ db: pg, port: DB_PORT, host: '127.0.0.1' });
  await db.start();
  proxy = createServer((client) => {
    accepted++;
    if (dropNext > 0) {
      dropNext--;
      client.destroy();
      return;
    }
    const upstream = createConnection(DB_PORT, '127.0.0.1');
    client.pipe(upstream).pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  await new Promise<void>((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r));
});

afterAll(async () => {
  await new Promise((r) => proxy?.close(r));
  await db?.stop();
  await pg?.close();
});

beforeEach(() => {
  dropNext = 0;
  accepted = 0;
});

it('retries a connection that fails during the handshake', async () => {
  const prisma = service();
  dropNext = 2;
  const rows = await prisma.$queryRaw<{ n: number }[]>`SELECT 1 AS n`;
  expect(rows).toEqual([{ n: 1 }]);
  expect(accepted).toBe(3);
  await prisma.$disconnect();
});

it('retries the connection a transaction checks out', async () => {
  const prisma = service();
  dropNext = 1;
  const n = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ n: number }[]>`SELECT 2 AS n`;
    return rows[0].n;
  });
  expect(n).toBe(2);
  expect(accepted).toBe(2);
  await prisma.$disconnect();
});

it('gives up after three failed connects', async () => {
  const prisma = service();
  dropNext = 3;
  await expect(prisma.$queryRaw`SELECT 1`).rejects.toThrow();
  expect(accepted).toBe(3);
  await prisma.$disconnect();
});

it('reuses a warm connection instead of reconnecting', async () => {
  const prisma = service();
  await prisma.$queryRaw`SELECT 1`;
  await prisma.$queryRaw`SELECT 1`;
  await prisma.$queryRaw`SELECT 1`;
  expect(accepted).toBe(1);
  await prisma.$disconnect();
});
