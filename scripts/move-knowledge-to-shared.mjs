// Moves every knowledge base that still has a Pinecone namespace of its own
// (kb_<uuid>, from before 2026-11-11) into the shared namespace of the index
// the server now uses. The old index hit its plan's 100-namespace cap. The
// vectors are rebuilt from the source text saved in knowledge_base_sources,
// with the server's own compiled indexer, so ids, chunks and metadata match
// what a fresh create would write.
//
// Dry run by default: it only counts what it would move. Run it after the
// deploy that switched PINECONE_API_KEY / PINECONE_INDEX_HOST, since the
// server only reads kb_shared from the new index:
//
//   npm run build
//   MOVE_DATABASE_URL=... OPENAI_API_KEY=... PINECONE_API_KEY=<new> \
//   PINECONE_INDEX_HOST=<new> node scripts/move-knowledge-to-shared.mjs --apply
//
// Safe to run again: each base's prefix is cleared before it is rewritten,
// and a base whose row already says kb_shared is skipped. The old index is
// never touched.
import { createRequire } from 'node:module';
import pg from 'pg';

const require = createRequire(import.meta.url);
const { IndexerService, SHARED_NAMESPACE } = require(
  '../dist/knowledge-bases/indexer.service.js',
);

const apply = process.argv.includes('--apply');
const url = process.env.MOVE_DATABASE_URL;
if (!url) throw new Error('set MOVE_DATABASE_URL to the database to move');

const indexer = new IndexerService({
  get: (key, fallback) => process.env[key] ?? fallback,
});
if (!indexer.enabled) {
  throw new Error('set OPENAI_API_KEY, PINECONE_API_KEY and PINECONE_INDEX_HOST');
}

const db = new pg.Client({
  connectionString: url.replace(/[?&]pgbouncer=true/, ''),
  ssl: url.includes('127.0.0.1') ? false : { rejectUnauthorized: false },
});
await db.connect();

const { rows: bases } = await db.query(
  `SELECT id, knowledge_base_name AS name, pinecone_namespace,
          min_chunk_size, max_chunk_size
     FROM knowledge_bases
    WHERE pinecone_namespace IS DISTINCT FROM $1
    ORDER BY created_at`,
  [SHARED_NAMESPACE],
);
console.log(`${bases.length} knowledge bases to move${apply ? '' : ' (dry run)'}`);

let moved = 0;
let failed = 0;
let vectors = 0;
for (const base of bases) {
  const { rows: sources } = await db.query(
    `SELECT id, type, title, content FROM knowledge_base_sources
      WHERE knowledge_base_id = $1 ORDER BY created_at, id`,
    [base.id],
  );
  const label = `${base.id} "${base.name}" (${sources.length} sources)`;
  if (!apply) {
    console.log(`would move ${label}`);
    continue;
  }
  const kb = {
    id: base.id,
    pineconeNamespace: SHARED_NAMESPACE,
    minChunkSize: base.min_chunk_size,
    maxChunkSize: base.max_chunk_size,
  };
  try {
    await indexer.purgeNamespace(kb);
    await indexer.indexSources(kb, sources, async (counts) => {
      await db.query('BEGIN');
      try {
        await db.query(
          `UPDATE knowledge_base_sources AS s
              SET chunk_count = c.n, updated_at = now()
             FROM unnest($1::text[], $2::int[]) AS c(id, n)
            WHERE s.id = c.id`,
          [sources.map((s) => s.id), counts],
        );
        await db.query(
          `UPDATE knowledge_bases SET pinecone_namespace = $2, updated_at = now()
            WHERE id = $1`,
          [base.id, SHARED_NAMESPACE],
        );
        await db.query('COMMIT');
      } catch (err) {
        await db.query('ROLLBACK');
        throw err;
      }
      vectors += counts.reduce((a, b) => a + b, 0);
    });
    moved++;
    console.log(`moved ${label}`);
  } catch (err) {
    failed++;
    console.log(`FAILED ${label}: ${err.message}`);
  }
}

await db.end();
console.log(
  apply
    ? `done: ${moved} moved (${vectors} vectors), ${failed} failed`
    : 'dry run only; pass --apply to move them',
);
if (failed) process.exitCode = 1;
