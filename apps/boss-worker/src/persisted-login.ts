import type { Page } from 'puppeteer-core';

/** Network idle is only a settling hint; BOSS may keep background requests
 * open even after redirecting to a usable login page. The caller must still
 * verify the rendered session or prepare the actual QR page afterwards. */
export async function openPersistedBossPage(
  page: Pick<Page, 'goto' | 'waitForNetworkIdle'>
): Promise<void> {
  await page.goto('https://www.zhipin.com/web/chat/job/list', {
    waitUntil: 'domcontentloaded', timeout: 30_000
  });
  try {
    await page.waitForNetworkIdle({ idleTime: 700, timeout: 15_000 });
  } catch (error: unknown) {
    if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
  }
}

/** Cookie presence is only a reason to try the normal recruiter page. BOSS and
 * the rendered page still decide whether the session is authenticated. */
export function hasPersistedBossLogin(
  cookies: readonly { name: string; domain: string; expires: number; value: string }[],
  nowMs = Date.now()
): boolean {
  return cookies.some(cookie => {
    const domain = cookie.domain.replace(/^\./u, '').toLowerCase();
    return (domain === 'zhipin.com' || domain.endsWith('.zhipin.com')) &&
      ['wt2', 'zp_at'].includes(cookie.name) && cookie.value.length > 0 &&
      (cookie.expires === -1 || cookie.expires * 1000 > nowMs);
  });
}
