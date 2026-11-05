import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { usePrismaAuthState } from './auth-state';
import type { ChatResponderService } from './chat-responder.service';
import { WhatsAppService } from './whatsapp.service';

// The real key store and WhatsAppService on a real Postgres (PGlite, in this
// process) with the project's migrations, so the foreign key is the real one.
// Only WhatsApp's socket is a fake.

type FakeSocket = {
  config: { auth: { keys: { set(data: unknown): Promise<void> } } };
  user?: { id: string };
  query: jest.Mock;
  end: jest.Mock;
};

const sockets: FakeSocket[] = [];

// Baileys is ESM-only, which Jest can't load.
jest.mock('baileys', () => {
  const same = (_key: string, value: unknown) => value;
  return {
    __esModule: true,
    default: (config: FakeSocket['config']) => {
      const sock = {
        config,
        ev: new EventEmitter(),
        user: { id: '8801700000000:5@s.whatsapp.net' },
        signalRepository: { lidMapping: {} },
        serverProps: {},
        query: jest.fn().mockResolvedValue({}),
        end: jest.fn(),
      };
      sockets.push(sock);
      return sock;
    },
    Browsers: { macOS: () => ['Mac OS', 'Chrome', '1'] },
    BufferJSON: { replacer: same, reviver: same },
    DisconnectReason: {},
    fetchLatestWaWebVersion: () =>
      Promise.resolve({ version: [2, 3000, 1], isLatest: true }),
    initAuthCreds: () => ({ registered: false }),
    makeCacheableSignalKeyStore: (keys: unknown) => keys,
  };
});
jest.mock('./chat-responder.service', () => ({
  ChatResponderService: class {},
}));
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.setTimeout(60_000);

const PORT = 55443;
const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');
const NEW_KEY = { session: { peer: { any: 'thing' } } };

let pg: PGlite;
let server: PGLiteSocketServer;
let prisma: PrismaClient;
let whatsapp: WhatsAppService;
let n = 0;

type Internals = {
  connect(id: string): Promise<void>;
  logins: Map<string, { paired?: boolean }>;
  stopSocket(id: string): void;
  sockets: Map<string, unknown>;
};
const internals = () => whatsapp as unknown as Internals;

async function number() {
  n += 1;
  const user = await prisma.user.create({
    data: { email: `auth${n}@example.com`, oauthId: `user_auth${n}` },
  });
  const phone = await prisma.phoneNumber.create({ data: { userId: user.id } });
  return { userId: user.id, id: phone.id };
}

async function store(id: string) {
  const onRowGone = jest.fn();
  const auth = await usePrismaAuthState(
    prisma as unknown as PrismaService,
    id,
    onRowGone,
  );
  return { ...auth, onRowGone };
}

async function connected() {
  const { userId, id } = await number();
  await internals().connect(id);
  return { userId, id, sock: sockets[sockets.length - 1] };
}

// What rowGone does afterwards isn't awaited by the write that set it off.
async function settled(until: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!until() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
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
  whatsapp = new WhatsAppService(
    prisma as unknown as PrismaService,
    {} as ChatResponderService,
  );
});

afterAll(async () => {
  await prisma?.$disconnect();
  await server?.stop();
  await pg?.close();
});

describe('the key store', () => {
  it('saves, overwrites and removes keys on a row that exists', async () => {
    const { id } = await number();
    const { state, saveCreds, onRowGone } = await store(id);
    const keysOf = async () =>
      (
        await prisma.whatsAppAuth.findMany({
          where: { phoneNumberId: id },
          select: { key: true, value: true },
          orderBy: { key: 'asc' },
        })
      ).map((row) => [row.key, JSON.parse(row.value) as unknown]);

    await state.keys.set({ session: { a: 1, b: 2 } } as never);
    await state.keys.set({ session: { a: 3, b: null } } as never);
    await saveCreds();
    await saveCreds();

    expect(await keysOf()).toEqual([
      ['creds', { registered: false }],
      ['session-a', 3],
    ]);
    expect(onRowGone).not.toHaveBeenCalled();
  });

  it('reads back the creds it saved', async () => {
    const { id } = await number();
    const first = await store(id);
    first.state.creds.registered = true;
    await first.saveCreds();
    const second = await store(id);
    expect(second.state.creds.registered).toBe(true);
  });

  it('writes nothing and reports it when the row is gone', async () => {
    const { id } = await number();
    const { state, saveCreds, onRowGone } = await store(id);
    await prisma.phoneNumber.delete({ where: { id } });

    await expect(state.keys.set(NEW_KEY as never)).resolves.toBeUndefined();
    await expect(saveCreds()).resolves.toBeUndefined();

    expect(onRowGone).toHaveBeenCalledTimes(2);
    expect(
      await prisma.whatsAppAuth.count({ where: { phoneNumberId: id } }),
    ).toBe(0);
  });

  it('does not mistake a removal with nothing to save for a lost row', async () => {
    const { id } = await number();
    const { state, onRowGone } = await store(id);
    await state.keys.set({ session: { a: null } });
    expect(onRowGone).not.toHaveBeenCalled();
  });
});

