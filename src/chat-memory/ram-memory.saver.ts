import type { RunnableConfig } from '@langchain/core/runnables';
import { MemorySaver } from '@langchain/langgraph';

// Chats kept in memory across every number; past this the one idle longest is
// forgotten, so memory stays flat however many people write in.
const MAX_THREADS = 5_000;
// And the most they may take together. A chat is usually tens of KB, but a reply
// that failed half way can leave the photos it was given behind, megabytes each,
// until that chat's next reply.
const MAX_BYTES = 150 * 1024 * 1024;

// Chat memory in this process alone, as it was before it could be saved: a
// restart forgets it, and the chat starts again from its latest messages. Keeps
// only a thread's newest checkpoint, as the saved one does.
export class RamMemorySaver extends MemorySaver {
  // Each thread's size, in the order they were last written, the one idle
  // longest first.
  private readonly threads = new Map<string, number>();
  private bytes = 0;

  constructor(
    private readonly maxThreads = MAX_THREADS,
    private readonly maxBytes = MAX_BYTES,
  ) {
    super();
  }

  async put(...args: Parameters<MemorySaver['put']>): Promise<RunnableConfig> {
    const thread = String(args[0].configurable?.thread_id ?? '');
    this.drop(thread);
    const next = await super.put(...args);
    const size = this.sizeOf(thread);
    this.bytes += size - (this.threads.get(thread) ?? 0);
    this.threads.delete(thread);
    this.threads.set(thread, size);
    while (
      this.threads.size > this.maxThreads ||
      (this.bytes > this.maxBytes && this.threads.size > 1)
    ) {
      const [oldest] = this.threads.keys();
      this.drop(oldest);
    }
    return next;
  }

  // Only used to resume a run that failed half way; a reply is never resumed.
  putWrites() {
    return Promise.resolve();
  }

  flush() {
    return Promise.resolve();
  }

  // Forgets every agent's memory of these conversations.
  forget(conversationIds: string[]) {
    const gone = new Set(conversationIds);
    for (const thread of [...this.threads.keys()]) {
      if (gone.has(thread.split(':')[0])) this.drop(thread);
    }
    return Promise.resolve();
  }

  private sizeOf(thread: string) {
    let size = 0;
    for (const checkpoints of Object.values(this.storage[thread] ?? {})) {
      for (const [checkpoint, metadata] of Object.values(checkpoints)) {
        size += checkpoint.length + metadata.length;
      }
    }
    return size;
  }

  private drop(thread: string) {
    this.bytes -= this.threads.get(thread) ?? 0;
    this.threads.delete(thread);
    delete this.storage[thread];
  }
}
