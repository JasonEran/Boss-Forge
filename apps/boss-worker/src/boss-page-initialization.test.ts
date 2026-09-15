import { describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { getBossCliInstallation } from '@boss-forge/boss-cli-adapter';
const { packageRoot } = await getBossCliInstallation();
const { installBossPageGuards } = await import(pathToFileURL(`${packageRoot}/dist/common/boss_page_guards.js`).href);
function fixture() {
  const session = { send: vi.fn(async (_method: string): Promise<void> => {}), on: vi.fn() };
  const page = { isClosed: () => false, evaluateOnNewDocument: vi.fn(async (): Promise<void> => {}), evaluate: vi.fn(async () => undefined), on: vi.fn(), createCDPSession: vi.fn(async () => session) };
  return { page, session };
}
describe('BOSS page initialization concurrency', () => {
  it('shares the pending installation between targetcreated and explicit preparation', async () => {
    const f = fixture();
    let release!: () => void;
    f.page.evaluateOnNewDocument.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const a = installBossPageGuards(f.page), b = installBossPageGuards(f.page);
    expect(f.page.evaluateOnNewDocument).toHaveBeenCalledTimes(1);
    release(); await Promise.all([a, b]);
    await installBossPageGuards(f.page);
    expect(f.page.evaluate).toHaveBeenCalledTimes(1);
    expect(f.page.createCDPSession).toHaveBeenCalledTimes(1);
    expect(f.session.send.mock.calls.filter(([method]) => method === 'Fetch.enable')).toHaveLength(1);
  });
  it('allows retry after a failed installation', async () => {
    const f = fixture();
    f.page.evaluateOnNewDocument.mockRejectedValueOnce(new Error('page loading'));
    await expect(installBossPageGuards(f.page)).rejects.toThrow('page loading');
    await installBossPageGuards(f.page);
    expect(f.page.evaluateOnNewDocument).toHaveBeenCalledTimes(2);
    expect(f.page.createCDPSession).toHaveBeenCalledTimes(1);
  });
});
