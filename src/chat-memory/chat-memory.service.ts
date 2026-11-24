import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import type { ChatMemorySaver } from './chat-memory.saver';
import { RamMemorySaver } from './ram-memory.saver';

// The store chat agents' short-term memory is kept in. With CHAT_MEMORY=on it is
// the app's own database, over its own connections. Without it, or when its
// tables couldn't be made ready, it is this process's memory, as before, and
// nothing is created in the database.
@Injectable()
export class ChatMemoryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatMemoryService.name);
  private store: ChatMemorySaver | RamMemorySaver = new RamMemorySaver();
  private isSaved = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  get saver() {
    return this.store;
  }

  // Whether the memory outlives this process.
  get saved() {
    return this.isSaved;
  }

  // Creates the memory tables the first time; never in the way of a start.
  async onModuleInit() {
    if (this.config.get<string>('CHAT_MEMORY') !== 'on') return;
    try {
      // Loaded only when it's on, so a server without it needs no new package.
      const { ChatMemorySaver } = await import('./chat-memory.saver.js');
      const store = new ChatMemorySaver(this.prisma.pool, (message) =>
        this.logger.error(message),
      );
      await store.setup();
      this.store = store;
      this.isSaved = true;
    } catch (err) {
      this.logger.error(
        `chat memory is not available: ${(err as Error).message}`,
      );
    }
  }

  async onModuleDestroy() {
    await this.store.flush();
  }

  // When a conversation is deleted, so is every agent's memory of it. A failure
  // is logged: the conversation is gone either way, and its id is never used
  // again.
  async forget(conversationIds: string[]) {
    await this.store
      .forget(conversationIds)
      .catch((err: Error) =>
        this.logger.error(`forgetting chat memory failed: ${err.message}`),
      );
  }
}
