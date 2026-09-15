import type { BrowserSessionState } from "./session-health.js";

export type RecoverableSessionFailure = {
  state: "error" | "risk_controlled";
  message: string;
  reconnectWhenAvailable?: boolean;
  restartLoginRelay?: boolean;
};

type SessionObservation =
  | { kind: "ready" }
  | { kind: "wait"; message: string }
  | { kind: "stop"; failure: RecoverableSessionFailure };

export const LOGIN_BROWSER_RESTART_EXIT_CODE = 75;

export class LoginBrowserRestartRequested extends Error {
  constructor() {
    super("管理员刷新扫码登录：重启暂不可用的浏览器连接。");
    this.name = "LoginBrowserRestartRequested";
  }
}

/** Called only after all BOSS workers have exited. An unavailable renderer
 * needs a container restart after explicit refresh; reopening the relay in
 * that same Chromium would otherwise hang on Page.enable again. */
export async function recoverStoppedBossSession(
  failure: RecoverableSessionFailure,
  dependencies: {
    riskActive(): Promise<boolean>;
    consumeRefresh(): Promise<boolean>;
    inspect(): Promise<BrowserSessionState>;
  }
): Promise<"hold" | "login_relay" | "restart_browser" | "risk_controlled"> {
  if (failure.state === "risk_controlled" || await dependencies.riskActive()) {
    return "risk_controlled";
  }
  const refreshed = await dependencies.consumeRefresh();
  if (!refreshed && !failure.reconnectWhenAvailable) return "hold";
  const session = await dependencies.inspect();
  if (session.state === "risk_controlled" || await dependencies.riskActive()) return "risk_controlled";
  if (session.state === "authenticated" || (session.state === "login_required" && session.url)) {
    return "login_relay";
  }
  return refreshed ? "restart_browser" : "hold";
}

/** A missing tab or mounting DOM is not proof that BOSS revoked the login.
 * Each real operation still verifies its own session before it may send. */
export function createSessionRecoveryMonitor(graceMs = 30_000) {
  let unavailableSince: number | null = null;
  return (session: BrowserSessionState, now: number): SessionObservation => {
    if (session.state === "authenticated") {
      unavailableSince = null;
      return { kind: "ready" };
    }
    if (session.state === "risk_controlled") {
      unavailableSince = null;
      return { kind: "stop", failure: {
        state: "risk_controlled",
        message: "BOSS 页面要求安全验证，系统已停止全部 BOSS Worker。请在官方页面完成验证后再由管理员恢复。"
      }};
    }
    if (session.state === "login_required" && session.url) {
      unavailableSince = null;
      return { kind: "stop", failure: {
        state: "error", restartLoginRelay: true,
        message: "BOSS 已返回登录页，任务已暂停，正在准备微信扫码登录。"
      }};
    }
    unavailableSince ??= now;
    if (now - unavailableSince < graceMs) {
      return { kind: "wait", message: "BOSS 页面暂不可读，正在自动复查登录状态。" };
    }
    return { kind: "stop", failure: {
      state: "error", reconnectWhenAvailable: true,
      message: "BOSS 页面或连接暂不可用，任务已暂停。可点击刷新扫码登录恢复连接；页面恢复后自动继续。"
    }};
  };
}
