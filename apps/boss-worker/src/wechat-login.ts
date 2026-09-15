import type { Page } from "puppeteer-core";

const modeReady = `(() => {
  if (!location.pathname.startsWith('/web/user')) return true;
  return ['.scan-wx-wrapper .mini-qrcode', 'a.wx-login-btn[ka="wx_signin"]', '.btn-sign-switch.phone-switch']
    .some(selector => { const el = document.querySelector(selector); return el && el.getBoundingClientRect().width > 0; });
})()`;

function isLoginPage(page: Page): boolean {
  const url = new URL(page.url());
  return (url.hostname === "zhipin.com" || url.hostname.endsWith(".zhipin.com")) &&
    /^\/web\/user\/?$/.test(url.pathname);
}

async function visible(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((selector) => {
    const element = document.querySelector(selector);
    return Boolean(element && element.getBoundingClientRect().width > 0);
  }, selector);
}

/** Select BOSS's native WeChat mini-program flow. Request a new code only on
 * entry, an expired code, or an explicit refresh; never fall back to App QR. */
export async function ensureWechatLoginQr(page: Page, refresh = false): Promise<void> {
  if (!isLoginPage(page)) return;
  await page.waitForFunction(modeReady, { timeout: 15_000 });
  if (!isLoginPage(page)) return;

  const inWechat = await visible(page, ".scan-wx-wrapper .mini-qrcode");
  const refreshButton = 'button[ka="refresh_miniapp_sao_qrcode"]';
  const expired = inWechat && await visible(page, refreshButton);
  const previousCode = inWechat && (refresh || expired)
    ? await page.$eval(".scan-wx-wrapper .mini-qrcode", image => (image as HTMLImageElement).src)
    : null;
  if (expired) {
    await page.click(refreshButton);
  } else if (!inWechat || refresh) {
    if (inWechat) {
      // An unexpired code has no refresh button. Re-enter the same native
      // WeChat flow instead of reloading into the default App QR mode.
      await page.click(".scan-wx-wrapper .sms-login-btn");
    } else if (await visible(page, ".btn-sign-switch.phone-switch")) {
      await page.click(".btn-sign-switch.phone-switch");
    }
    await page.waitForFunction(`(() => {
      if (!location.pathname.startsWith('/web/user')) return true;
      const entry = document.querySelector('a.wx-login-btn[ka="wx_signin"]');
      return Boolean(entry && entry.getBoundingClientRect().width > 0);
    })()`, { timeout: 10_000 });
    if (!isLoginPage(page)) return;
    await page.click('a.wx-login-btn[ka="wx_signin"]');
  }
  await page.waitForFunction((previousCode) => {
    if (!location.pathname.startsWith('/web/user')) return true;
    const image = document.querySelector<HTMLImageElement>('.scan-wx-wrapper .mini-app-login img.mini-qrcode');
    const overdue = document.querySelector('.scan-wx-wrapper .mini-overdue');
    return Boolean(image && image.getBoundingClientRect().width > 0 && image.complete && image.naturalWidth > 0 &&
      (!previousCode || image.src !== previousCode) && (!overdue || overdue.getBoundingClientRect().width === 0));
  }, { timeout: 20_000 }, previousCode);
}
