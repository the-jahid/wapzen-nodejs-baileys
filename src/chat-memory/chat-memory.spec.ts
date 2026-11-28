import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { fakeModel } from '@langchain/core/testing';
import type { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { PrismaService } from '../prisma/prisma.service';
import type { ChatToolbox } from '../tools/chat-toolbox';
import {
  CHAT_REMEMBER_MESSAGES,
  CHAT_SUMMARY_AT,
  CHAT_TRANSCRIPT_MESSAGES,
  createReplyAgent,
  summaryText,
} from '../whatsapp/reply-agent';
import { TOOLS_WITHOUT_SELECTION } from '../whatsapp/reply-tools';
import { ChatMemorySaver, MEMORY_SCHEMA } from './chat-memory.saver';
import { ChatMemoryService } from './chat-memory.service';
import { migrateChats, verifyChats } from './migrate';
import { RamMemorySaver } from './ram-memory.saver';
import {
  gapNote,
  rowMessages,
  threadIdFor,
  type TranscriptRow,
} from './transcript';

// The reply agent's memory and tools, with the real middleware and the real
// checkpointer on a real Postgres (PGlite). Only the models are fakes.
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('@langchain/anthropic', () => ({ ChatAnthropic: class {} }));
jest.setTimeout(60_000);

const PORT = 55471;
const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');

let pg: PGlite;
let server: PGLiteSocketServer;
let pool: Pool;
let n = 0;

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
  pool = new Pool({
    connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
    max: 1,
  });
  await new ChatMemorySaver(pool).setup();
});

afterAll(async () => {
  await pool?.end();
  await server?.stop();
  await pg?.close();
});

type Reply = string | Error | AIMessage;

// A server process: its own checkpointer and agent, nothing in memory yet.
function boot(
  {
    replies = [],
    summaries = [],
    picks = [] as Reply[],
  }: {
    replies?: Reply[];
    summaries?: Reply[];
    picks?: Reply[];
  } = {},
  saver = new ChatMemorySaver(pool),
) {
  const model = (answers: Reply[], fallback: string) => {
    const fake = fakeModel();
    for (const answer of answers) {
      fake.respond(typeof answer === 'string' ? new AIMessage(answer) : answer);
    }
    for (let i = 0; i < 20; i++) fake.respond(() => new AIMessage(fallback));
    return fake;
  };
  const reply = model(replies, 'The AI reply');
  const summary = model(summaries, 'Notes on the chat.');
  const selection = model(picks, '');
  // The tools of each call of the reply model.
  const bound = jest.spyOn(reply, 'bindTools');
  const agent = createReplyAgent('key', saver, { reply, summary, selection });
  return { agent, saver, reply, summary, selection, bound };
}

type Server = ReturnType<typeof boot>;

const rowsOf = (count: number, from = 0): TranscriptRow[] =>
  Array.from({ length: count }, (_, i) => ({
    seq: from + i,
    role: (from + i) % 2 ? 'assistant' : 'user',
    text: `message ${from + i}`,
    at: new Date(),
  }));

const newThread = () => `thread${++n}:agent`;

// One reply, as the responder asks for it, on what is saved so far. Returns what
// the model was given (its notes aside) and the answer.
async function answer(
  { agent, reply, saver }: Server,
  thread: string | undefined,
  rows: TranscriptRow[],
  text = 'the new message',
  {
    toolbox = null as ChatToolbox | null,
    load = (after: number) =>
      Promise.resolve(
        rows.filter(
          (row) =>
            row.seq > after &&
            row.seq < rows[Math.max(0, rows.length - 60)].seq,
        ),
      ),
    image = false,
  } = {},
) {
  const latest = rows.slice(-CHAT_TRANSCRIPT_MESSAGES);
  const incoming = new HumanMessage({
    id: `in${++n}`,
    content: image
      ? [
          { type: 'text', text },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,AAAA' },
          },
        ]
      : text,
  });
  const calls = reply.callCount;
  const result = await agent.invoke(
    { messages: [...rowMessages(latest), incoming] },
    {
      ...(thread ? { configurable: { thread_id: thread } } : {}),
      durability: 'exit',
      context: {
        prompt: 'You are a shop.',
        turnNotes: 'Today is Tuesday.',
        incomingId: incoming.id,
        toolbox,
        older:
          latest.length < CHAT_TRANSCRIPT_MESSAGES
            ? undefined
            : { beforeSeq: latest[0].seq, load },
      },
    },
  );
  await saver.flush();
  const given = reply.calls[calls].messages.filter((m) => m.type !== 'system');
  return { reply: result.reply, given: given.map((m) => m.text) };
}

