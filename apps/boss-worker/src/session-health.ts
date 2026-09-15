import { probeLoggedInFromPage } from "@boss-forge/boss-cli-adapter";
import puppeteer, { type Page } from "puppeteer-core";

export type BrowserSessionState =
  | { state: "authenticated"; url: string }
  | { state: "login_required"; url: string | null }
  | { state: "risk_controlled"; url: string }
  | { state: "unavailable"; message: string };

type CdpTarget = {
  type?: unknown;
  url?: unknown;
};

function zhipinUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return hostname === "zhipin.com" || hostname.endsWith(".zhipin.com")
      ? url
      : null;
  } catch {
    return null;
  }
}

function loginPath(pathname: string): boolean {
  return pathname === "/web/user" || pathname === "/web/user/";
}

function riskPath(pathname: string): boolean {
  return (
    pathname.startsWith("/web/user/safe/") ||
    pathname.startsWith("/web/common/") ||
    pathname.startsWith("/web/passport/")
  );
}

function authenticatedShellPath(pathname: string): boolean {
  return pathname === "/web/chat" || pathname.startsWith("/web/chat/");
}

type SessionPage = {
  url(): string;
};

type LoginProbe<T extends SessionPage> = (
  page: T
) => Promise<{ loggedIn: boolean; url: string }>;

/**
 * Confirms that an authenticated-looking chat URL also has logged-in DOM
 * signals. This is read-only: the probe does not navigate, reload, or click.
 */
export async function verifyBossPageSessions<T extends SessionPage>(
  pages: readonly T[],
  probe: LoginProbe<T>
): Promise<BrowserSessionState> {
  const bossPages = pages
    .map((page) => ({ page, url: zhipinUrl(page.url()) }))
    .filter(
      (entry): entry is { page: T; url: URL } => entry.url !== null
    );

  const riskPage = bossPages.find(({ url }) => riskPath(url.pathname));
  if (riskPage) {
    return { state: "risk_controlled", url: riskPage.url.toString() };
  }

  for (const entry of bossPages) {
    if (!authenticatedShellPath(entry.url.pathname)) continue;
    const result = await probe(entry.page);
    const currentUrl = zhipinUrl(entry.page.url());
    const probedUrl = zhipinUrl(result.url);
    if (
      result.loggedIn &&
      currentUrl &&
      authenticatedShellPath(currentUrl.pathname) &&
      probedUrl &&
      authenticatedShellPath(probedUrl.pathname)
    ) {
      return { state: "authenticated", url: currentUrl.toString() };
    }
  }

  const currentBossPages = pages
    .map((page) => zhipinUrl(page.url()))
    .filter((url): url is URL => url !== null);
  const currentRiskPage = currentBossPages.find((url) => riskPath(url.pathname));
  if (currentRiskPage) {
    return { state: "risk_controlled", url: currentRiskPage.toString() };
  }
  const loginPage = currentBossPages.find((url) => loginPath(url.pathname));
  return loginPage
    ? { state: "login_required", url: loginPage.toString() }
    : { state: "unavailable", message: "BOSS 页面暂未读取到登录信息，正在重新检查。" };
}

export function inspectBossTargets(value: unknown): BrowserSessionState {
  if (!Array.isArray(value)) {
    return { state: "unavailable", message: "Chromium CDP 返回了无效的页面列表。" };
  }

  const bossPages = value
    .filter((target): target is CdpTarget => Boolean(target && typeof target === "object"))
    .filter((target) => target.type === "page")
    .map((target) => zhipinUrl(target.url))
    .filter((url): url is URL => url !== null);

  const riskPage = bossPages.find((url) => riskPath(url.pathname));
  if (riskPage) return { state: "risk_controlled", url: riskPage.toString() };

  const authenticatedPage = bossPages.find(
    (url) => authenticatedShellPath(url.pathname)
  );
  if (authenticatedPage) {
    return { state: "authenticated", url: authenticatedPage.toString() };
  }

  const loginPage = bossPages.find((url) => loginPath(url.pathname));
  return loginPage
    ? { state: "login_required", url: loginPage.toString() }
    : { state: "unavailable", message: "BOSS 工作页面暂不可用，等待页面恢复。" };
}

