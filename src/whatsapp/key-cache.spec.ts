import { KeyCache } from './key-cache';

describe('KeyCache', () => {
  afterEach(() => jest.useRealTimers());

  it('returns what was set, a deleted key (null) included', () => {
    const cache = new KeyCache();
    cache.set('session.1', { a: 1 });
    cache.set('pre-key.1', null);
    expect(cache.get('session.1')).toEqual({ a: 1 });
    expect(cache.get('pre-key.1')).toBeNull();
    expect(cache.get('session.2')).toBeUndefined();
  });

  it('holds no more than its limit, dropping the one idle longest', () => {
    const cache = new KeyCache(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);
    expect(cache.size).toBe(2);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
  });

  it('forgets a key once it expires, and sweep drops the unasked-for', () => {
    jest.useFakeTimers();
    const cache = new KeyCache(10, 1_000);
    cache.set('a', 1);
    cache.set('b', 2);
    jest.advanceTimersByTime(999);
    expect(cache.get('a')).toBe(1);
    cache.sweep();
    expect(cache.size).toBe(2);
    jest.advanceTimersByTime(1);
    expect(cache.get('a')).toBeUndefined();
    cache.sweep();
    expect(cache.size).toBe(0);
  });

  it('keeps no timer, so it goes when its socket does', () => {
    jest.useFakeTimers();
    new KeyCache().set('a', 1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('deletes and flushes', () => {
    const cache = new KeyCache();
    cache.set('a', 1);
    cache.set('b', 2);
    cache.del('a');
    expect(cache.get('a')).toBeUndefined();
    cache.flushAll();
    expect(cache.size).toBe(0);
  });
});
