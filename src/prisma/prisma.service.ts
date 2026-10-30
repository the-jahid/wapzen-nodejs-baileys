import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

// Database connections this server opens (pg's default is 10). A reply takes
// ~15–20 round trips, so 100 messages arriving at once queue on the pool;
// with the server in Frankfurt and the database in Ireland (~20ms a trip)
// 10 connections added seconds for the last person. DATABASE_URL is
// Supabase's transaction pooler, which accepts this many clients.
const POOL_SIZE = 30;

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(config: ConfigService) {
    const adapter = new PrismaPg({
      connectionString: config.getOrThrow<string>('DATABASE_URL'),
      max: POOL_SIZE,
    });
    super({ adapter });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
