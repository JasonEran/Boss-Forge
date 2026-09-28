import type { Page } from "puppeteer-core";
import type { LoginMethod } from "./login-method.js";

export function isBossLoginPage(page: Pick<Page, "url">): boolean {
  try {
    const url = new URL(page.url());
    return url.protocol === "https:" && (url.hostname === "zhipin.com" || url.hostname.endsWith(".zhipin.com")) &&
      /^\/web\/user\/?$/.test(url.pathname);
  } catch { return false; }
}

/** Observe the current page only; never refresh a QR or dismiss a dialog. */
export async function readLoginPageFeedback(page: Page, preferred: LoginMethod) {
  // A string avoids tsx/esbuild injecting Node-only helpers into browser code.
  const observed = await page.evaluate(`(() => {
    const visible = element => Boolean(element &&
      element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 &&
      getComputedStyle(element).visibility !== "hidden");
    const dialog = [...document.querySelectorAll('.dialog-container, .dialog-wrap, .dialog, [role="dialog"]')]
      .find(element => visible(element) && element.querySelector('.dialog-body'));
    const dialogText = (dialog?.querySelector('.dialog-body')?.textContent ?? '').trim().slice(0, 300);
    const wechat = visible(document.querySelector('.scan-wx-wrapper'));
    const app = visible(document.querySelector('.scan-app-wrapper'));
    const root = document.querySelector(wechat ? '.scan-wx-wrapper' : '.scan-app-wrapper');
    const text = root?.innerText ?? '';
    const qr = root?.querySelector(wechat ? 'img.mini-qrcode' : '.qr-img-box img');
    return { dialogText, wechat, app, text, qr: qr?.src ?? '' };
  })()`) as { dialogText: string; wechat: boolean; app: boolean; text: string; qr: string };
  const loginMethod: LoginMethod = observed.wechat ? "wechat" : observed.app ? "boss_app" : preferred;
  const appLoginRequired = /^为更好保障您的招聘安全[，,]\s*请使用\s*BOSS\s*直聘\s*APP\s*扫码登录[。.!！]?$/iu.test(observed.dialogText);
  const message = appLoginRequired
    ? "BOSS 要求此账号使用 BOSS 直聘 App 扫码登录。请切换到「BOSS App 扫码」，再用手机 App 确认。"
    : observed.dialogText
      ? `BOSS 提示：${observed.dialogText}`
      : /过期|失效|重新刷新二维码|点击刷新/u.test(observed.text)
        ? "二维码已过期，请点击「立即刷新二维码」。"
        : /扫码成功|扫描成功|请在手机上确认|等待.*确认/u.test(observed.text)
          ? `已扫码，请在${loginMethod === "boss_app" ? "BOSS 直聘 App" : "微信小程序"}中确认登录。`
          : loginMethod === "boss_app"
            ? "请使用 BOSS 直聘 App「我的 → 登录网页版」扫描二维码，并在手机上确认登录。"
            : "请使用微信扫一扫，打开 BOSS 直聘小程序并确认登录。";
  return { loginMethod, appLoginRequired, message, dialogText: observed.dialogText,
    // Include the QR identity so another administrator sees a changed code.
    signature: JSON.stringify([loginMethod, message, observed.qr]) };
}
