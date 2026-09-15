import { describe, expect, it } from 'vitest';
import { remainingResumeDwellMs } from './resume-dwell.js';

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
});
