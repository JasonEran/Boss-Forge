import { afterEach, describe, expect, it, vi } from 'vitest';
import { GreetingRequestError, waitForGreeting } from './greeting-request';

describe('waiting for the BOSS browser before greeting setup', () => {
  afterEach(() => vi.useRealTimers());
  it('waits on confirmed busy responses and applies once the browser is free', async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockRejectedValueOnce(new GreetingRequestError('busy', 'busy'))
      .mockResolvedValue({ body: '你好' });
    const onWait = vi.fn();
    const result = waitForGreeting(request, {
      signal: new AbortController().signal,
      onWait,
    });
    await vi.advanceTimersByTimeAsync(2500);
    await expect(result).resolves.toEqual({ body: '你好' });
    expect(request).toHaveBeenCalledTimes(2);
    expect(onWait).toHaveBeenCalledOnce();
  });
  it.each([
    new Error('network timeout'),
    new GreetingRequestError('save unverified', 'unavailable'),
    new GreetingRequestError('login expired', 'not_authenticated'),
  ])(
    'never repeats a write with an uncertain result or expired login: %s',
    async (error) => {
      const request = vi.fn().mockRejectedValue(error);
      await expect(
        waitForGreeting(request, {
          signal: new AbortController().signal,
          onWait: vi.fn(),
        }),
      ).rejects.toBe(error);
      expect(request).toHaveBeenCalledOnce();
    },
  );
  it('stops waiting when the dialog unmounts, before another save can start', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const request = vi
      .fn()
      .mockRejectedValue(new GreetingRequestError('busy', 'busy'));
    const result = waitForGreeting(request, {
      signal: controller.signal,
      onWait: vi.fn(),
    });
    const rejected = expect(result).rejects.toMatchObject({
      name: 'AbortError',
    });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(5000);
    expect(request).toHaveBeenCalledOnce();
  });
  it('bounds the waiting period without starting another write after expiry', async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockRejectedValue(new GreetingRequestError('busy', 'busy'));
    const result = waitForGreeting(request, {
      signal: new AbortController().signal,
      onWait: vi.fn(),
      maxWaitMs: 3000,
    });
    const rejected = expect(result).rejects.toMatchObject({
      code: 'busy',
      message: expect.stringContaining('参考消息已保留'),
    });
    await vi.advanceTimersByTimeAsync(3000);
    await rejected;
    expect(request).toHaveBeenCalledTimes(2);
  });
});