describe('a socket whose row is deleted', () => {
  it('is unlinked from the phone and closed when its account was deleted', async () => {
    const { userId, id, sock } = await connected();
    await prisma.user.delete({ where: { id: userId } });

    await sock.config.auth.keys.set(NEW_KEY);
    await settled(() => sock.end.mock.calls.length > 0);

    expect(sock.query).toHaveBeenCalledTimes(1);
    const [iq] = sock.query.mock.calls[0] as [{ content: { tag: string }[] }];
    expect(iq.content[0].tag).toBe('remove-companion-device');
    expect(sock.end).toHaveBeenCalledTimes(1);
    expect(internals().sockets.has(id)).toBe(false);
  });

  it('is unlinked once however many writes were queued', async () => {
    const { id, sock } = await connected();
    await prisma.phoneNumber.delete({ where: { id } });

    await Promise.all(
      Array.from({ length: 5 }, () => sock.config.auth.keys.set(NEW_KEY)),
    );
    await settled(() => sock.end.mock.calls.length > 0);

    expect(sock.query).toHaveBeenCalledTimes(1);
    expect(sock.end).toHaveBeenCalledTimes(1);
  });

  it('leaves other numbers alone', async () => {
    const other = await connected();
    const gone = await connected();
    await prisma.phoneNumber.delete({ where: { id: gone.id } });

    await gone.sock.config.auth.keys.set(NEW_KEY);
    await settled(() => gone.sock.end.mock.calls.length > 0);

    await other.sock.config.auth.keys.set(NEW_KEY);
    await settled(() => false);
    expect(other.sock.query).not.toHaveBeenCalled();
    expect(other.sock.end).not.toHaveBeenCalled();
    expect(internals().sockets.has(other.id)).toBe(true);
  });

  it('has no device to remove if the phone never finished linking', async () => {
    const { id, sock } = await connected();
    internals().logins.set(id, {});
    await prisma.phoneNumber.delete({ where: { id } });

    await sock.config.auth.keys.set(NEW_KEY);
    await settled(() => sock.end.mock.calls.length > 0);

    expect(sock.query).not.toHaveBeenCalled();
    expect(sock.end).toHaveBeenCalledTimes(1);
    expect(internals().logins.has(id)).toBe(false);
  });

  it('removes the device if the phone had linked during a login', async () => {
    const { id, sock } = await connected();
    internals().logins.set(id, { paired: true });
    await prisma.phoneNumber.delete({ where: { id } });

    await sock.config.auth.keys.set(NEW_KEY);
    await settled(() => sock.end.mock.calls.length > 0);

    expect(sock.query).toHaveBeenCalledTimes(1);
  });

  it('does nothing more for work still queued on a closed socket', async () => {
    const { id, sock } = await connected();
    internals().stopSocket(id);
    sock.end.mockClear();
    await prisma.phoneNumber.delete({ where: { id } });

    await expect(sock.config.auth.keys.set(NEW_KEY)).resolves.toBeUndefined();
    await settled(() => false);

    expect(sock.query).not.toHaveBeenCalled();
    expect(sock.end).not.toHaveBeenCalled();
  });
});

describe('a socket whose row is still there', () => {
  it('stays open and linked when it saves keys', async () => {
    const { id, sock } = await connected();

    await sock.config.auth.keys.set(NEW_KEY);
    await settled(() => false);

    expect(sock.query).not.toHaveBeenCalled();
    expect(sock.end).not.toHaveBeenCalled();
    expect(internals().sockets.has(id)).toBe(true);
    expect(
      await prisma.whatsAppAuth.count({ where: { phoneNumberId: id } }),
    ).toBe(1);
  });
});