const stateOf = async ({ agent }: Server, thread: string) =>
  (await agent.graph.getState({ configurable: { thread_id: thread } }))
    .values as {
    messages: BaseMessage[];
    syncedSeq: number;
    summarizedThrough: number;
  };

describe('what a chat remembers', () => {
  it('is what was saved, in order, then the new message', async () => {
    const thread = newThread();
    const app = boot();
    const first = await answer(app, thread, rowsOf(2));
    expect(first.reply).toBe('The AI reply');
    expect(first.given).toEqual(['message 0', 'message 1', 'the new message']);
    const second = await answer(app, thread, rowsOf(4), 'next');
    expect(second.given).toEqual([
      'message 0',
      'message 1',
      'message 2',
      'message 3',
      'next',
    ]);
  });

  it('is never the draft, the photo or the message still being answered', async () => {
    const thread = newThread();
    const app = boot();
    await answer(app, thread, rowsOf(2), 'look', { image: true });
    const state = await stateOf(app, thread);
    expect(state.messages.map((m) => m.text)).toEqual([
      'message 0',
      'message 1',
    ]);
    expect(state.syncedSeq).toBe(1);
  });

  it('includes what a person sent meanwhile, and survives a restart', async () => {
    const thread = newThread();
    await answer(boot(), thread, rowsOf(2));
    const rows: TranscriptRow[] = [
      ...rowsOf(4),
      { seq: 4, role: 'assistant', text: 'from the owner', at: new Date() },
    ];
    const { given } = await answer(boot(), thread, rows);
    expect(given.slice(-2)).toEqual(['from the owner', 'the new message']);
  });

  it('tells the model the business wrote first instead of dropping it', async () => {
    const rows: TranscriptRow[] = [
      {
        seq: 0,
        role: 'assistant',
        text: 'Your order is ready',
        at: new Date(),
      },
    ];
    const { given } = await answer(boot(), newThread(), rows, 'where?');
    expect(given).toEqual([
      '(The business wrote first in this chat.)',
      'Your order is ready',
      'where?',
    ]);
  });

  it('is nothing of another thread', async () => {
    const app = boot();
    await answer(app, newThread(), rowsOf(4));
    const { given } = await answer(app, newThread(), []);
    expect(given).toEqual(['the new message']);
  });

  it('is the last messages alone with no store, and nothing is summed up', async () => {
    const app = boot({}, undefined);
    const plain = createReplyAgent('key', undefined, app);
    const { given } = await answer(
      { ...app, agent: plain },
      undefined,
      rowsOf(60),
    );
    expect(given).toHaveLength(41);
    expect(given[0]).toBe('message 20');
    expect(app.summary.callCount).toBe(0);
  });
});