/** A DOM navigation invalidates a probe, not the persisted login. Retry only
 * that read with fresh Page objects; never reload, click, or retry a logout. */
export async function verifyBossPageSessionsWithRetry<T extends SessionPage>(
  pages: () => Promise<readonly T[]>,
  probe: LoginProbe<T>,
  wait: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 300))
): Promise<BrowserSessionState> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await verifyBossPageSessions(await pages(), probe);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= 2 || !/execution context was destroyed|cannot find context with specified id|detached frame|frame got detached/iu.test(message)) throw error;
      await wait();
    }
  }
}

export async function inspectBossBrowserSession(
  debuggingPort: number,
  fetcher: typeof fetch = fetch
): Promise<BrowserSessionState> {
  let browser: Awaited<ReturnType<typeof puppeteer.connect>> | null = null;
  try {
    const response = await fetcher(`http://127.0.0.1:${debuggingPort}/json`, {
      signal: AbortSignal.timeout(3_000)
    });
    if (!response.ok) {
      return {
        state: "unavailable",
        message: `Chromium CDP 状态检查返回 HTTP ${response.status}。`
      };
    }
    const targetState = inspectBossTargets(await response.json());
    if (targetState.state !== "authenticated") return targetState;

    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${debuggingPort}`,
      defaultViewport: null,
      // Health checks only read DOM. Creating a Network session every five
      // seconds adds work to the shared recruiting page and can hang the probe.
      networkEnabled: false,
      protocolTimeout: 10_000
    });
    return await verifyBossPageSessionsWithRetry<Page>(
      () => browser!.pages(),
      probeLoggedInFromPage
    );
  } catch (error: unknown) {
    return {
      state: "unavailable",
      message:
        error instanceof Error
          ? `无法连接 Chromium CDP：${error.message}`
          : "无法连接 Chromium CDP。"
    };
  } finally {
    if (browser) await browser.disconnect().catch(() => undefined);
  }
}

export function workerHeartbeatIsFresh(
  value: unknown,
  now = Date.now(),
  maxAgeMs = 20_000
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const heartbeat = value as Record<string, unknown>;
  if (typeof heartbeat.observedAt !== "string") return false;
  if (!['ready', 'busy', 'degraded'].includes(String(heartbeat.state))) return false;
  const observedAt = Date.parse(heartbeat.observedAt);
  return (
    Number.isFinite(observedAt) &&
    now >= observedAt &&
    now - observedAt <= maxAgeMs
  );
}

export type WorkerHeartbeatStatus =
  | "starting"
  | "fresh"
  | "completed"
  | "failed";

export type WorkerHeartbeatContext = {
  acceptStoppingAsCompleted?: boolean;
};

/**
 * A heartbeat from the previous container must never authenticate the newly
 * started worker. During startup it is a waiting signal; after the grace
 * period it is a hard failure unless this run has written a fresh heartbeat.
 */
export function classifyWorkerHeartbeat(
  value: unknown,
  workerStartedAt: number,
  now = Date.now(),
  startupGraceMs = 60_000,
  maxAgeMs = 20_000,
  context: WorkerHeartbeatContext = {}
): WorkerHeartbeatStatus {
  const state =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).state
      : null;
  const observedAt =
    value && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).observedAt === "string"
      ? Date.parse((value as Record<string, unknown>).observedAt as string)
      : Number.NaN;
  const currentRunObservation =
    Number.isFinite(observedAt) &&
    observedAt >= workerStartedAt &&
    now >= observedAt &&
    now - observedAt <= maxAgeMs;
  if (
    context.acceptStoppingAsCompleted === true &&
    state === "stopping" &&
    currentRunObservation
  ) {
    return "completed";
  }
  if (
    workerHeartbeatIsFresh(value, now, maxAgeMs) &&
    observedAt >= workerStartedAt
  ) {
    return "fresh";
  }
  return now - workerStartedAt < startupGraceMs ? "starting" : "failed";
}
