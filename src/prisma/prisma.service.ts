import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool, PoolClient } from 'pg';
import { PrismaClient } from '../generated/prisma/client';

// Database connections this server opens (pg's default is 10). A reply takes
// ~15–20 round trips, so 100 messages arriving at once queue on the pool;
// with the server in Frankfurt and the database in Ireland (~20ms a trip)
// 10 connections added seconds for the last person. DATABASE_URL is
// Supabase's transaction pooler, which accepts this many clients.
const POOL_SIZE = 30;

// pg closes a connection after 10s idle, so every burst after a quiet spell
// opened up to 30 new ones at once, each a TLS + SCRAM handshake through
// Supavisor. Those handshakes are what fail: Supavisor answers 08006
// "(EAUTHTIMEOUT) timeout while waiting for message" and every service
// touching the DB in that second fails with it. Warm connections skip the
// handshake, so keep them for 5 minutes.
const IDLE_MS = 5 * 60_000;
const CONNECT_TIMEOUT_MS = 20_000;
const CONNECT_ATTEMPTS = 3;

// A failed connect() never sent a query, so it is always safe to try again.
// pool.query() goes through connect() too, so this covers every statement.
class RetryingPool extends Pool {
  connect(): Promise<PoolClient>;
  connect(
    callback: (
      err: Error | undefined,
      client: PoolClient | undefined,
      done: (release?: unknown) => void,
    ) => void,
  ): void;
  connect(
    callback?: (
      err: Error | undefined,
      client: PoolClient | undefined,
      done: (release?: unknown) => void,
    ) => void,
  ): Promise<PoolClient> | void {
    const result = this.connectWithRetry();
    if (!callback) return result;
    result.then(
      (client) =>
        callback(undefined, client, (err) => client.release(err as Error)),
      (err: Error) => callback(err, undefined, () => {}),
    );
  }

  private async connectWithRetry(): Promise<PoolClient> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await super.connect();
      } catch (err) {
        if (this.ending || attempt >= CONNECT_ATTEMPTS) throw err;
        await new Promise((r) =>
          setTimeout(r, 250 * attempt + Math.random() * 250),
        );
      }
    }
  }
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(config: ConfigService) {
    const pool = new RetryingPool({
      connectionString: config.getOrThrow<string>('DATABASE_URL'),
      max: POOL_SIZE,
      idleTimeoutMillis: IDLE_MS,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      keepAlive: true,
    });
    super({ adapter: new PrismaPg(pool, { disposeExternalPool: true }) });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
