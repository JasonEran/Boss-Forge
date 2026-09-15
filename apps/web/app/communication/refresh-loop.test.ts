import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommunicationRefreshLoop } from './refresh-loop';
afterEach(() => vi.useRealTimers());
const deferred = () => {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((r) => {
      resolve = r;
    }),
    resolve: () => resolve(),
  };
};
describe('continuous communication refresh', () => {
  it('keeps refreshing replies when an inbox scan fails and schedules another cycle', async () => {
    vi.useFakeTimers();
    const inbox = vi
        .fn()
        .mockRejectedValueOnce(new Error('temporary'))
        .mockResolvedValue(undefined),
      thread = vi.fn(async () => {}),
      errors = vi.fn();
    const loop = createCommunicationRefreshLoop({
      canRun: () => true,
      readInbox: inbox,
      readThread: thread,
      onError: errors,
      onBusy: () => {},
      intervalMs: 5000,
    });
    await loop.wake();
    expect(thread).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledWith('inbox', expect.any(Error));
    await vi.advanceTimersByTimeAsync(5000);
    expect(inbox).toHaveBeenCalledTimes(2);
    expect(thread).toHaveBeenCalledTimes(2);
    loop.stop();
  });
  it('coalesces fast selection changes without overlapping native reads', async () => {
    vi.useFakeTimers();
    const gate = deferred();
    let active = 0,
      max = 0;
    const inbox = vi.fn(async () => {
      active++;
      max = Math.max(max, active);
      await gate.promise;
      active--;
    });
    const loop = createCommunicationRefreshLoop({
      canRun: () => true,
      readInbox: inbox,
      readThread: async () => {},
      onError: () => {},
      onBusy: () => {},
      intervalMs: 5000,
    });
    const running = loop.wake();
    await Promise.resolve();
    void loop.wake();
    void loop.wake();
    expect(inbox).toHaveBeenCalledTimes(1);
    gate.resolve();
    await running;
    await vi.advanceTimersByTimeAsync(0);
    expect(inbox).toHaveBeenCalledTimes(2);
    expect(max).toBe(1);
    loop.stop();
  });
  it('pauses while hidden or writing, and refreshes immediately on return', async () => {
    vi.useFakeTimers();
    let available = false;
    const inbox = vi.fn(async () => {});
    const loop = createCommunicationRefreshLoop({
      canRun: () => available,
      readInbox: inbox,
      readThread: async () => {},
      onError: () => {},
      onBusy: () => {},
      intervalMs: 5000,
    });
    await loop.wake();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(inbox).not.toHaveBeenCalled();
    available = true;
    await loop.wake();
    expect(inbox).toHaveBeenCalledTimes(1);
    loop.stop();
  });
  it('does not read another conversation or restart after the page unmounts mid-request', async () => {
    vi.useFakeTimers();
    const gate = deferred(),
      thread = vi.fn(async () => {});
    const loop = createCommunicationRefreshLoop({
      canRun: () => true,
      readInbox: () => gate.promise,
      readThread: thread,
      onError: () => {},
      onBusy: () => {},
      intervalMs: 5000,
    });
    const run = loop.wake();
    await Promise.resolve();
    loop.stop();
    gate.resolve();
    await run;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(thread).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