describe('a long chat', () => {
  it('is summed up once, and the summary survives a restart', async () => {
    const thread = newThread();
    const app = boot({ summaries: ['Rahim wants 2 burgers.'] });
    const first = await answer(app, thread, rowsOf(50));
    expect(app.summary.callCount).toBe(1);
    expect(first.given[0]).toContain('Rahim wants 2 burgers.');
    expect(first.given).toHaveLength(42);
    expect(first.given[1]).toBe('message 10');

    // A new process is given all 52 saved messages again, the summed-up ones
    // included.
    const restarted = boot();
    const second = await answer(restarted, thread, rowsOf(52));
    expect(restarted.summary.callCount).toBe(0);
    expect(second.given[0]).toContain('Rahim wants 2 burgers.');
    expect(second.given[1]).toBe('message 10');
    expect(second.given).toHaveLength(44);
    expect((await stateOf(restarted, thread)).summarizedThrough).toBe(9);
  });

  describe('with CHAT_SUMMARY=off', () => {
    const before = process.env.CHAT_SUMMARY;
    beforeEach(() => {
      process.env.CHAT_SUMMARY = 'off';
    });
    afterEach(() => {
      if (before === undefined) delete process.env.CHAT_SUMMARY;
      else process.env.CHAT_SUMMARY = before;
    });

    it('is never summed up, and keeps the last 40 messages', async () => {
      const thread = newThread();
      const app = boot();
      await answer(app, thread, rowsOf(50));
      const { given } = await answer(app, thread, rowsOf(60));
      expect(app.summary.callCount).toBe(0);
      expect(given).toHaveLength(41);
      expect(given[0]).toBe('message 20');
    });

    it('still uses a summary it already has', async () => {
      const thread = newThread();
      delete process.env.CHAT_SUMMARY;
      const app = boot({ summaries: ['Rahim wants 2 burgers.'] });
      await answer(app, thread, rowsOf(50));
      process.env.CHAT_SUMMARY = 'off';
      const { given } = await answer(app, thread, rowsOf(60));
      expect(app.summary.callCount).toBe(1);
      expect(given[0]).toContain('Rahim wants 2 burgers.');
      expect(given).toHaveLength(41);
    });
  });

  it('merges the earlier summary into the next one', async () => {
    const thread = newThread();
    const app = boot({ summaries: ['First notes.', 'Second notes.'] });
    await answer(app, thread, rowsOf(50));
    await answer(app, thread, rowsOf(60));
    expect(app.summary.callCount).toBe(2);
    expect(app.summary.calls[1].messages[0].text).toContain('First notes.');
    const state = await stateOf(app, thread);
    expect(state.messages[0].text).toContain('Second notes.');
    expect(state.messages).toHaveLength(41);
    expect(state.summarizedThrough).toBe(19);
  });

  it.each([
    ['fails', new Error('overloaded')],
    ['comes back empty', ''],
  ])('keeps its messages when a summary %s', async (_name, bad) => {
    const thread = newThread();
    const app = boot({ summaries: [bad, 'Good notes.'] });
    const first = await answer(app, thread, rowsOf(50));
    expect(first.reply).toBe('The AI reply');
    expect(first.given).toHaveLength(51);
    const state = await stateOf(app, thread);
    expect(state.messages).toHaveLength(50);
    expect(state.summarizedThrough).toBe(-1);

    const second = await answer(app, thread, rowsOf(52));
    expect(second.given[0]).toContain('Good notes.');
    expect(second.given).toHaveLength(42);
  });

  it('that was never opened before catches up on all of it', async () => {
    const app = boot();
    await answer(app, newThread(), rowsOf(130));
    // All but the last 40 go into the summary, the oldest included.
    const read = app.summary.calls[0].messages[0].text;
    expect(read).toContain('message 0\n');
    expect(read).toContain('message 89');
    expect(read).not.toContain('message 90');
  });

  it('tries the catching up again when it failed', async () => {
    const thread = newThread();
    const app = boot({ summaries: [new Error('down'), 'All of it.'] });
    await answer(app, thread, rowsOf(130), 'hi', {
      load: () => Promise.reject(new Error('db down')),
    });
    expect((await stateOf(app, thread)).syncedSeq).toBe(-1);
    await answer(app, thread, rowsOf(130));
    expect(app.summary.calls[1].messages[0].text).toContain('message 0\n');
    expect((await stateOf(app, thread)).syncedSeq).toBe(129);
  });
});

