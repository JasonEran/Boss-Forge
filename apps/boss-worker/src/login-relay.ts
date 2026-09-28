import { isBossPublicHomepage, openHomepageLogin } from './login-entry.js';
import { consumeLoginRefreshRequest } from "./login-refresh-request.js";
import { LOGIN_BROWSER_RESTART_EXIT_CODE, LoginBrowserRestartRequested } from "./session-recovery.js";
import { rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  installBossPageGuards,
  probeLoggedInFromPage
} from "@boss-forge/boss-cli-adapter";
import {
  contactDispatchModeFromEnvironment,
  resumeViewPolicyFromEnvironment,
  type ContactDispatchMode
} from "@boss-forge/contracts";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { isBossRiskSignal } from "./boss-risk.js";
import { ensureRuntimeDirectory } from "./runtime.js";
import { hasPersistedBossLogin, openPersistedBossPage } from "./persisted-login.js";
import { ensureWechatLoginQr } from "./wechat-login.js";
import { ensureBossAppLoginQr } from "./app-login.js";
import { readLoginMethod, type LoginMethod } from "./login-method.js";
import { readLoginPageFeedback } from "./login-page-feedback.js";

type RelayState =
  | "starting"
  | "refreshing"
  | "awaiting_scan"
  | "authenticated"
  | "risk_controlled"
  | "error";

type RelayStatus = {
  state: RelayState;
  message: string;
  updatedAt: string;
  imageUpdatedAt: string | null;
  loginMethod?: LoginMethod;
  appLoginRequired?: boolean;
  releaseId: string;
  contactDispatchMode: ContactDispatchMode;
  resumePolicy: ReturnType<typeof resumeViewPolicyFromEnvironment>;
  verification: {
    method: "login_relay_page_observation";
    browserAuthenticated: boolean;
    workerHeartbeatFresh: false;
    verifiedAt: string;
  };
};

const pollMs = Math.max(
  500,
  Number(process.env.BOSS_FORGE_LOGIN_RELAY_POLL_MS ?? "1000")
);
const debuggingPort = Number(
  process.env.BOSS_BROWSER_REMOTE_DEBUGGING_PORT ?? "53470"
);
const bossLoginUrl = "https://www.zhipin.com/web/user/?ka=header-login";
const releaseId = process.env.BOSS_FORGE_RELEASE_ID?.trim() || "unversioned";
const contactDispatchMode = contactDispatchModeFromEnvironment(process.env);
const resumePolicy = resumeViewPolicyFromEnvironment(process.env);

let stopping = false;
let browser: Browser | null = null;

process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

function loginPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.hostname.toLowerCase() === "zhipin.com" ||
        parsed.hostname.toLowerCase().endsWith(".zhipin.com")) &&
      (parsed.pathname === "/web/user" || parsed.pathname === "/web/user/")
    );
  } catch {
    return false;
  }
}

function bossPage(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === "zhipin.com" || hostname.endsWith(".zhipin.com");
  } catch {
    return false;
  }
}

function riskOrVerificationPage(url: string): boolean {
  if (!bossPage(url)) return false;
  try {
    const path = new URL(url).pathname;
    return (
      path.startsWith("/web/user/safe/") ||
      path.startsWith("/web/common/") ||
      path.startsWith("/web/passport/")
    );
  } catch {
    return false;
  }
}

async function authenticatedBossSession(page: Page): Promise<boolean> {
  if (!authenticatedBossPage(page.url())) return false;
  const result = await probeLoggedInFromPage(page);
  return (
    result.loggedIn &&
    authenticatedBossPage(result.url) &&
    authenticatedBossPage(page.url())
  );
}

function authenticatedBossPage(url: string): boolean {
  if (!bossPage(url)) return false;
  try {
    const pathname = new URL(url).pathname;
    return pathname === "/web/chat" || pathname.startsWith("/web/chat/");
  } catch {
    return false;
  }
}

function unexpectedLoginFlowMessage(url: string): string {
  if (riskOrVerificationPage(url)) {
    return "BOSS 要求完成安全验证，系统已停止启动 Worker。请管理员在 BOSS 官方页面完成验证；系统不会自动刷新二维码或反复尝试登录。";
  }
  return "Chrome left the BOSS 直聘 login flow unexpectedly.";
}

async function removeScreenshot(path: string): Promise<void> {
  await unlink(path).catch((error: unknown) => {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  });
}

type RelayStatusInput = Omit<
  RelayStatus,
  "updatedAt" | "releaseId" | "contactDispatchMode" | "resumePolicy" | "verification"
>;

