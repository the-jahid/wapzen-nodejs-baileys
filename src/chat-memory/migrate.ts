import { setTimeout as delay } from 'node:timers/promises';
import { getBufferString } from '@langchain/core/messages';
import type { Pool } from 'pg';
import type { createReplyAgent } from '../whatsapp/reply-agent';
import {
  lastSeq,
  rowMessages,
  rowSeq,
  SUMMARY_ID,
  threadIdFor,
  type TranscriptRow,
} from './transcript';
import { isGoodSummary, summaryMessage } from './memory.middleware';

// Moves the chats saved so far (chat_messages) into chat memory: the latest
// messages of each word for word, and a summary of the ones before them, exactly
// as a thread that had been kept from its first message. chat_messages is only
// read, and a chat that isn't moved still works: its first reply catches up.

// The node an agent's own run ends on, so a moved thread looks like a finished
// one.
const LAST_NODE = 'ChatTranscript.after_agent';
// How much of a chat one summary call reads. Counted in characters, which is
// within Claude Haiku 5.5's cheap range even in scripts of a token each.
const SUMMARY_CHUNK_CHARS = 60_000;
// How often one chat is tried before it is reported as failed (and left to the
// next run): the database or the model may be busy for a moment.
const TRIES = 4;
const RETRY_MS = 1_000;

export type Summarize = (
  turns: string,
  earlierNotes?: string,
) => Promise<string>;

export type MigrationOptions = {
  pool: Pool;
  // On a strict saver, so a failed read or save is never taken for an answer.
  agent: ReturnType<typeof createReplyAgent>;
  summarize: Summarize;
  // Puts the notes the way a reply reads them.
  summaryText: (notes: string) => string;
  // A chat this long is summed up, keeping this many messages.
  summaryAt: number;
  keep: number;
  // False only looks: nothing is written and no model is called.
  apply: boolean;
  concurrency?: number;
  limit?: number;
  retryMs?: number;
  log?: (line: string) => void;
};

type Thread = { conversationId: string; chatAgentId: string };

export type MigrationReport = {
  threads: number;
  messages: number;
  // Messages of no known agent: saved before chat_agent_id, or to one since
  // deleted. By the rule that an agent remembers only its own chat, nobody's.
  unowned: number;
  moved: number;
  alreadyThere: number;
  summaries: number;
  // What the summaries read, in characters (about 4 to a token in English).
  summaryChars: number;
  failed: { thread: string; error: string }[];
};

export async function migrateChats(
  options: MigrationOptions,
): Promise<MigrationReport> {
  const { pool, log = () => undefined } = options;
  const threads = await listThreads(pool, options.limit);
  const report: MigrationReport = {
    threads: threads.length,
    messages: 0,
    unowned: await countUnowned(pool),
    moved: 0,
    alreadyThere: 0,
    summaries: 0,
    summaryChars: 0,
    failed: [],
  };
  let done = 0;
  await eachOf(threads, options.concurrency ?? 4, async (thread) => {
    try {
      const moved = await retrying(() => moveThread(thread, options), options);
      report.messages += moved.messages;
      report.summaryChars += moved.summaryChars;
      if (moved.summaryChars) report.summaries += 1;
      if (moved.outcome === 'there') report.alreadyThere += 1;
      if (moved.outcome === 'moved') report.moved += 1;
    } catch (err) {
      report.failed.push({
        thread: threadIdFor(thread.conversationId, thread.chatAgentId),
        error: (err as Error).message,
      });
    }
    done += 1;
    if (done % 100 === 0) log(`${done} of ${threads.length} chats`);
  });
  return report;
}

async function moveThread(thread: Thread, options: MigrationOptions) {
  const { pool, agent, apply, summaryAt, keep } = options;
  const config = configFor(thread);
  if (apply && (await memoryOf(agent, thread))) {
    return { outcome: 'there', messages: 0, summaryChars: 0 };
  }
  const rows = await readRows(pool, thread);
  // The incoming message counts towards a reply's own limit, so one fewer.
  const older = rows.length >= summaryAt - 1 ? rows.slice(0, -keep) : [];
  const kept = rows.slice(older.length);
  const looked = {
    outcome: 'looked',
    messages: rows.length,
    summaryChars: older.reduce((sum, row) => sum + row.text.length, 0),
  };
  if (!apply) return looked;

  const summary = older.length
    ? [summaryMessage(await summaryOf(older, options))]
    : [];
  await agent.graph.updateState(
    config,
    {
      messages: [...summary, ...rowMessages(kept)],
      syncedSeq: rows.at(-1)?.seq ?? -1,
      summarizedThrough: older.at(-1)?.seq ?? -1,
      reply: '',
    },
    LAST_NODE,
  );
  return { ...looked, outcome: 'moved' };
}

async function retrying<T>(
  run: () => Promise<T>,
  { retryMs = RETRY_MS }: Pick<MigrationOptions, 'retryMs'>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= TRIES) throw err;
      await delay(retryMs * 2 ** (attempt - 1));
    }
  }
}

