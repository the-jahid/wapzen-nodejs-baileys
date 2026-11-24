import { AsyncLocalStorage } from 'node:async_hooks';
import {
  SharedAsyncStorage,
  withSharedAsyncStorage,
} from './shared-async-storage';

const asyncHooks = process.getBuiltinModule('node:async_hooks');
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe('SharedAsyncStorage', () => {
  it('keeps its value across awaits, and only inside run', async () => {
    const storage = new SharedAsyncStorage<string>();
    expect(storage.getStore()).toBeUndefined();
    const seen = await storage.run('a', async () => {
      await tick();
      return storage.getStore();
    });
    expect(seen).toBe('a');
    expect(storage.getStore()).toBeUndefined();
  });

  it("never shows one socket another socket's value", async () => {
    const one = new SharedAsyncStorage<string>();
    const two = new SharedAsyncStorage<string>();
    await one.run('1', async () => {
      expect(two.getStore()).toBeUndefined();
      await two.run('2', async () => {
        await tick();
        expect(two.getStore()).toBe('2');
        // As with separate storages, the outer one is still readable.
        expect(one.getStore()).toBe('1');
      });
      expect(two.getStore()).toBeUndefined();
    });
  });

  it('keeps runs at the same time apart', async () => {
    const storage = new SharedAsyncStorage<number>();
    const seen = await Promise.all(
      [1, 2, 3].map((n) =>
        storage.run(n, async () => {
          await tick();
          return storage.getStore();
        }),
      ),
    );
    expect(seen).toEqual([1, 2, 3]);
  });

  it('passes arguments, results and errors through', () => {
    const storage = new SharedAsyncStorage<number>();
    expect(storage.run(1, (a: number, b: number) => a + b, 2, 3)).toBe(5);
    expect(() =>
      storage.run(1, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(storage.getStore()).toBeUndefined();
  });
});

describe('withSharedAsyncStorage', () => {
  it('swaps the class only while it runs, and counts what was made', () => {
    const { result, shared } = withSharedAsyncStorage(
      () => new asyncHooks.AsyncLocalStorage(),
    );
    expect(result).toBeInstanceOf(SharedAsyncStorage);
    expect(shared).toBe(1);
    expect(asyncHooks.AsyncLocalStorage).toBe(AsyncLocalStorage);
    expect(new asyncHooks.AsyncLocalStorage()).not.toBeInstanceOf(
      SharedAsyncStorage,
    );
  });

  it('puts the class back when it throws', () => {
    const original = asyncHooks.AsyncLocalStorage;
    expect(() =>
      withSharedAsyncStorage(() => {
        throw new Error('no socket');
      }),
    ).toThrow('no socket');
    expect(asyncHooks.AsyncLocalStorage).toBe(original);
  });

  it("makes a socket outside another socket's context", () => {
    const storage = new SharedAsyncStorage<string>();
    storage.run('old socket', () => {
      const { result } = withSharedAsyncStorage(() => storage.getStore());
      expect(result).toBeUndefined();
      expect(storage.getStore()).toBe('old socket');
    });
  });
});
