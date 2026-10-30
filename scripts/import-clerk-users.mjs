// Copies every Clerk user into the users table, the same row ClerkAuthGuard
// would create on first sign-in. It only reads from Clerk; nothing in Clerk
// is changed or deleted.
//
//   node --env-file=.env scripts/import-clerk-users.mjs           # dry run
//   node --env-file=.env scripts/import-clerk-users.mjs --apply   # write
//
// CLERK_IMPORT_SECRET_KEY picks the Clerk instance to read (falls back to
// CLERK_SECRET_KEY). Rows are upserted on oauth_id, so reruns are safe. A
// Clerk user whose email already belongs to a different oauth_id is skipped
// and reported, never overwritten.
import pg from 'pg';

const apply = process.argv.includes('--apply');
const secretKey =
  process.env.CLERK_IMPORT_SECRET_KEY ?? process.env.CLERK_SECRET_KEY;
const dbUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!secretKey || !dbUrl) {
  console.error('need CLERK_IMPORT_SECRET_KEY (or CLERK_SECRET_KEY) and DIRECT_URL');
  process.exit(1);
}

async function clerkUsers() {
  const all = [];
  for (let offset = 0; ; offset += 500) {
    const res = await fetch(
      `https://api.clerk.com/v1/users?limit=500&offset=${offset}&order_by=created_at`,
      { headers: { Authorization: `Bearer ${secretKey}` } },
    );
    if (!res.ok) throw new Error(`clerk GET /users: ${res.status} ${await res.text()}`);
    const page = await res.json();
    all.push(...page);
    if (page.length < 500) return all;
  }
}

function primaryEmail(u) {
  const list = u.email_addresses ?? [];
  const primary = list.find((e) => e.id === u.primary_email_address_id);
  return (primary ?? list[0])?.email_address?.trim().toLowerCase() || null;
}

const users = await clerkUsers();
const db = new pg.Client({ connectionString: dbUrl });
await db.connect();

const { rows: existing } = await db.query('SELECT oauth_id, lower(email) AS email FROM users');
const byOauth = new Set(existing.map((r) => r.oauth_id));
const emailOwner = new Map(existing.map((r) => [r.email, r.oauth_id]));

const toWrite = [];
const noEmail = [];
const emailTaken = [];
for (const u of users) {
  const email = primaryEmail(u);
  if (!email) {
    noEmail.push(u.id);
    continue;
  }
  const owner = emailOwner.get(email);
  if (owner && owner !== u.id) {
    emailTaken.push({ clerkId: u.id, existingOauthId: owner });
    continue;
  }
  emailOwner.set(email, u.id); // two Clerk users sharing an email: first wins
  toWrite.push({
    id: u.id,
    email,
    username: u.username ?? null,
    createdAt: new Date(u.created_at ?? Date.now()).toISOString(),
  });
}

const fresh = toWrite.filter((u) => !byOauth.has(u.id)).length;
console.log(`clerk users:          ${users.length}`);
console.log(`users rows before:    ${existing.length}`);
console.log(`to insert (new):      ${fresh}`);
console.log(`to update (existing): ${toWrite.length - fresh}`);
console.log(`skipped, no email:    ${noEmail.length}`, noEmail);
console.log(`skipped, email taken: ${emailTaken.length}`, emailTaken);

if (!apply) {
  console.log('\ndry run; rerun with --apply to write');
  await db.end();
  process.exit(0);
}

await db.query('BEGIN');
try {
  const res = await db.query(
    `INSERT INTO users (oauth_id, email, username, created_at, updated_at)
     SELECT t.oauth_id, t.email, t.username, t.created_at, now()
     FROM unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[])
       AS t(oauth_id, email, username, created_at)
     ON CONFLICT (oauth_id) DO UPDATE
       SET email = EXCLUDED.email, username = EXCLUDED.username, updated_at = now()`,
    [
      toWrite.map((u) => u.id),
      toWrite.map((u) => u.email),
      toWrite.map((u) => u.username),
      toWrite.map((u) => u.createdAt),
    ],
  );
  await db.query('COMMIT');
  const { rows } = await db.query('SELECT count(*)::int AS n FROM users');
  console.log(`\nwrote ${res.rowCount} rows; users rows now: ${rows[0].n}`);
} catch (err) {
  await db.query('ROLLBACK');
  throw err;
} finally {
  await db.end();
}
