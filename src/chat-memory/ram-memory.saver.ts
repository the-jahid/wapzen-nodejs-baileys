import type { RunnableConfig } from '@langchain/core/runnables';
import { MemorySaver } from '@langchain/langgraph';

// Chats kept in memory across every number; past this the one idle longest is
// forgotten, so memory stays flat however many people write in.
const MAX_THREADS = 5_000;

// Chat memory in this process alone, as it was before it could be saved: a
// restart forgets it, and the chat starts again from its latest messages. Keeps
// only a thread's newest checkpoint, as the saved one does.
export class RamMemorySaver extends MemorySaver {
  // In the order they were last written, the one idle longest first.
  private readonly threads = new Set<string>();

  constructor(private readonly maxThreads = MAX_THREADS) {
    super();
  }

  async put(...args: Parameters<MemorySaver['put']>): Promise<RunnableConfig> {
    const thread = String(args[0].configurable?.thread_id ?? '');
    this.drop(thread);
    const next = await super.put(...args);
    this.threads.add(thread);
    if (this.threads.size > this.maxThreads) {
      const [oldest] = this.threads;
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
    for (const thread of [...this.threads]) {
      if (gone.has(thread.split(':')[0])) this.drop(thread);
    }
    return Promise.resolve();
  }

  private drop(thread: string) {
    this.threads.delete(thread);
    delete this.storage[thread];
  }
}