describe('the memory store', () => {
  const count = async (table: string, thread: string) =>
    Number(
      (
        await pool.query<{ n: string }>(
          `SELECT count(*) AS n FROM "${MEMORY_SCHEMA}".${table} WHERE thread_id = $1`,
          [thread],
        )
      ).rows[0].n,
    );

  it('keeps one checkpoint a thread, and no values but its own', async () => {
    const thread = newThread();
    const app = boot();
    await answer(app, thread, rowsOf(2));
    const blobs = await count('checkpoint_blobs', thread);
    for (const size of [4, 6, 8, 10]) await answer(app, thread, rowsOf(size));
    expect(await count('checkpoints', thread)).toBe(1);
    expect(await count('checkpoint_blobs', thread)).toBeLessThanOrEqual(blobs);
    expect(await count('checkpoint_writes', thread)).toBe(0);
    expect((await stateOf(boot(), thread)).messages).toHaveLength(10);
  });

  it('is read once a reply', async () => {
    const thread = newThread();
    await answer(boot(), thread, rowsOf(2));
    const query = jest.spyOn(pool, 'query');
    await answer(boot(), thread, rowsOf(4));
    const reads = query.mock.calls.filter(
      ([q]) => typeof q === 'object' && 'text' in q,
    );
    query.mockRestore();
    expect(reads).toHaveLength(1);
  });

  it('is read afresh by the next reply, on this server or another', async () => {
    const thread = newThread();
    const [one, two] = [boot(), boot()];
    await answer(one, thread, rowsOf(2));
    await answer(two, thread, rowsOf(50));
    const { given } = await answer(one, thread, rowsOf(52));
    expect(one.summary.callCount).toBe(0);
    expect(given[0]).toContain('Notes on the chat.');
  });

  it('never fails a reply: not by a save', async () => {
    const thread = newThread();
    const errors: string[] = [];
    const broken = new Pool({
      connectionString: 'postgresql://x:x@127.0.0.1:1/x',
    });
    const app = boot({}, new ChatMemorySaver(broken, (e) => errors.push(e)));
    const { reply, given } = await answer(app, thread, rowsOf(2));
    expect(reply).toBe('The AI reply');
    expect(given).toEqual(['message 0', 'message 1', 'the new message']);
    expect(errors.length).toBeGreaterThan(0);
    await broken.end();
  });

  it('is not overwritten by a reply that could not read it', async () => {
    const thread = newThread();
    await answer(boot({ summaries: ['Rahim.'] }), thread, rowsOf(50));
    const saver = new ChatMemorySaver(pool);
    const query = jest
      .spyOn(pool, 'query')
      .mockRejectedValue(new Error('down') as never);
    const app = boot({}, saver);
    expect((await answer(app, thread, rowsOf(52))).reply).toBe('The AI reply');
    query.mockRestore();

    const { given } = await answer(boot(), thread, rowsOf(54));
    expect(given[0]).toContain('Rahim.');
  });

  it('forgets a deleted conversation, for every agent, and no other', async () => {
    const app = boot();
    const [a, b, other] = ['gone:agent1', 'gone:agent2', 'kept:agent1'];
    for (const thread of [a, b, other]) await answer(app, thread, rowsOf(2));
    await app.saver.forget(['gone']);
    expect(await count('checkpoints', a)).toBe(0);
    expect(await count('checkpoint_blobs', b)).toBe(0);
    expect(await count('checkpoints', other)).toBe(1);
  });
});

