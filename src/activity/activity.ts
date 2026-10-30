// The lines the production log is for: who signed up, who signed in, and how
// their WhatsApp logins went. Printed whatever VERBOSE_LOGS says, which only
// switches the rest of the server's logging.

// A signed-in dashboard sends a request every few seconds, so a user gets a
// new line only after this long away.
const QUIET_MS = 30 * 60_000;
const MAX_TRACKED = 10_000;

const lastSeen = new Map<string, number>();

export function activity(line: string) {
  process.stdout.write(`${line}\n`);
}

// The guard and the Clerk webhook both see a new user, in either order.
export function userSignedUp(clerkId: string, email: string) {
  onceInAWhile(`signed-up ${clerkId}`, `user signed up: ${email}`);
}

export function userSignedIn(clerkId: string, email: string) {
  onceInAWhile(`signed-in ${clerkId}`, `user signed in: ${email}`);
}

export function signInFailed(clerkId: string, reason: string) {
  const lastLine = reason.trim().split('\n').pop();
  onceInAWhile(
    `sign-in-failed ${clerkId}`,
    `sign-in failed: ${clerkId} - ${lastLine}`,
  );
}

function onceInAWhile(key: string, line: string) {
  const now = Date.now();
  const previous = lastSeen.get(key);
  if (lastSeen.size >= MAX_TRACKED) lastSeen.clear();
  lastSeen.set(key, now);
  if (previous === undefined || now - previous >= QUIET_MS) activity(line);
}
