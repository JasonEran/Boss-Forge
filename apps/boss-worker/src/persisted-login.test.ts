import { describe, expect, it, vi } from 'vitest';
import { hasPersistedBossLogin, openPersistedBossPage } from './persisted-login.js';
const now = Date.UTC(2026, 8, 7);
const cookie = {name:'wt2',domain:'.zhipin.com',value:'synthetic-test-token',expires:now/1000+3600};
describe('existing BOSS login detection', () => {
  it('continues to page verification when only network idle times out', async () => {
    const timeout = Object.assign(new Error('Timed out after waiting 15000ms'), { name: 'TimeoutError' });
    const page = { goto: vi.fn().mockResolvedValue(null), waitForNetworkIdle: vi.fn().mockRejectedValue(timeout) };
    await expect(openPersistedBossPage(page)).resolves.toBeUndefined();
    expect(page.goto).toHaveBeenCalledExactlyOnceWith('https://www.zhipin.com/web/chat/job/list', { waitUntil: 'domcontentloaded', timeout: 30000 });
  });
  it('preserves a broken browser connection instead of ignoring it as network activity', async () => {
    const failure = new Error('Target closed');
    const page = { goto: vi.fn().mockResolvedValue(null), waitForNetworkIdle: vi.fn().mockRejectedValue(failure) };
    await expect(openPersistedBossPage(page)).rejects.toBe(failure);
  });
  it('does not suppress a navigation timeout before the page has loaded', async () => {
    const timeout = Object.assign(new Error('Navigation timed out'), { name: 'TimeoutError' });
    const page = { goto: vi.fn().mockRejectedValue(timeout), waitForNetworkIdle: vi.fn() };
    await expect(openPersistedBossPage(page)).rejects.toBe(timeout);
    expect(page.waitForNetworkIdle).not.toHaveBeenCalled();
  });
  it('tries persisted or current-process session credentials before requesting another scan', () => {
    expect(hasPersistedBossLogin([cookie], now)).toBe(true);
    expect(hasPersistedBossLogin([{...cookie,name:'zp_at',expires:-1}], now)).toBe(true);
  });
  it('does not mistake analytics, empty, expired or unrelated cookies for login credentials', () => {
    expect(hasPersistedBossLogin([], now)).toBe(false);
    for (const value of [{...cookie,name:'ab_guid'}, {...cookie,value:''}, {...cookie,expires:now/1000-1}, {...cookie,domain:'evilzhipin.com'}, {...cookie,domain:'zhipin.com.example.test'}]) expect(hasPersistedBossLogin([value], now)).toBe(false);
  });
});