// With CHAT_MEMORY off: as it was before memory could be saved.
describe('memory kept in this process', () => {
  const ram = (saver = new RamMemorySaver(), summaries: Reply[] = []) =>
    boot({ summaries }, saver as unknown as ChatMemorySaver);
  // The responder brings 40 messages then, and reads no older ones.
  const bring = (count: number) => rowsOf(count).slice(-40);

  it('keeps the summary between replies, and forgets it in a restart', async () => {
    const thread = newThread();
    const app = ram(undefined, ['Rahim wants 2 burgers.']);
    for (const count of [20, 40, 50, 52]) {
      await answer(app, thread, bring(count));
    }
    expect(app.summary.callCount).toBe(1);
    const later = await answer(app, thread, bring(54));
    expect(later.given[0]).toContain('Rahim wants 2 burgers.');

    const restarted = ram();
    const { given } = await answer(restarted, thread, bring(56));
    expect(given).toHaveLength(41);
    expect(given[0]).toBe('message 16');
    expect(restarted.summary.callCount).toBe(0);
  });

  it('holds one checkpoint a thread, and forgets the one idle longest', async () => {
    const saver = new RamMemorySaver(2);
    const app = ram(saver);
    for (const thread of ['a:x', 'b:x', 'a:x', 'c:x']) {
      await answer(app, thread, bring(2));
    }
    expect(Object.keys(saver.storage).sort()).toEqual(['a:x', 'c:x']);
    expect(Object.keys(saver.storage['a:x'][''])).toHaveLength(1);
    await saver.forget(['a']);
    expect(Object.keys(saver.storage)).toEqual(['c:x']);
  });

  it('holds no more bytes than its limit, whatever the number of threads', async () => {
    // Too small for two threads, so only the latest is kept.
    const saver = new RamMemorySaver(100, 1);
    const app = ram(saver);
    for (const thread of ['a:x', 'b:x', 'b:x', 'c:x']) {
      await answer(app, thread, bring(2));
    }
    expect(Object.keys(saver.storage)).toEqual(['c:x']);

    // Forgetting a thread gives its bytes back.
    const roomy = new RamMemorySaver();
    const other = ram(roomy);
    await answer(other, 'a:x', bring(2));
    await answer(other, 'b:x', bring(2));
    await roomy.forget(['a', 'b']);
    expect((roomy as unknown as { bytes: number }).bytes).toBe(0);
  });

  const service = (flag: string | undefined, db: unknown) =>
    new ChatMemoryService(
      { pool: db } as PrismaService,
      { get: () => flag } as unknown as ConfigService,
    );

  it('is what is used unless CHAT_MEMORY is on, with nothing created', async () => {
    const db = { connect: jest.fn(), query: jest.fn() };
    for (const flag of [undefined, '', 'off', 'true']) {
      const memory = service(flag, db);
      await memory.onModuleInit();
      expect(memory.saved).toBe(false);
      expect(memory.saver).toBeInstanceOf(RamMemorySaver);
    }
    expect(db.connect).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('is what is used when the tables cannot be made ready', async () => {
    const memory = service('on', {
      connect: () => Promise.reject(new Error('down')),
    });
    await memory.onModuleInit();
    expect(memory.saved).toBe(false);
    expect(memory.saver).toBeInstanceOf(RamMemorySaver);
  });

  it('gives way to the database when it is on', async () => {
    const memory = service('on', pool);
    await memory.onModuleInit();
    expect(memory.saved).toBe(true);
  });
});

describe('the tools of a reply', () => {
  const box = (names: string[], run = jest.fn(() => Promise.resolve('done'))) =>
    ({
      run,
      ownerTools: () =>
        names.map((name) => ({ name, description: `does ${name}` })),
      definitions: () =>
        [...names, 'send_file'].map((name) => ({
          type: 'function',
          function: {
            name,
            description: `does ${name}`,
            parameters: { type: 'object', properties: {}, required: [] },
          },
        })),
    }) as unknown as ChatToolbox;
  const runOf = (toolbox: ChatToolbox) =>
    (toolbox as unknown as { run: jest.Mock }).run;
  const names = (count: number) =>
    Array.from({ length: count }, (_, i) => `tool_${i}`);
  const calls = (...called: string[]) =>
    new AIMessage({
      content: 'Let me look.',
      tool_calls: called.map((name, i) => ({
        name,
        args: {},
        id: `call_${++n}_${i}`,
      })),
    });
  const picked = (...tools: string[]) =>
    new AIMessage({
      content: '',
      tool_calls: [{ name: 'choose_tools', args: { tools }, id: `p${++n}` }],
    });
  const offered = ({ bound }: Server, call = 0) =>
    (
      bound.mock.calls[call][0] as unknown as { function: { name: string } }[]
    ).map((tool) => tool.function.name);

  it('are run, and their results never stay in memory', async () => {
    const thread = newThread();
    const app = boot({ replies: [calls('tool_0'), 'It is 5 pm.'] });
    const toolbox = box(names(1));
    const { reply } = await answer(app, thread, rowsOf(2), 'when?', {
      toolbox,
    });
    expect(runOf(toolbox)).toHaveBeenCalledWith('tool_0', {});
    // What the model said alongside the call isn't sent: only the answer.
    expect(reply).toBe('It is 5 pm.');
    expect((await stateOf(app, thread)).messages).toHaveLength(2);
  });

  it('send what was said with a call when the answer after it is empty', async () => {
    const app = boot({ replies: [calls('tool_0'), ''] });
    const { reply } = await answer(app, newThread(), rowsOf(2), 'when?', {
      toolbox: box(names(1)),
    });
    expect(reply).toBe('Let me look.');
  });

  it('are all offered when they are few, without asking which', async () => {
    const app = boot();
    const all = names(TOOLS_WITHOUT_SELECTION);
    await answer(app, newThread(), [], 'hi', { toolbox: box(all) });
    expect(offered(app)).toEqual([...all, 'send_file']);
    expect(app.selection.callCount).toBe(0);
  });

  it('are picked for the message when they are many, the built-in ones always in', async () => {
    const app = boot({ picks: [picked('tool_3', 'made_up')] });
    await answer(app, newThread(), rowsOf(2), 'hi', {
      toolbox: box(names(15)),
    });
    expect(offered(app)).toEqual(['tool_3', 'send_file']);
    // It reads the chat, not just the last message.
    const read = app.selection.calls[0].messages.at(-1)!.text;
    expect(read).toBe(
      'Customer: message 0\nAssistant: message 1\nCustomer: hi',
    );
  });

  it('are picked once a reply, and afresh on the next', async () => {
    const thread = newThread();
    const app = boot({
      replies: [calls('tool_3'), 'ok'],
      picks: [picked('tool_3'), picked('tool_7')],
    });
    const toolbox = box(names(15));
    await answer(app, thread, rowsOf(2), 'hi', { toolbox });
    expect(app.selection.callCount).toBe(1);
    expect(offered(app, 1)).toEqual(['tool_3', 'send_file']);
    await answer(app, thread, rowsOf(4), 'hi', { toolbox });
    expect(offered(app, 2)).toEqual(['tool_7', 'send_file']);
  });

  it('are all offered when the picking fails', async () => {
    const app = boot({ picks: [new Error('overloaded')] });
    await answer(app, newThread(), [], 'hi', { toolbox: box(names(15)) });
    expect(offered(app)).toHaveLength(16);
  });

  it('that break are reported to the model, and the person is answered', async () => {
    const app = boot({ replies: [calls('tool_0'), 'Sorry, I cannot check.'] });
    const toolbox = box(
      names(1),
      jest.fn(() => Promise.reject(new Error('boom'))),
    );
    const { reply } = await answer(app, newThread(), [], 'hi', { toolbox });
    expect(reply).toContain('Sorry, I cannot check.');
  });

  it('are called ten times a reply at most', async () => {
    const many = calls(...Array.from({ length: 14 }, () => 'tool_0'));
    const app = boot({ replies: [many, 'Done.'] });
    const toolbox = box(names(1));
    const { reply } = await answer(app, newThread(), [], 'hi', { toolbox });
    expect(runOf(toolbox)).toHaveBeenCalledTimes(10);
    expect(reply).toContain('Done.');
  });

  it('get their limit afresh on every reply', async () => {
    const thread = newThread();
    const app = boot({
      replies: [
        calls(...Array.from({ length: 9 }, () => 'tool_0')),
        'a',
        calls(...Array.from({ length: 9 }, () => 'tool_0')),
        'b',
      ],
    });
    const toolbox = box(names(1));
    await answer(app, thread, rowsOf(2), 'hi', { toolbox });
    await answer(app, thread, rowsOf(4), 'hi', { toolbox });
    expect(runOf(toolbox)).toHaveBeenCalledTimes(18);
  });
});

describe('moving saved chats in', () => {
  type Saved = { agent: string | null; count: number };
  // A thread with messages of one agent after another, as they were saved.
  async function saveChat(parts: Saved[]) {
    n += 1;
    const id = `conv${n}`;
    await pool.query(
      `INSERT INTO chat_conversations (id, user_id, peer_jid) VALUES ($1, 'user', $2)`,
      [id, `${n}@lid`],
    );
    let seq = 0;
    for (const { agent, count } of parts) {
      await pool.query(
        `INSERT INTO chat_messages (conversation_id, seq, role, content, chat_agent_id)
         SELECT $1, s, CASE WHEN s % 2 = 0 THEN 'user' ELSE 'assistant' END,
           'message ' || s, $2
         FROM generate_series($3::int, $4::int) s`,
        [id, agent, seq, seq + count - 1],
      );
      seq += count;
    }
    return id;
  }

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO users (id, email, oauth_id) VALUES ('user', 'm@example.com', 'o')`,
    );
    for (const id of ['agentA', 'agentB']) {
      await pool.query(
        `INSERT INTO chat_agents (id, user_id, agent_name) VALUES ($1, 'user', $1)`,
        [id],
      );
    }
  });
  beforeEach(() => pool.query('DELETE FROM chat_conversations'));

  const strict = () =>
    boot({}, new ChatMemorySaver(pool, undefined, MEMORY_SCHEMA, true));
  const optionsFor = (app: Server, summarize = jest.fn()) => ({
    pool,
    retryMs: 1,
    agent: app.agent,
    summarize: summarize as (turns: string, notes?: string) => Promise<string>,
    summaryText,
    summaryAt: CHAT_SUMMARY_AT,
    keep: CHAT_REMEMBER_MESSAGES,
    concurrency: 1,
    apply: true,
  });

  it('only looks unless told to write', async () => {
    const id = await saveChat([{ agent: 'agentA', count: 120 }]);
    const app = strict();
    const summarize = jest.fn();
    const report = await migrateChats({
      ...optionsFor(app, summarize),
      apply: false,
    });
    expect(report).toMatchObject({ threads: 1, messages: 120, summaries: 1 });
    expect(summarize).not.toHaveBeenCalled();
    expect((await verifyChats(optionsFor(app))).missing).toEqual([
      threadIdFor(id, 'agentA'),
    ]);
  });

  it('keeps short chats word for word and sums up long ones, each agent its own', async () => {
    const short = await saveChat([{ agent: 'agentA', count: 8 }]);
    const long = await saveChat([
      { agent: 'agentB', count: 6 },
      { agent: 'agentA', count: 120 },
    ]);
    await saveChat([{ agent: null, count: 4 }]);
    await saveChat([{ agent: 'deleted', count: 4 }]);
    const before = await pool.query('SELECT * FROM chat_messages ORDER BY id');

    const app = strict();
    const summarize = jest.fn(() => Promise.resolve('Rahim wants burgers.'));
    const report = await migrateChats(optionsFor(app, summarize));
    expect(report).toMatchObject({
      threads: 3,
      moved: 3,
      unowned: 8,
      summaries: 1,
      failed: [],
    });
    expect(await verifyChats(optionsFor(app))).toEqual({
      threads: 3,
      missing: [],
      wrong: [],
    });
    const a = await stateOf(app, threadIdFor(long, 'agentA'));
    expect(a.messages).toHaveLength(41);
    expect(a.messages[0].text).toContain('Rahim wants burgers.');
    expect(a.summarizedThrough).toBe(85);
    const b = await stateOf(app, threadIdFor(long, 'agentB'));
    expect(b.messages).toHaveLength(6);
    expect((await stateOf(app, threadIdFor(short, 'agentA'))).syncedSeq).toBe(
      7,
    );
    // The saved chats themselves are only read.
    const after = await pool.query('SELECT * FROM chat_messages ORDER BY id');
    expect(after.rows).toEqual(before.rows);
  });

  it('leaves what is already there alone when run again', async () => {
    await saveChat([{ agent: 'agentA', count: 120 }]);
    const app = strict();
    const summarize = jest.fn(() => Promise.resolve('Notes.'));
    await migrateChats(optionsFor(app, summarize));
    const again = await migrateChats(optionsFor(app, summarize));
    expect(again).toMatchObject({ moved: 0, alreadyThere: 1 });
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it('answers on from a moved chat as if it had always been there', async () => {
    const id = await saveChat([{ agent: 'agentA', count: 120 }]);
    const app = strict();
    await migrateChats(
      optionsFor(
        app,
        jest.fn(() => Promise.resolve('Rahim wants burgers.')),
      ),
    );
    const { given } = await answer(
      boot(),
      threadIdFor(id, 'agentA'),
      rowsOf(122),
    );
    expect(given[0]).toContain('Rahim wants burgers.');
    expect(given[1]).toBe('message 80');
    expect(given).toHaveLength(44);
  });

  it('reports a chat it could not sum up, moves the rest, and can be run again', async () => {
    const bad = await saveChat([{ agent: 'agentA', count: 120 }]);
    await saveChat([{ agent: 'agentA', count: 8 }]);
    const app = strict();
    const report = await migrateChats(
      optionsFor(
        app,
        jest.fn(() => Promise.reject(new Error('overloaded'))),
      ),
    );
    expect(report.moved).toBe(1);
    expect(report.failed).toEqual([
      { thread: threadIdFor(bad, 'agentA'), error: 'overloaded' },
    ]);
    const again = await migrateChats(
      optionsFor(
        app,
        jest.fn(() => Promise.resolve('Notes.')),
      ),
    );
    expect(again).toMatchObject({ moved: 1, alreadyThere: 1, failed: [] });
  });

  // A live pooler refused connections half way: a failed read was taken for no
  // memory, and a skipped save for a moved chat.
  it.each([
    ['for a moment', 2, { moved: 3, failed: 0 }],
    ['for good', Infinity, { moved: 0, failed: 3 }],
  ])(
    'never reports what was not saved when the database fails %s',
    async (_name, times, expected) => {
      for (let i = 0; i < 3; i++) {
        await saveChat([{ agent: 'agentA', count: 8 }]);
      }
      const app = strict();
      let failures = 0;
      const real = pool.query.bind(pool) as (...args: unknown[]) => unknown;
      const query = jest
        .spyOn(pool, 'query')
        .mockImplementation((...args: unknown[]) => {
          const [first] = args as [string | { text: string }];
          const text = typeof first === 'string' ? first : first.text;
          if (text.includes(MEMORY_SCHEMA) && failures++ < times) {
            return Promise.reject(new Error('max clients reached'));
          }
          return real(...args);
        });
      const report = await migrateChats(optionsFor(app));
      query.mockRestore();
      expect(report.moved).toBe(expected.moved);
      expect(report.failed).toHaveLength(expected.failed);
      const check = await verifyChats(optionsFor(app));
      expect(check.missing).toHaveLength(expected.failed);
      expect(check.wrong).toEqual([]);
    },
  );

  it('sums up a very long chat piece by piece, carrying the notes on', async () => {
    const id = await saveChat([{ agent: 'agentA', count: 100 }]);
    await pool.query(
      `UPDATE chat_messages SET content = repeat('x', 4000) WHERE conversation_id = $1`,
      [id],
    );
    const summarize = jest.fn((_turns: string, notes?: string) =>
      Promise.resolve(`${notes ?? ''}+`),
    );
    const report = await migrateChats(optionsFor(strict(), summarize));
    expect(report.moved).toBe(1);
    expect(summarize.mock.calls.map(([, notes]) => notes)).toEqual([
      '',
      '+',
      '++',
      '+++',
    ]);
  });
});

describe('the note on a person coming back', () => {
  const now = new Date('2026-11-24T12:00:00Z');
  it.each([
    [undefined, ''],
    ['2026-11-24T11:00:00Z', ''],
    ['2026-11-23T11:00:00Z', '1 day ago'],
    ['2026-11-03T11:00:00Z', '21 days ago'],
  ])('after %s', (at, note) => {
    expect(gapNote(at ? new Date(at) : undefined, now)).toContain(note);
    if (!note) expect(gapNote(at ? new Date(at) : undefined, now)).toBe('');
  });
});
