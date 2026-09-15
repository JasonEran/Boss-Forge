import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cachedRequest,
  clearRequestCache,
  sharedRequest,
} from './request-cache';
afterEach(() => {
  clearRequestCache();
  vi.useRealTimers();
});
describe('workspace data reuse', () => {
  it('shares concurrent reads while retaining fresh reads after the first completes', async () => {
    const fetcher = vi.fn(async () => ({ count: 4 }));
    const [a, b] = await Promise.all([
      sharedRequest('user-a', '/tasks', fetcher),
      sharedRequest('user-a', '/tasks', fetcher),
    ]);
    expect(a).toEqual(b);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cachedRequest('user-a', '/tasks')).toEqual({ count: 4 });
    await sharedRequest('user-a', '/tasks', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps different authenticated sessions separate', async () => {
    await sharedRequest('user-a', '/tasks', async () => ['private']);
    expect(cachedRequest('user-b', '/tasks')).toBeNull();
  });
  it('discards old data and does not restore a snapshot invalidated by a mutation', async () => {
    let finish!: (value: string) => void;
    const old = sharedRequest(
      'a',
      '/tasks',
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    clearRequestCache();
    await sharedRequest('a', '/tasks', async () => 'new');
    finish('old');
    await old;
    expect(cachedRequest('a', '/tasks')).toBe('new');
  });
  it('expires display snapshots and allows retry after failures', async () => {
    vi.useFakeTimers();
    await sharedRequest('a', '/tasks', async () => 2);
    vi.advanceTimersByTime(30_001);
    expect(cachedRequest('a', '/tasks')).toBeNull();
    await expect(
      sharedRequest('a', '/tasks', async () => {
        throw new Error('offline');
      }),
    ).rejects.toThrow('offline');
    expect(await sharedRequest('a', '/tasks', async () => 3)).toBe(3);
  });
});