async function summaryOf(rows: TranscriptRow[], options: MigrationOptions) {
  let notes = '';
  for (const chunk of chunks(rows)) {
    notes = await options.summarize(getBufferString(rowMessages(chunk)), notes);
  }
  return options.summaryText(notes);
}

function* chunks(rows: TranscriptRow[]) {
  let chunk: TranscriptRow[] = [];
  let size = 0;
  for (const row of rows) {
    if (chunk.length && size + row.text.length > SUMMARY_CHUNK_CHARS) {
      yield chunk;
      chunk = [];
      size = 0;
    }
    chunk.push(row);
    size += row.text.length;
  }
  if (chunk.length) yield chunk;
}

export type VerificationReport = {
  threads: number;
  missing: string[];
  wrong: { thread: string; problem: string }[];
};

// Reads every moved chat back through the checkpointer and compares it with
// chat_messages, message by message.
export async function verifyChats({
  pool,
  agent,
  summaryAt,
  concurrency = 4,
  limit,
  retryMs,
}: Pick<
  MigrationOptions,
  'pool' | 'agent' | 'summaryAt' | 'concurrency' | 'limit' | 'retryMs'
>): Promise<VerificationReport> {
  const threads = await listThreads(pool, limit);
  const report: VerificationReport = {
    threads: threads.length,
    missing: [],
    wrong: [],
  };
  await eachOf(threads, concurrency, async (thread) => {
    const id = threadIdFor(thread.conversationId, thread.chatAgentId);
    const memory = await retrying(() => memoryOf(agent, thread), { retryMs });
    if (!memory) {
      report.missing.push(id);
      return;
    }
    const problem = compare(
      memory,
      await retrying(() => readRows(pool, thread), { retryMs }),
      summaryAt,
    );
    if (problem) report.wrong.push({ thread: id, problem });
  });
  return report;
}

type MemoryValues = {
  messages: ReturnType<typeof rowMessages>;
  syncedSeq: number;
  summarizedThrough: number;
};

function compare(
  { messages, syncedSeq, summarizedThrough }: MemoryValues,
  rows: TranscriptRow[],
  summaryAt: number,
): string | undefined {
  const synced = rows.filter((row) => row.seq <= syncedSeq);
  const expected = rowMessages(
    synced.filter((row) => row.seq > summarizedThrough),
  );
  const kept = messages.filter((m) => rowSeq(m) !== undefined);
  if (kept.length !== expected.length) {
    return `${kept.length} messages kept, expected ${expected.length}`;
  }
  const odd = kept.findIndex(
    (m, i) =>
      m.id !== expected[i].id ||
      m.type !== expected[i].type ||
      m.text !== expected[i].text,
  );
  if (odd >= 0) return `message ${kept[odd].id} differs from the saved one`;
  if (lastSeq(kept, summarizedThrough) > syncedSeq) return 'synced seq is low';
  const [first] = messages;
  const summed = first?.id === SUMMARY_ID;
  if (summed !== summarizedThrough >= 0) return 'summary and its reach differ';
  if (summed && !isGoodSummary(first.text.split('\n\n').slice(1).join('\n\n')))
    return 'the summary is empty or an error';
  if (!summed && synced.length >= summaryAt)
    return 'a long chat has no summary';
  return undefined;
}

const configFor = (thread: Thread) => ({
  configurable: {
    thread_id: threadIdFor(thread.conversationId, thread.chatAgentId),
  },
});

// What the memory holds of a chat, or undefined when it isn't there.
async function memoryOf(agent: MigrationOptions['agent'], thread: Thread) {
  const state = await agent.graph.getState(configFor(thread));
  const memory = state.values as Partial<MemoryValues> | undefined;
  return memory?.messages ? (memory as MemoryValues) : undefined;
}

// The chats with messages of an agent that still exists, the latest first.
async function listThreads(pool: Pool, limit?: number): Promise<Thread[]> {
  const { rows } = await pool.query<Thread>(
    `SELECT m.conversation_id AS "conversationId",
       m.chat_agent_id AS "chatAgentId"
     FROM chat_messages m
     JOIN chat_agents a ON a.id = m.chat_agent_id
     GROUP BY 1, 2
     ORDER BY max(m.created_at) DESC
     LIMIT $1`,
    [limit ?? null],
  );
  return rows;
}

async function countUnowned(pool: Pool) {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM chat_messages m
     WHERE NOT EXISTS (SELECT 1 FROM chat_agents a WHERE a.id = m.chat_agent_id)`,
  );
  return rows[0].n;
}

async function readRows(pool: Pool, thread: Thread): Promise<TranscriptRow[]> {
  const { rows } = await pool.query<TranscriptRow>(
    `SELECT seq, role, content AS text, created_at AS at
     FROM chat_messages
     WHERE conversation_id = $1 AND chat_agent_id = $2
     ORDER BY seq`,
    [thread.conversationId, thread.chatAgentId],
  );
  return rows;
}

async function eachOf<T>(
  items: T[],
  concurrency: number,
  run: (item: T) => Promise<void>,
) {
  const queue = items.values();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (const item of queue) await run(item);
    }),
  );
}
