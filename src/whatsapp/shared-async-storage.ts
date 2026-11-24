import { syncBuiltinESMExports } from 'node:module';
// Baileys makes an AsyncLocalStorage for every socket (addTransactionCapability).
// Before Node 24, one that was ever used stays in a list inside Node for as long
// as the process lives, closed socket or not, and Node writes one property for
// each of them onto every promise and timer made from then on. Measured on Node
// 22 (2026-11-25), one promise:
//
//   sockets used since the start      1       200     1,000     3,000
//   bytes                           131    12,438    49,290   196,701
//   microseconds to make           0.3        12        55       207
//
// So the server got slower and heavier with every reconnect, until a busy moment
// (a reply, a reconnect wave) needed gigabytes and the heap ran out, with
// NameDictionary::Add on the stack. Here every socket shares one real
// AsyncLocalStorage instead, each seeing only its own value in it.

// The module object itself, so its export can be swapped.
const asyncHooks = process.getBuiltinModule('node:async_hooks');

type Frame = { owner: object; store: unknown; outer: Frame | undefined };

const frames = new asyncHooks.AsyncLocalStorage<Frame | undefined>();
let made = 0;

// The two methods Baileys uses.
export class SharedAsyncStorage<T> {
  constructor() {
    made += 1;
  }

  getStore(): T | undefined {
    for (let frame = frames.getStore(); frame; frame = frame.outer) {
      if (frame.owner === this) return frame.store as T;
    }
    return undefined;
  }

  run<A extends unknown[], R>(
    store: T,
    work: (...args: A) => R,
    ...args: A
  ): R {
    const frame = { owner: this, store, outer: frames.getStore() };
    return frames.run(frame, work, ...args);
  }
}

// Runs make, in which every AsyncLocalStorage made is a shared one, and says how
// many that was: none means a newer Baileys makes its own somewhere else. The
// swap lasts only as long as make, which must be synchronous, so nothing else in
// the server ever sees it. make also starts outside any socket's context: the
// timers and the websocket it opens would otherwise keep that context, and what
// the transaction in it had read, alive for as long as the new socket is.
export function withSharedAsyncStorage<R>(make: () => R): {
  result: R;
  shared: number;
} {
  const original = Object.getOwnPropertyDescriptor(
    asyncHooks,
    'AsyncLocalStorage',
  )!;
  const before = made;
  Object.defineProperty(asyncHooks, 'AsyncLocalStorage', {
    configurable: true,
    enumerable: true,
    get: () => SharedAsyncStorage,
  });
  syncBuiltinESMExports();
  try {
    const result = frames.run(undefined, make);
    return { result, shared: made - before };
  } finally {
    Object.defineProperty(asyncHooks, 'AsyncLocalStorage', original);
    syncBuiltinESMExports();
  }
}
