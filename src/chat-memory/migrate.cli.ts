import 'dotenv/config';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import {
  CHAT_REMEMBER_MESSAGES,
  CHAT_SUMMARY_AT,
  createChatSummarizer,
  createReplyAgent,
  summaryText,
} from '../whatsapp/reply-agent';
import { ChatMemorySaver, MEMORY_SCHEMA } from './chat-memory.saver';
import { migrateChats, verifyChats } from './migrate';

// Moves saved chats into chat memory (migrate.ts).
//
//   node dist/chat-memory/migrate.cli                  only looks and counts
//   node dist/chat-memory/migrate.cli --apply --host H moves them
//   node dist/chat-memory/migrate.cli --verify         checks what was moved
//
// Works on MEMORY_DATABASE_URL, or else DATABASE_URL. --apply has to name that
// database's host, so it can't run on one by accident. Running it again moves
// only what isn't there yet.

async function main() {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      verify: { type: 'boolean', default: false },
      host: { type: 'string' },
      limit: { type: 'string' },
      concurrency: { type: 'string' },
    },
  });
  const url = process.env.MEMORY_DATABASE_URL ?? process.env.DATABASE_URL;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!url) throw new Error('DATABASE_URL is not set');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const { hostname, pathname } = new URL(url);
  console.log(`database: ${hostname}${pathname}`);
  if (values.apply && values.host !== hostname) {
    throw new Error(`to write to it, add: --host ${hostname}`);
  }

  const pool = new Pool({ connectionString: url, max: 5 });
  // A dropped idle connection is replaced; without this it ends the process.
  pool.on('error', (err) => console.error(err.message));
  const saver = new ChatMemorySaver(pool, console.error, MEMORY_SCHEMA, true);
  const agent = createReplyAgent(apiKey, saver);
  const concurrency = Number(values.concurrency) || 4;
  const limit = Number(values.limit) || undefined;
  try {
    if (values.apply) await saver.setup();
    if (!values.verify) {
      const report = await migrateChats({
        pool,
        agent,
        summarize: createChatSummarizer(apiKey),
        summaryText,
        summaryAt: CHAT_SUMMARY_AT,
        keep: CHAT_REMEMBER_MESSAGES,
        apply: values.apply,
        concurrency,
        limit,
        log: console.log,
      });
      console.log(values.apply ? 'moved:' : 'would move:', report);
      if (report.failed.length) process.exitCode = 1;
    }
    if (values.apply || values.verify) {
      const report = await verifyChats({
        pool,
        agent,
        summaryAt: CHAT_SUMMARY_AT,
        concurrency,
        limit,
      });
      console.log('checked:', report);
      if (report.missing.length || report.wrong.length) process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exitCode = 1;
});
