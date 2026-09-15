import { afterEach, describe, expect, it, vi } from 'vitest';
import { releaseResumeBrowserAfterDwell, remainingResumeDwellMs } from './resume-dwell.js';

afterEach(() => vi.useRealTimers());

describe('dwell after complete resume load', () => {
  it('starts ten seconds after a slow load, regardless of earlier navigation time', () => {
    const loadedAt = 45_000;
    expect(remainingResumeDwellMs(loadedAt, 45_000, 10)).toBe(10_000);
    expect(remainingResumeDwellMs(loadedAt, 48_000, 10)).toBe(7_000);
    expect(remainingResumeDwellMs(loadedAt, 55_000, 10)).toBe(0);
  });
  it('does not add another dwell after slow recognition or pretend a failed load was ready', () => {
    expect(remainingResumeDwellMs(45_000, 80_000, 10)).toBe(0);
    expect(remainingResumeDwellMs(null, 240_000, 10)).toBe(0);
  });

  it('preserves the full reading dwell while releasing before slow backend work finishes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(45_000);
    const releaseBrowser = vi.fn(async () => undefined);
    const wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
    let backendFinished = false;
    const backend = wait(60_000).then(() => { backendFinished = true; });
    const released = releaseResumeBrowserAfterDwell(45_000, 10, wait, releaseBrowser);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(releaseBrowser).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await released;
    expect(releaseBrowser).toHaveBeenCalledTimes(1);
    expect(backendFinished).toBe(false);
    await vi.advanceTimersByTimeAsync(50_000);
    await backend;
    expect(releaseBrowser).toHaveBeenCalledTimes(1);
  });

  it('credits capture persistence time but never navigation time toward the reading dwell', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(49_000);
    const releaseBrowser = vi.fn(async () => undefined);
    const wait = vi.fn((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
    const released = releaseResumeBrowserAfterDwell(45_000, 10, wait, releaseBrowser);

    expect(wait).toHaveBeenCalledWith(6_000);
    await vi.advanceTimersByTimeAsync(5_999);
    expect(releaseBrowser).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await released;
    expect(releaseBrowser).toHaveBeenCalledTimes(1);
  });

  it('does not release from the timer when waiting fails', async () => {
    const releaseBrowser = vi.fn(async () => undefined);
    const waitFailure = new Error('wait cancelled');
    await expect(releaseResumeBrowserAfterDwell(Date.now(), 10, async () => { throw waitFailure; }, releaseBrowser)).rejects.toBe(waitFailure);
    expect(releaseBrowser).not.toHaveBeenCalled();
  });
});