async function writeStatus(path: string, status: RelayStatusInput): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  const verifiedAt = new Date().toISOString();
  const payload: RelayStatus = {
    ...status,
    updatedAt: verifiedAt,
    releaseId,
    contactDispatchMode,
    resumePolicy,
    verification: {
      method: "login_relay_page_observation",
      browserAuthenticated: status.state === "authenticated",
      workerHeartbeatFresh: false,
      verifiedAt
    }
  };
  await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

async function writeScreenshot(page: Page, path: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  const image = await page.screenshot({
    type: "png",
    fullPage: false,
    optimizeForSpeed: true
  });
  await writeFile(temporaryPath, image, { mode: 0o600 });
  await rename(temporaryPath, path);
}

async function connectBrowser(): Promise<Browser> {
  const browserUrl = `http://127.0.0.1:${debuggingPort}`;
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await puppeteer.connect({ browserURL: browserUrl, defaultViewport: null, protocolTimeout: 10_000 });
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
      await delay(500);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Chrome remote debugging endpoint did not become available.");
}

async function ensureQrMode(page: Page, method: LoginMethod, refresh = false): Promise<void> {
  if (!loginPage(page.url())) return;
  const feedback = await readLoginPageFeedback(page, method);
  if (feedback.appLoginRequired && method !== "boss_app") return;
  if (!feedback.appLoginRequired && feedback.dialogText) throw new Error(`BOSS 提示：${feedback.dialogText}`);
  if (method === "boss_app") await ensureBossAppLoginQr(page, refresh);
  else await ensureWechatLoginQr(page, refresh);
}

async function openLoginPage(method: LoginMethod): Promise<Page> {
  if (!browser || !browser.connected) browser = await connectBrowser();
  const existingPages = (await browser.pages()).filter((page) => !page.isClosed());
  let page =
    existingPages.find((candidate) => riskOrVerificationPage(candidate.url())) ??
    existingPages.find((candidate) => authenticatedBossPage(candidate.url())) ??
    existingPages.find((candidate) => loginPage(candidate.url())) ??
    existingPages.find((candidate) => isBossPublicHomepage(candidate.url()));
  const created = !page;
  if (!page) {
    page = await browser.newPage();
  }
  await installBossPageGuards(page);
  const pendingPrompt = loginPage(page.url()) && (await readLoginPageFeedback(page, method)).dialogText;
  if (!pendingPrompt && !authenticatedBossPage(page.url()) && !riskOrVerificationPage(page.url()) &&
    hasPersistedBossLogin(await browser.cookies())) {
    // A login URL can remain visible even with saved credentials. Let the
    // normal recruiter page validate those credentials once, without changing
    // cookies or refreshing an already authenticated recommendation list.
    await openPersistedBossPage(page);
  } else if (created) {
    await page.goto(bossLoginUrl, { waitUntil: "load", timeout: 60_000 });
  }
  await openHomepageLogin(page);
  await ensureQrMode(page, method);
  return page;
}

async function refreshQrCode(page: Page, method: LoginMethod): Promise<void> {
  await ensureQrMode(page, method, true);
}

async function holdStatus(
  statusPath: string,
  status: RelayStatusInput,
  refreshRequestPath: string
): Promise<boolean> {
  let lastHeartbeat = 0;
  while (!stopping) {
    if (status.state === "error" && await consumeLoginRefreshRequest(refreshRequestPath, () => writeStatus(statusPath, {
      state: "starting", message: "正在重新打开 BOSS 官方登录入口…", imageUpdatedAt: null
    }))) throw new LoginBrowserRestartRequested();
    if (Date.now() - lastHeartbeat >= 5_000) {
      await writeStatus(statusPath, status);
      lastHeartbeat = Date.now();
    }
    await delay(500);
  }
  return false;
}

