import {describe, expect, it, vi} from "vitest";
import {createSessionRecoveryMonitor, recoverStoppedBossSession} from "./session-recovery.js";
import type {BrowserSessionState} from "./session-health.js";
import {inspectBossTargets, verifyBossPageSessions} from "./session-health.js";

const authenticated = {state: "authenticated", url: "https://www.zhipin.com/web/chat/recommend"} as const;
const missing = {state: "unavailable", message: "DOM mounting"} as const;

describe("BOSS session recovery", () => {
  it("keeps a brief blank-page transition from terminating the workers or requesting a scan", () => {
    const observe = createSessionRecoveryMonitor();
    expect(observe(authenticated, 0).kind).toBe("ready");
    expect(observe(inspectBossTargets([{type: "page", url: "about:blank"}]), 1000).kind).toBe("wait");
    expect(observe(missing, 20000).kind).toBe("wait");
    expect(observe(authenticated, 25000).kind).toBe("ready");
  });
  it("treats a mounting recruiter DOM as a temporary observation rather than logout", async () => {
    const observe = createSessionRecoveryMonitor();
    const page = {url: () => authenticated.url};
    const session = await verifyBossPageSessions([page], async () => ({loggedIn: false, url: page.url()}));
    expect(observe(session, 0).kind).toBe("wait");
    expect(observe(authenticated, 5000).kind).toBe("ready");
  });
  it("pauses after a bounded outage and allows resumption only after a verified session returns", () => {
    const observe = createSessionRecoveryMonitor();
    expect(observe(missing, 0).kind).toBe("wait");
    expect(observe(missing, 30000)).toMatchObject({kind: "stop", failure: {state: "error", reconnectWhenAvailable: true}});
    expect(observe(missing, 40000).kind).toBe("stop");
    expect(observe(authenticated, 45000).kind).toBe("ready");
    expect(observe(missing, 50000).kind).toBe("wait");
  });
  it("does not mistake an unknown login-required observation for confirmed credential expiry", () => {
    expect(createSessionRecoveryMonitor()({state: "login_required", url: null}, 0).kind).toBe("wait");
  });
  it("stops immediately on an actual login page and re-enters the QR relay", () => {
    const session = inspectBossTargets([{type: "page", url: "https://www.zhipin.com/web/user/"}]);
    expect(createSessionRecoveryMonitor()(session, 0)).toMatchObject({
      kind: "stop", failure: {state: "error", restartLoginRelay: true}
    });
  });
  it("does not automatically resume a BOSS verification challenge", () => {
    const observe = createSessionRecoveryMonitor();
    observe(missing, 0);
    const result = observe({state: "risk_controlled", url: "https://www.zhipin.com/web/user/safe/verify"}, 1000);
    expect(result).toMatchObject({kind: "stop", failure: {state: "risk_controlled"}});
    if (result.kind === "stop") {
      expect(result.failure.reconnectWhenAvailable).toBeUndefined();
      expect(result.failure.restartLoginRelay).toBeUndefined();
    }
  });
});

describe("recovery after the workers have stopped", () => {
  const failure = {state:"error", message:"CDP connection unavailable", reconnectWhenAvailable:true} as const;
  function dependencies(session: BrowserSessionState, refreshed = false, heldRisk = false) {
    return {
      inspect:vi.fn(async () => session),
      consumeRefresh:vi.fn(async () => refreshed),
      riskActive:vi.fn(async () => heldRisk)
    };
  }

  it("honors a refresh while held on an unavailable renderer, without automatically looping restarts", async () => {
    const d = dependencies(missing, true);
    expect(await recoverStoppedBossSession(failure, d)).toBe("restart_browser");
    d.consumeRefresh.mockResolvedValue(false);
    expect(await recoverStoppedBossSession(failure, d)).toBe("hold");
  });

  it("automatically reopens the login relay when the page recovers to login rather than an authenticated session", async () => {
    const d = dependencies({state:"login_required",url:"https://www.zhipin.com/web/user/"});
    expect(await recoverStoppedBossSession(failure, d)).toBe("login_relay");
    expect(await recoverStoppedBossSession(failure, dependencies(authenticated))).toBe("login_relay");
    expect(await recoverStoppedBossSession(failure, dependencies({state:"login_required",url:null}))).toBe("hold");
  });

  it("consumes a refresh satisfied by an already recovered login without restarting Chromium", async () => {
    const d = dependencies(authenticated, true);
    expect(await recoverStoppedBossSession(failure, d)).toBe("login_relay");
    expect(d.consumeRefresh).toHaveBeenCalledTimes(1);
  });

  it("requires manual refresh for an unrelated terminal worker error", async () => {
    const terminal = {state:"error",message:"worker exited"} as const;
    const d = dependencies(authenticated);
    expect(await recoverStoppedBossSession(terminal, d)).toBe("hold");
    expect(d.inspect).not.toHaveBeenCalled();
    d.consumeRefresh.mockResolvedValue(true);
    expect(await recoverStoppedBossSession(terminal, d)).toBe("login_relay");
  });

  it("never refreshes or resumes a held verification challenge", async () => {
    const d = dependencies(authenticated, true, true);
    expect(await recoverStoppedBossSession(failure, d)).toBe("risk_controlled");
    expect(d.consumeRefresh).not.toHaveBeenCalled();
    expect(d.inspect).not.toHaveBeenCalled();
    d.riskActive.mockResolvedValue(false);
    expect(await recoverStoppedBossSession({state:"risk_controlled",message:"verification"}, d)).toBe("risk_controlled");
    expect(d.consumeRefresh).not.toHaveBeenCalled();
  });

  it("keeps a newly observed verification page held even if refresh was accepted earlier", async () => {
    const d = dependencies({state:"risk_controlled",url:"https://www.zhipin.com/web/user/safe/verify"}, true);
    expect(await recoverStoppedBossSession(failure, d)).toBe("risk_controlled");
    const changed = dependencies(authenticated,true);
    changed.riskActive.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await recoverStoppedBossSession(failure, changed)).toBe("risk_controlled");
  });
});
