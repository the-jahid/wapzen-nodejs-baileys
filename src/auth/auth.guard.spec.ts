import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service';
import { ClerkAuthGuard } from './auth.guard';

// The guard runs before every dashboard request, several a minute for each
// open tab, so it reads the users row once in a while instead of every time.

jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('../activity/activity');
jest.mock('../webhooks/webhooks.service', () => ({
  primaryEmail: () => 'new@example.com',
}));
jest.mock('./clerk', () => ({
  ClerkClient: class {
    // The token is the Clerk user id here; "bad" is one Clerk refuses.
    verifySessionToken(token: string) {
      if (token === 'bad') return Promise.reject(new Error('bad signature'));
      return Promise.resolve(token);
    }
    getUser(id: string) {
      return Promise.resolve({ id });
    }
  },
}));

type Row = {
  id: string;
  oauthId: string;
  email: string;
  blockedAt: Date | null;
};

let rows: Map<string, Row>;
let reads: number;
let guard: ClerkAuthGuard;

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-11-12T10:00:00Z') });
  reads = 0;
  rows = new Map([
    [
      'user_a',
      { id: 'a', oauthId: 'user_a', email: 'a@example.com', blockedAt: null },
    ],
    [
      'user_b',
      { id: 'b', oauthId: 'user_b', email: 'b@example.com', blockedAt: null },
    ],
  ]);
  const prisma = {
    user: {
      findUnique: ({ where }: { where: { oauthId: string } }) => {
        reads += 1;
        const row = rows.get(where.oauthId);
        return Promise.resolve(row ? { ...row } : null);
      },
      upsert: ({ where }: { where: { oauthId: string } }) => {
        const row = {
          id: 'new',
          oauthId: where.oauthId,
          email: 'new@example.com',
          blockedAt: null,
        };
        rows.set(where.oauthId, row);
        return Promise.resolve({ ...row });
      },
    },
  } as unknown as PrismaService;
  const config = { getOrThrow: () => 'sk_test' } as unknown as ConfigService;
  guard = new ClerkAuthGuard(prisma, config);
});

afterEach(() => jest.useRealTimers());

// One request with that token; resolves to the users row the handler would see.
async function request(token: string) {
  const req: { headers: Record<string, string>; user?: Row } = {
    headers: { authorization: `Bearer ${token}` },
  };
  const headers: Record<string, string> = {};
  const context = {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({
        setHeader: (name: string, value: string) => (headers[name] = value),
      }),
    }),
  } as unknown as ExecutionContext;
  await guard.canActivate(context);
  return { user: req.user!, headers };
}

describe('the signed-in user row', () => {
  it('is read once for a run of requests, then again after 30 seconds', async () => {
    expect((await request('user_a')).user.id).toBe('a');
    jest.advanceTimersByTime(15_000);
    expect((await request('user_a')).user.id).toBe('a');
    jest.advanceTimersByTime(14_000);
    expect((await request('user_a')).user.id).toBe('a');
    expect(reads).toBe(1);

    jest.advanceTimersByTime(2_000);
    await request('user_a');
    expect(reads).toBe(2);
  });

  it('is never handed to another user', async () => {
    expect((await request('user_a')).user.id).toBe('a');
    expect((await request('user_b')).user.id).toBe('b');
    expect((await request('user_a')).user.email).toBe('a@example.com');
    expect(reads).toBe(2);
  });

  it('still refuses a token Clerk does not accept, remembered user or not', async () => {
    await request('user_a');
    await expect(request('bad')).rejects.toMatchObject({ status: 401 });
    await expect(request('')).rejects.toMatchObject({ status: 401 });
  });

  it('turns a blocked account away, at the latest 30 seconds after the block', async () => {
    await request('user_a');
    rows.get('user_a')!.blockedAt = new Date();
    jest.advanceTimersByTime(31_000);
    await expect(request('user_a')).rejects.toMatchObject({ status: 403 });
    // And keeps turning it away without a read each time.
    await expect(request('user_a')).rejects.toMatchObject({ status: 403 });
    expect(reads).toBe(2);

    rows.get('user_a')!.blockedAt = null;
    jest.advanceTimersByTime(31_000);
    expect((await request('user_a')).user.id).toBe('a');
  });

  it('creates the row for a first request and remembers it', async () => {
    expect((await request('user_new')).user.id).toBe('new');
    expect((await request('user_new')).user.id).toBe('new');
    expect(reads).toBe(1);
  });
});
