import { createHmac, timingSafeEqual } from 'node:crypto';

// Clerk signs webhooks with Svix. This is the Svix check done by hand (what
// the svix package's Webhook.verify does), so no extra dependency is needed:
// HMAC-SHA256 over "<svix-id>.<svix-timestamp>.<raw body>", keyed with the
// base64 part of the whsec_ secret.

// Svix rejects messages more than 5 minutes off, either way, to stop replays.
const TOLERANCE_SECONDS = 5 * 60;

export type SvixHeaders = {
  id?: string;
  timestamp?: string;
  signature?: string;
};

// Throws an Error saying what's wrong; returns nothing when the body is genuine.
export function verifySvix(
  secret: string,
  body: Buffer,
  headers: SvixHeaders,
): void {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) {
    throw new Error('missing svix headers');
  }

  const ts = Number(timestamp);
  if (!Number.isInteger(ts)) throw new Error('invalid svix-timestamp');
  if (Math.abs(Date.now() / 1000 - ts) > TOLERANCE_SECONDS) {
    throw new Error('svix-timestamp too old or too new');
  }

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key)
    .update(`${id}.${timestamp}.`)
    .update(body)
    .digest();

  // The header is space-separated "v1,<base64>" entries, one per active
  // secret (two while a secret is being rotated); any one matching is enough.
  for (const entry of signature.split(' ')) {
    const [version, sig] = entry.split(',');
    if (version !== 'v1' || !sig) continue;
    const given = Buffer.from(sig, 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      return;
    }
  }
  throw new Error('no matching signature');
}
