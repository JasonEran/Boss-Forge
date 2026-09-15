import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// Execute the installed preview function's failure path with browser I/O stubbed.
// This checks the patched dependency that the worker actually launches.
const require = createRequire(import.meta.url);
const source = readFileSync(require.resolve('@joohw/boss-cli/dist/toolset/preview.js'), 'utf8');
const functionSource = source.slice(source.indexOf('export async function runPreview')).replace('export async function', 'async function');

describe('a failed resume capture preserves the collected candidate pool', () => {
  it.each([false, true])('closes the panel without reloading when initial content readiness is %s', async (ready) => {
    const page = { url: () => 'https://www.zhipin.com/web/chat/recommend', reload: vi.fn() };
    const close = vi.fn();
    const capture = vi.fn().mockResolvedValue(false);
    const open = vi.fn().mockResolvedValue(true);
    const runPreview = runInNewContext(`${functionSource}\nrunPreview`, {
      withBossSessionPage: (callback: (page: unknown) => unknown) => callback(page),
      isBossChatAiFormUrl: () => false, isBossChatRecommendUrl: () => true,
      assertRecommendPageReadyForPreview: async () => ({}),
      snapshotBossPageViewport: async () => ({}), openRecommendResumePreview: open,
      waitForCResumeIframeOrPaywall: async () => 'iframe', ONLINE_RESUME_IFRAME_WAIT_MAX_MS: 1,
      waitForVisibleCResumeIframeReady: async () => ready, closeCResumePanel: close,
      ensureAppDataLayout: () => undefined, safeResumeScreenshotFileBase: () => 'fixture',
      RESUME_SCREENSHOTS_DIR: '/tmp/isolated-preview-fixture', join: (...parts: string[]) => parts.join('/'),
      captureCResumeIframeToFile: capture,
    });
    await expect(runPreview({ candidateTarget: 'fixture' })).rejects.toThrow('BOSS_RESUME_CONTENT_EMPTY');
    expect(open).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledTimes(ready ? 1 : 0);
    expect(page.reload).not.toHaveBeenCalled();
  });
});
