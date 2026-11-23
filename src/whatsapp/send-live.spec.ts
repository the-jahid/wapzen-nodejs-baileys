import type { WASocket } from 'baileys';
import type { PrismaService } from '../prisma/prisma.service';
import type { ChatResponderService } from './chat-responder.service';
import { connectionClosed, WhatsAppService } from './whatsapp.service';

// A reply is written over several seconds; the connection the message came in
// on can drop and reconnect meanwhile. The reply must go out on the new
// connection, not die with the old one. Fake sockets: Baileys is ESM-only and
// Jest can't load it.

jest.mock('baileys', () => ({
  __esModule: true,
  default: () => undefined,
  Browsers: { macOS: () => ['Mac OS', 'Chrome', '1'] },
  DisconnectReason: { connectionClosed: 428 },
}));
jest.mock('./auth-state', () => ({ usePrismaAuthState: jest.fn() }));
jest.mock('./chat-responder.service', () => ({
  ChatResponderService: class {},
}));
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));

const closed = () =>
  Object.assign(new Error('Connection Closed'), {
    output: { statusCode: 428 },
  });

type Internals = {
  sockets: Map<string, WASocket>;
  traces: WeakMap<WASocket, { openedAt?: number }>;
  sendLive<T>(
    id: string,
    arrivedOn: WASocket,
    send: (sock: WASocket) => Promise<T>,
  ): Promise<T>;
};

function fakeSocket(name: string, open = true) {
  return { name, ws: { isOpen: open } } as unknown as WASocket & {
    name: string;
  };
}

function setup() {
  const service = new WhatsAppService(
    {} as PrismaService,
    {} as ChatResponderService,
  ) as unknown as Internals;
  return service;
}

describe('connectionClosed', () => {
  it('is only the error thrown before anything was written', () => {
    expect(connectionClosed(closed())).toBe(true);
    expect(connectionClosed(new Error('Connection Closed'))).toBe(true);
    expect(connectionClosed(new Error('Timed Out'))).toBe(false);
    expect(connectionClosed('Connection Closed')).toBe(false);
  });
});

describe('sendLive', () => {
  afterEach(() => jest.useRealTimers());

  it("sends on the number's current socket, not the one the message came in on", async () => {
    const service = setup();
    const old = fakeSocket('old');
    const now = fakeSocket('now');
    service.sockets.set('n1', now);
    const send = jest.fn((s: WASocket) =>
      Promise.resolve((s as unknown as { name: string }).name),
    );
    await expect(service.sendLive('n1', old, send)).resolves.toBe('now');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('waits for the reconnect and sends again when the connection closed', async () => {
    jest.useFakeTimers();
    const service = setup();
    const dead = fakeSocket('dead', false);
    service.sockets.set('n1', dead);
    const sentOn: string[] = [];
    const send = jest.fn((s: WASocket) => {
      const name = (s as unknown as { name: string }).name;
      sentOn.push(name);
      return name === 'dead' ? Promise.reject(closed()) : Promise.resolve(name);
    });

    const result = service.sendLive('n1', dead, send);
    await jest.advanceTimersByTimeAsync(2_000);
    // The number comes back: a new socket that has opened.
    const fresh = fakeSocket('fresh');
    service.sockets.set('n1', fresh);
    service.traces.set(fresh, { openedAt: Date.now() });
    await jest.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toBe('fresh');
    expect(sentOn).toEqual(['dead', 'fresh']);
  });

  it("doesn't use a new socket until it has opened", async () => {
    jest.useFakeTimers();
    const service = setup();
    const dead = fakeSocket('dead', false);
    service.sockets.set('n1', dead);
    const send = jest.fn((s: WASocket) =>
      (s as unknown as { name: string }).name === 'dead'
        ? Promise.reject(closed())
        : Promise.resolve('fresh'),
    );

    const result = service.sendLive('n1', dead, send);
    const fresh = fakeSocket('fresh');
    service.sockets.set('n1', fresh);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(send).toHaveBeenCalledTimes(1);

    service.traces.set(fresh, { openedAt: Date.now() });
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toBe('fresh');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('gives up with the original error when the number stays down', async () => {
    jest.useFakeTimers();
    const service = setup();
    const dead = fakeSocket('dead', false);
    service.sockets.set('n1', dead);
    const send = jest.fn(() => Promise.reject(closed()));

    const result = service.sendLive('n1', dead, send);
    const settled = expect(result).rejects.toThrow('Connection Closed');
    await jest.advanceTimersByTimeAsync(31_000);
    await settled;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("doesn't resend after other errors, which may have reached WhatsApp", async () => {
    const service = setup();
    const sock = fakeSocket('s');
    service.sockets.set('n1', sock);
    const send = jest.fn(() => Promise.reject(new Error('Timed Out')));
    await expect(service.sendLive('n1', sock, send)).rejects.toThrow(
      'Timed Out',
    );
    expect(send).toHaveBeenCalledTimes(1);
  });
});
