import { describe, expect, it, vi } from 'vitest';
import { isBossPublicHomepage, openHomepageLogin } from './login-entry.js';
function page(url: string, href = 'https://www.zhipin.com/web/user/?intent=1') {
  return { url: vi.fn(() => url), evaluate: vi.fn().mockResolvedValue(href), goto: vi.fn().mockResolvedValue(null) };
}
describe('logged-out homepage login recovery', () => {
  it('follows the observed recruiter entry after expired credentials redirect home', async () => {
    const p = page('https://www.zhipin.com/');
    await expect(openHomepageLogin(p)).resolves.toBe(true);
    expect(p.goto).toHaveBeenCalledExactlyOnceWith('https://www.zhipin.com/web/user/?intent=1', {waitUntil:'load',timeout:30000});
  });
  it('does not navigate verification, authenticated or unrelated pages', async () => {
    for(const url of ['https://www.zhipin.com/web/user/safe/','https://www.zhipin.com/web/common/security/','https://www.zhipin.com/web/passport/','https://www.zhipin.com/web/chat/job/list','https://zhipin.com.evil.test/','http://www.zhipin.com/','about:blank']) {
      const p=page(url);expect(isBossPublicHomepage(url)).toBe(false);await expect(openHomepageLogin(p)).resolves.toBe(false);expect(p.evaluate).not.toHaveBeenCalled();expect(p.goto).not.toHaveBeenCalled();
    }
  });
  it('rejects missing, off-site or non-login destinations', async () => {
    for(const href of [null,'https://www.zhipin.com.evil.test/web/user/','https://www.zhipin.com/web/user/safe/','http://www.zhipin.com/web/user/','https://name:secret@www.zhipin.com/web/user/','https://www.zhipin.com:8443/web/user/']) {
      const p=page('https://www.zhipin.com/');p.evaluate.mockResolvedValue(href);await expect(openHomepageLogin(p)).resolves.toBe(false);expect(p.goto).not.toHaveBeenCalled();
    }
  });
  it('preserves a navigation into verification while reading the login link', async () => {
    const p=page('https://www.zhipin.com/');p.url.mockReturnValueOnce('https://www.zhipin.com/').mockReturnValue('https://www.zhipin.com/web/common/security/');
    await expect(openHomepageLogin(p)).resolves.toBe(false);expect(p.goto).not.toHaveBeenCalled();
  });
});
