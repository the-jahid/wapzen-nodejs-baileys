import type { RunnableConfig } from '@langchain/core/runnables';
import type { CheckpointTuple } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { Pool } from 'pg';

// The memory tables live in their own Postgres schema: LangGraph owns and
// migrates them (setup()), and Prisma, which only looks at public, never sees
// them.
export const MEMORY_SCHEMA = 'chat_memory';

const JUST_READ_MS = 1_000;
const MAX_JUST_READ = 200;

const TABLES = ['checkpoints', 'checkpoint_blobs', 'checkpoint_writes'];

const threadOf = (config: RunnableConfig) =>
  String(config.configurable?.thread_id ?? '');

// LangGraph's Postgres checkpointer, made safe for a reply path:
// - Saving never delays or fails a reply. It runs behind it, and the chat's next
//   read waits for it. A lost save costs nothing: the thread catches up from
//   chat_messages on the next message.
// - A failed read answers from chat_messages alone, and that run isn't saved
//   over the memory it couldn't read.
// - Only a thread's newest checkpoint is kept. Every one holds the whole chat,
//   and nothing here goes back in time.
// With strict on, reads and saves wait and throw instead: for the migration,
// which has to know what was really there and really saved.
export class ChatMemorySaver extends PostgresSaver {
  private readonly saving = new Map<string, Promise<unknown>>();
  private readonly unread = new Set<string>();
  // createAgent reads a thread twice as a run starts. The second read takes what
  // the first one got instead of asking the database again.
  private readonly justRead = new Map<
    string,
    { at: number; tuple: CheckpointTuple | undefined }
  >();
  private readonly tables: string[];

  constructor(
    private readonly db: Pool,
    private readonly log: (message: string) => void = () => undefined,
    schema = MEMORY_SCHEMA,
    private readonly strict = false,
  ) {
    super(db, undefined, { schema });
    this.tables = TABLES.map((table) => `"${schema}".${table}`);
  }

  async getTuple(config: RunnableConfig) {
    const thread = threadOf(config);
    await this.saving.get(thread);
    const read = this.justRead.get(thread);
    this.justRead.delete(thread);
    if (read && Date.now() - read.at < JUST_READ_MS) return read.tuple;
    try {
      const tuple = await super.getTuple(config);
      this.unread.delete(thread);
      if (!this.strict) this.keepRead(thread, tuple);
      return tuple;
    } catch (err) {
      if (this.strict) throw err;
      this.unread.add(thread);
      this.log(`reading chat memory ${thread}: ${(err as Error).message}`);
      return undefined;
    }
  }

  async put(...args: Parameters<PostgresSaver['put']>) {
    const [config, checkpoint] = args;
    const thread = threadOf(config);
    const next = {
      configurable: {
        thread_id: thread,
        checkpoint_ns: (config.configurable?.checkpoint_ns as string) ?? '',
        checkpoint_id: checkpoint.id,
      },
    };
    this.justRead.delete(thread);
    if (this.strict) {
      await super.put(...args);
      await this.dropOlder(next.configurable);
      return next;
    }
    if (this.unread.has(thread)) return next;
    const save: Promise<void> = (this.saving.get(thread) ?? Promise.resolve())
      .then(() => super.put(...args))
      .then(() => this.dropOlder(next.configurable))
      .catch((err: Error) => this.log(`saving chat memory: ${err.message}`))
      .finally(() => {
        if (this.saving.get(thread) === save) this.saving.delete(thread);
      });
    this.saving.set(thread, save);
    return next;
  }

  // Only used to resume a run that failed half way; a reply is never resumed.
  putWrites() {
    return Promise.resolve();
  }

  // Waits for every save under way (the migration, and a shutdown).
  async flush() {
    await Promise.all(this.saving.values());
  }

  // Forgets every agent's memory of these conversations.
  async forget(conversationIds: string[]) {
    if (!conversationIds.length) return;
    await this.flush();
    for (const table of this.tables) {
      await this.db.query(
        `DELETE FROM ${table} WHERE split_part(thread_id, ':', 1) = ANY($1::text[])`,
        [conversationIds],
      );
    }
  }

  private keepRead(thread: string, tuple: CheckpointTuple | undefined) {
    this.justRead.set(thread, { at: Date.now(), tuple });
    // A run that never came to its second read leaves one behind.
    if (this.justRead.size > MAX_JUST_READ) {
      const [oldest] = this.justRead.keys();
      this.justRead.delete(oldest);
    }
  }

  // One statement, so a thread is never left with a checkpoint whose values are
  // gone. Only older ones: a newer one another server just wrote stays, with its
  // values.
  private async dropOlder(kept: {
    thread_id: string;
    checkpoint_ns: string;
    checkpoint_id: string;
  }) {
    const [checkpoints, blobs] = this.tables;
    await this.db.query(
      `WITH old AS (
         DELETE FROM ${checkpoints}
         WHERE thread_id = $1 AND checkpoint_ns = $2 AND checkpoint_id < $3
       ),
       kept AS (
         SELECT v.key, v.value
         FROM ${checkpoints} c,
           jsonb_each_text(c.checkpoint -> 'channel_versions') v
         WHERE c.thread_id = $1 AND c.checkpoint_ns = $2
           AND c.checkpoint_id >= $3
       )
       DELETE FROM ${blobs} b
       WHERE b.thread_id = $1 AND b.checkpoint_ns = $2
         AND EXISTS (SELECT 1 FROM kept)
         AND NOT EXISTS (
           SELECT 1 FROM kept
           WHERE kept.key = b.channel AND kept.value = b.version)`,
      [kept.thread_id, kept.checkpoint_ns, kept.checkpoint_id],
    );
  }
}
