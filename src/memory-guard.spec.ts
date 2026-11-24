import { memoryLimitMb, watchMemory } from './memory-guard';

describe('memoryLimitMb', () => {
  it('guards a server pm2 runs, and no other unless asked', () => {
    expect(memoryLimitMb({ pm_id: '0' })).toBe(5_000);
    expect(memoryLimitMb({})).toBeUndefined();
    expect(memoryLimitMb({ MEMORY_LIMIT_MB: '3000' })).toBe(3_000);
  });

  it('can be changed or switched off', () => {
    expect(memoryLimitMb({ pm_id: '0', MEMORY_LIMIT_MB: '4000' })).toBe(4_000);
    expect(memoryLimitMb({ pm_id: '0', MEMORY_LIMIT_MB: '0' })).toBeUndefined();
    expect(memoryLimitMb({ pm_id: '0', MEMORY_LIMIT_MB: 'big' })).toBe(5_000);
  });
});

describe('watchMemory', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const run = (readings: number[]) => {
    const restart = jest.fn();
    let i = 0;
    watchMemory(
      100,
      restart,
      () => readings[Math.min(i++, readings.length - 1)],
    );
    jest.advanceTimersByTime(15_000 * 10);
    return restart;
  };

  it('restarts once when memory stays over the limit', () => {
    expect(run([50, 101, 102])).toHaveBeenCalledTimes(1);
  });

  it('lets a spike pass, and memory under the limit be', () => {
    expect(run([101, 50, 101, 50])).not.toHaveBeenCalled();
    expect(run([100])).not.toHaveBeenCalled();
  });
});
