import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { withScreeningBrowser } from './workspace-browser.js';
import { acquireAccountLock } from './account-lock.js';

describe('communication/screening browser handoff', () => {
  it('does not claim while paused, including a switch while waiting for the lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'browser-handoff-'));
    vi.stubEnv('BOSS_FORGE_RUNTIME_DIR', dir);
    try {
      const operation = vi.fn(async () => true);
      expect(await withScreeningBrowser('account-test', { communicationActive: async () => true }, operation)).toBe(false);
      let checks = 0;
      expect(await withScreeningBrowser('account-test', { communicationActive: async () => ++checks > 1 }, operation)).toBe(false);
      expect(operation).not.toHaveBeenCalled();
      expect(await withScreeningBrowser('account-test', { communicationActive: async () => false }, operation)).toBe(true);
      expect(operation).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); }
  });
  it('keeps the current operation protected until saved, then yields and resumes later', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'browser-handoff-'));
    vi.stubEnv('BOSS_FORGE_RUNTIME_DIR', dir);
    try {
      let paused = false;
      const activity = { communicationActive: async () => paused };
      let finish!: () => void;
      const saved = new Promise<void>(resolve => { finish = resolve; });
      let start!: () => void;
      const started = new Promise<void>(resolve => { start = resolve; });
      const running = withScreeningBrowser('account-test', activity, async () => { start(); await saved; return true; });
      await started; paused = true;
      await expect(acquireAccountLock('account-test', { timeoutMs: 1, pollMs: 10 })).rejects.toThrow('Timed out waiting');
      finish(); expect(await running).toBe(true);
      const chat = await acquireAccountLock('account-test'); await chat.release();
      const next = vi.fn(async () => true);
      expect(await withScreeningBrowser('account-test', activity, next)).toBe(false);
      expect(next).not.toHaveBeenCalled();
      paused = false;
      expect(await withScreeningBrowser('account-test', activity, next)).toBe(true);
    } finally { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); }
  });
});
