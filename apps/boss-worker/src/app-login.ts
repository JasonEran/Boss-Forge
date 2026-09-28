import type { Page } from "puppeteer-core";
import { isBossLoginPage, readLoginPageFeedback } from "./login-page-feedback.js";

async function visible(page: Page, selector: string): Promise<boolean> {
  return page.evaluate(selector => Boolean(document.querySelector(selector)?.getBoundingClientRect().width), selector);
}

/** Use native mode controls only, after an explicit App-mode request. Choosing
 * the mode does not scan the QR or confirm a login on the user's behalf. */
export async function ensureBossAppLoginQr(page: Page, refresh = false): Promise<void> {
  if (!isBossLoginPage(page)) return;
  const feedback = await readLoginPageFeedback(page, "boss_app");
  if (feedback.appLoginRequired) {
    const button = await page.$('[ka="dialog_sure"]');
    if (!button || !await button.evaluate(element => element.textContent?.trim() === "去扫码" && element.getBoundingClientRect().width > 0)) {
      throw new Error("BOSS 要求 App 扫码，但未找到官方「去扫码」入口。");
    }
    await button.click();
    refresh = false;
  } else if (feedback.dialogText) {
    throw new Error(`BOSS 提示：${feedback.dialogText}`);
  }
  await page.waitForFunction(`(() => {
    if (!['/web/user', '/web/user/'].includes(location.pathname)) return true;
    return ['.scan-app-wrapper', '.scan-wx-wrapper .sms-login-btn', '.btn-sign-switch.ewm-switch']
      .some(selector => document.querySelector(selector)?.getBoundingClientRect().width > 0);
  })()`, { timeout: 15_000 });
  if (!isBossLoginPage(page)) return;
  const inApp = await visible(page, ".scan-app-wrapper");
  const expired = inApp && await visible(page, '[ka="refresh_app_sao_qrcode"]');
  const previousCode = inApp && (refresh || expired)
    ? await page.$eval('.qr-img-box', element => element.querySelector('img')?.src ?? '') : '';
  if (expired) await page.click('[ka="refresh_app_sao_qrcode"]');
  else if (inApp && refresh) await page.click('.btn-sign-switch.phone-switch');
  if (!inApp || (refresh && !expired)) {
    if (await visible(page, '.scan-wx-wrapper .sms-login-btn')) await page.click('.scan-wx-wrapper .sms-login-btn');
    await page.waitForFunction(`(() => {
      if (!['/web/user', '/web/user/'].includes(location.pathname)) return true;
      return document.querySelector('.btn-sign-switch.ewm-switch')?.getBoundingClientRect().width > 0;
    })()`, { timeout: 10_000 });
    if (!isBossLoginPage(page)) return;
    await page.click('.btn-sign-switch.ewm-switch');
  }
  await page.waitForFunction(previousCode => {
    if (!/^\/web\/user\/?$/.test(location.pathname)) return true;
    const image = document.querySelector<HTMLImageElement>('.scan-app-wrapper .qr-img-box img');
    const refreshButton = document.querySelector('[ka="refresh_app_sao_qrcode"]');
    return Boolean(image && image.getBoundingClientRect().width > 0 && image.complete && image.naturalWidth > 0 &&
      (!previousCode || image.src !== previousCode) && !refreshButton?.getBoundingClientRect().width);
  }, { timeout: 20_000 }, previousCode);
}
