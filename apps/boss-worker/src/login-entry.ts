import type { Page } from 'puppeteer-core';

export function isBossPublicHomepage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['www.zhipin.com', 'zhipin.com'].includes(parsed.hostname) &&
      parsed.protocol === 'https:' && parsed.pathname === '/';
  } catch { return false; }
}

/** Expired credentials can redirect to the public homepage. Follow its actual
 * recruiter login link once; never redirect a verification or unrelated page. */
export async function openHomepageLogin(page: Pick<Page, 'url' | 'evaluate' | 'goto'>): Promise<boolean> {
  if (!isBossPublicHomepage(page.url())) return false;
  const href = await page.evaluate(() => {
    const link = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')]
      .find(a => a.textContent?.trim() === '我要招聘' && a.getBoundingClientRect().width > 0);
    return link?.href ?? null;
  });
  if (!href || !isBossPublicHomepage(page.url())) return false;
  const target = new URL(href);
  if (target.protocol !== 'https:' || !['www.zhipin.com', 'zhipin.com'].includes(target.hostname) ||
    !/^\/web\/user\/?$/.test(target.pathname) || target.username || target.password || target.port) return false;
  await page.goto(href, { waitUntil: 'load', timeout: 30_000 });
  return true;
}
