import type { CacheStore } from 'baileys';

// How long a key read from or written to whatsapp_auth is kept, as in Baileys.
const KEY_TTL_MS = 5 * 60_000;
// Keys kept per number. A chat needs a handful, and one dropped here costs a
// database read.
const MAX_KEYS = 500;

// A socket's recently used Signal keys, for makeCacheableSignalKeyStore. Its own
// default is a cache with no limit and a timer that nothing stops, so every
// reconnect left the old socket's keys behind (~58 KB each, measured with 20
// keys): expired ones for 10 minutes, the empty cache until the next restart.
// This one has no timer, so it goes when its socket does, and holds MAX_KEYS.
export class KeyCache implements CacheStore {
  private readonly entries = new Map<
    string,
    { value: unknown; until: number }
  >();

  constructor(
    private readonly max = MAX_KEYS,
    private readonly ttlMs = KEY_TTL_MS,
  ) {}

  get size() {
    return this.entries.size;
  }

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.until <= Date.now()) return undefined;
    // Re-inserting moves it to the end; the first key is the one idle longest.
    this.entries.set(key, entry);
    return entry.value as T;
  }

  set<T>(key: string, value: T) {
    this.entries.delete(key);
    this.entries.set(key, { value, until: Date.now() + this.ttlMs });
    if (this.entries.size > this.max) {
      const [oldest] = this.entries.keys();
      this.entries.delete(oldest);
    }
    return true;
  }

  del(key: string) {
    this.entries.delete(key);
  }

  flushAll() {
    this.entries.clear();
  }

  // Drops what has expired. A number nobody writes to never asks for its old
  // keys again, so nothing else would.
  sweep(now = Date.now()) {
    for (const [key, entry] of this.entries) {
      if (entry.until <= now) this.entries.delete(key);
    }
  }
}
