import { describe, expect, it, vi } from 'vitest';
import { createCommunicationSyncCache } from './communication-sync.js';
describe('account inbox scan sharing', () => {
  it('shares concurrent scans and a short fresh result only within the same account', async () => {
    let now = 0;
    const cache = createCommunicationSyncCache<string>(() => now),
      scan = vi.fn(async () => 'fresh');
    expect(await Promise.all([cache('one', scan), cache('one', scan)])).toEqual(
      ['fresh', 'fresh'],
    );
    expect(scan).toHaveBeenCalledTimes(1);
    await cache('one', scan);
    await cache('two', scan);
    expect(scan).toHaveBeenCalledTimes(2);
    now = 2001;
    await cache('one', scan);
    expect(scan).toHaveBeenCalledTimes(3);
  });
  it('retries after a failed connection instead of caching the failure', async () => {
    const cache = createCommunicationSyncCache(),
      scan = vi
        .fn()
        .mockRejectedValueOnce(new Error('disconnected'))
        .mockResolvedValue('recovered');
    await expect(cache('one', scan)).rejects.toThrow('disconnected');
    await expect(cache('one', scan)).resolves.toBe('recovered');
  });
});