async function run(): Promise<boolean> {
  const runtime = await ensureRuntimeDirectory();
  const statusPath = join(runtime, "boss-login-status.json");
  const screenshotPath = join(runtime, "boss-login.png");
  const refreshRequestPath = join(runtime, "boss-login-refresh-request.json");
  let loginMethod = await readLoginMethod(runtime);
  await removeScreenshot(screenshotPath);
  await writeStatus(statusPath, {
    state: "starting",
    loginMethod,
    message: "正在检查 BOSS 已保存的登录状态…",
    imageUpdatedAt: null
  });

  try {
    let page = await openLoginPage(loginMethod);
    if (await authenticatedBossSession(page)) {
      await removeScreenshot(screenshotPath);
      await writeStatus(statusPath, {
        state: "authenticated",
        message: "BOSS 账号已登录，正在自动启动 Worker。",
        imageUpdatedAt: null
      });
      return false;
    }
    if (!loginPage(page.url())) {
      throw new Error(unexpectedLoginFlowMessage(page.url()));
    }
    let imageUpdatedAt = new Date().toISOString();
    let feedback = await readLoginPageFeedback(page, loginMethod);
    if (!feedback.appLoginRequired && isBossRiskSignal(feedback.dialogText)) throw new Error(feedback.dialogText);
    await writeScreenshot(page, screenshotPath);
    await writeStatus(statusPath, {
      state: "awaiting_scan",
      message: feedback.message,
      loginMethod: feedback.loginMethod,
      appLoginRequired: feedback.appLoginRequired,
      imageUpdatedAt
    });
    let lastHeartbeat = Date.now();

    while (!stopping) {
      if (page.isClosed()) throw new Error("BOSS login page closed unexpectedly.");
      const url = page.url();
      if (loginPage(url)) {
        if (await consumeLoginRefreshRequest(refreshRequestPath)) {
          loginMethod = await readLoginMethod(runtime);
          await writeStatus(statusPath, {
            state: "refreshing",
            loginMethod,
            message: `正在获取${loginMethod === "boss_app" ? "BOSS App" : "微信小程序"}登录二维码…`,
            imageUpdatedAt
          });
          try {
            await refreshQrCode(page, loginMethod);
            if (!loginPage(page.url())) continue;
            feedback = await readLoginPageFeedback(page, loginMethod);
            if (!feedback.appLoginRequired && isBossRiskSignal(feedback.dialogText)) throw new Error(feedback.dialogText);
            imageUpdatedAt = new Date().toISOString();
            await writeScreenshot(page, screenshotPath);
            await writeStatus(statusPath, {
              state: "awaiting_scan",
              message: feedback.message,
              loginMethod: feedback.loginMethod,
              appLoginRequired: feedback.appLoginRequired,
              imageUpdatedAt
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // Keep a failed refresh in the error hold; the next heartbeat must
            // not claim an awaiting-scan state with a removed or stale image.
            throw new Error(`二维码刷新失败：${message}`, { cause: error });
          }
          lastHeartbeat = Date.now();
          await delay(pollMs);
          continue;
        }
        if (Date.now() - lastHeartbeat >= 5_000) {
          const nextFeedback = await readLoginPageFeedback(page, loginMethod);
          if (!loginPage(page.url())) continue;
          if (!nextFeedback.appLoginRequired && isBossRiskSignal(nextFeedback.dialogText)) throw new Error(nextFeedback.dialogText);
          if (nextFeedback.signature !== feedback.signature) {
            await writeScreenshot(page, screenshotPath);
            imageUpdatedAt = new Date().toISOString();
          }
          feedback = nextFeedback;
          await writeStatus(statusPath, {
            state: "awaiting_scan",
            message: feedback.message,
            loginMethod: feedback.loginMethod,
            appLoginRequired: feedback.appLoginRequired,
            imageUpdatedAt
          });
          lastHeartbeat = Date.now();
        }
        await delay(pollMs);
        continue;
      }
      if (authenticatedBossPage(url) && (await authenticatedBossSession(page))) {
        await removeScreenshot(screenshotPath);
        await writeStatus(statusPath, {
          state: "authenticated",
          message: "BOSS 账号已登录，正在自动启动 Worker。",
          imageUpdatedAt: null
        });
        return false;
      }
      throw new Error(unexpectedLoginFlowMessage(url));
    }
  } catch (error) {
    await removeScreenshot(screenshotPath);
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "boss_login_relay.error", message }));
    const riskControlled = isBossRiskSignal(error);
    return await holdStatus(statusPath, {
      state: riskControlled ? "risk_controlled" : "error",
      loginMethod,
      message: riskControlled
        ? "检测到 BOSS 风控或安全验证，Worker 未启动。请先在 BOSS 官方页面完成验证，确认账号恢复后再重启服务。"
        : `扫码登录服务异常：${message}`,
      imageUpdatedAt: null
    }, refreshRequestPath);
  } finally {
    if (browser) await browser.disconnect().catch(() => undefined);
  }
  return false;
}

try {
  while (!stopping && await run()) {
    // Normal QR refreshes stay in run(); an error refresh restarts Chromium.
  }
} catch (error) {
  const requestedRestart = error instanceof LoginBrowserRestartRequested;
  (requestedRestart ? console.log : console.error)(JSON.stringify({
    event: requestedRestart ? "boss_login_relay.browser_restart_requested" : "boss_login_relay.failed",
    message: error instanceof Error ? error.message : String(error)
  }));
  // The parent supervisor waits for this child, then the on-failure container
  // restart replaces Chromium and retains its browser profile.
  // Failed puppeteer.connect calls can retain an unowned CDP transport, so
  // exitCode alone cannot guarantee the requested restart after disconnect.
  if (requestedRestart) process.exit(LOGIN_BROWSER_RESTART_EXIT_CODE);
  process.exitCode = 1;
}
