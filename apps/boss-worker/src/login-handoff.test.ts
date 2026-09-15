import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("BOSS login to worker handoff", () => {
  it("returns from the login relay after authentication instead of holding forever", () => {
    const relay = source("apps/boss-worker/src/login-relay.ts");
    expect(relay).toContain("正在自动启动 Worker");
    expect(relay).toContain("authenticatedBossPage");
    expect(relay).toContain('pathname.startsWith("/web/chat/")');
    expect(relay).not.toContain(
      'await holdStatus(statusPath, {\n        state: "authenticated"'
    );
  });

  it("starts the worker and only keeps a continuously verified authenticated status", () => {
    const supervisor = source("apps/boss-worker/src/session-supervisor.ts");
    expect(supervisor).toContain('startScript("boss-login-relay")');
    expect(supervisor).toContain('startScript("m1:worker",');
    expect(supervisor).toContain("inspectBossBrowserSession");
    expect(source("apps/boss-worker/src/session-health.ts")).toContain(
      "probeLoggedInFromPage"
    );
    expect(supervisor).toContain("workerHeartbeatStatus");
    expect(supervisor).toContain("stopSessionWorkers");
    expect(supervisor).toContain("已实时验证 BOSS 登录与筛选 Worker");
    expect(supervisor).toContain(
      "child: startScript(contactWorkerScript)"
    );
    expect(supervisor).not.toContain(
      'workers.push(startScript("m2:contact-worker:fake"))'
    );
    expect(source("package.json")).toContain(
      '"m2:contact-worker:fake": "tsx --env-file-if-exists=.env apps/boss-worker/src/contact-worker.ts --fake --loop"'
    );
  });

  it("does not start any BOSS worker until API release and resume policy match", () => {
    const supervisor = source("apps/boss-worker/src/session-supervisor.ts");
    const server = source("apps/control-api/src/server.ts");
    const runtimeCheck = supervisor.indexOf(
      "const apiRuntime = await controlApiRuntimeConsistency()"
    );
    const workerStart = supervisor.indexOf(
      'const m1Worker = startScript("m1:worker",'
    );
    expect(runtimeCheck).toBeGreaterThan(0);
    expect(workerStart).toBeGreaterThan(runtimeCheck);
    expect(supervisor).toContain("resume_policy_mismatch");
    expect(supervisor).toContain("contact_dispatch_mode_mismatch");
    expect(supervisor).toContain("Worker 未启动");
    expect(server).toContain(
      "resumePolicy: resumeViewPolicyFromEnvironment(process.env)"
    );
    expect(server).toContain("contactDispatchMode,");
    expect(source("apps/boss-worker/src/login-relay.ts")).toContain(
      "contactDispatchModeFromEnvironment(process.env)"
    );
  });

  it("stops running workers if API release or resume policy drifts later", () => {
    const supervisor = source("apps/boss-worker/src/session-supervisor.ts");
    const monitorStart = supervisor.indexOf(
      "async function maintainWorkerStatus("
    );
    const apiCheck = supervisor.indexOf(
      "const apiRuntime = await controlApiRuntimeConsistency()",
      monitorStart
    );
    const mismatchBranch = supervisor.indexOf(
      "if (!apiRuntime.consistent)",
      apiCheck
    );
    const terminalWrite = supervisor.indexOf(
      "await writeSessionStatus(statusPath, sessionMonitorFailure)",
      mismatchBranch
    );
    const workerStop = supervisor.indexOf(
      "stopSessionWorkers(children)",
      terminalWrite
    );
    const heartbeatCheck = supervisor.indexOf(
      "const heartbeatStatus = await workerHeartbeatStatus(",
      apiCheck
    );

    expect(monitorStart).toBeGreaterThan(0);
    expect(apiCheck).toBeGreaterThan(monitorStart);
    expect(mismatchBranch).toBeGreaterThan(apiCheck);
    expect(terminalWrite).toBeGreaterThan(mismatchBranch);
    expect(workerStop).toBeGreaterThan(terminalWrite);
    expect(heartbeatCheck).toBeGreaterThan(workerStop);
    expect(supervisor).toContain("在运行中不再一致，已停止全部 BOSS Worker");
  });

  it("keeps startup non-authoritative until this worker writes a heartbeat", () => {
    const supervisor = source("apps/boss-worker/src/session-supervisor.ts");
    expect(supervisor).toContain(
      "const WORKER_HEARTBEAT_STARTUP_GRACE_MS = 60_000"
    );
    expect(supervisor).toContain('if (heartbeatStatus === "starting")');
    expect(supervisor).toContain('state: "starting"');
    expect(supervisor).toContain("browserAuthenticated: true");
    expect(supervisor).toContain("workerHeartbeatFresh: false");
    expect(supervisor).toContain("sessionWorkersRunning(children)");
  });

  it("turns code, signal and spawn failures into one serialized terminal state", () => {
    const supervisor = source("apps/boss-worker/src/session-supervisor.ts");
    const firstExit = supervisor.indexOf(
      "const firstExit = await Promise.race(exits)"
    );
    const freezeFailure = supervisor.indexOf(
      "sessionMonitorFailure = {",
      firstExit
    );
    const riskCheck = supervisor.indexOf(
      "await bossRiskStatusActive(statusPath)",
      firstExit
    );
    const monitorSettled = supervisor.indexOf(
      "await statusHeartbeat",
      firstExit
    );
    const terminalWrite = supervisor.indexOf(
      "await writeSessionStatus(statusPath, sessionMonitorFailure)",
      monitorSettled
    );

    const processControl = source("apps/boss-worker/src/session-process.ts");
    expect(supervisor).toContain("waitForSessionChildExit");
    expect(processControl).not.toContain("child.once(\"error\", reject)");
    expect(processControl).toContain("Worker 被信号 ${result.signal} 终止");
    expect(freezeFailure).toBeGreaterThan(firstExit);
    expect(riskCheck).toBeGreaterThan(freezeFailure);
    expect(terminalWrite).toBeGreaterThan(monitorSettled);
    expect(supervisor).toContain("statusWriteSequence += 1");
  });

  it("accepts only an observed, matching M1 canary completion as a normal exit", () => {
    const supervisor = source("apps/boss-worker/src/session-supervisor.ts");
    const processControl = source("apps/boss-worker/src/session-process.ts");
    expect(supervisor).toContain("parseM1CanaryCompletionLine(line)");
    expect(supervisor).toContain('firstExit.script === "m1:worker"');
    expect(supervisor).toContain("isExpectedM1CanaryExit(");
    expect(supervisor).toContain("stopSessionWorkers(workers)");
    expect(supervisor).toContain("boss_session_supervisor.canary.completed");
    expect(supervisor).toContain("isConfiguredM1CanaryCompletion(");
    expect(supervisor).toContain('heartbeatStatus === "completed"');
    expect(supervisor).toContain("observedM1CanaryCompletion()");
    expect(processControl).toContain('child.once("close"');
  });

  it("hands off when login redirects before the QR controls appear", () => {
    const relay = source("apps/boss-worker/src/login-relay.ts");
    expect(source("apps/boss-worker/src/wechat-login.ts")).toContain("!location.pathname.startsWith('/web/user')");
    expect(relay).toContain('if (!loginPage(page.url())) return;');
    expect(relay).not.toContain('parsed.hostname.endsWith("zhipin.com")');
    expect(relay).toContain("系统不会自动刷新二维码或反复尝试登录");
    expect(relay).toContain("await authenticatedBossSession(page)");
  });

  it("runs the supervisor with database access in the login service", () => {
    const compose = source("deploy/compose.intranet.yaml");
    const login = compose.slice(
      compose.indexOf("  boss-login:"),
      compose.indexOf("  boss-worker:")
    );
    expect(login).toContain("exec pnpm boss-session-supervisor");
    expect(login).toContain("<<: *boss-environment");
    expect(login).toContain("networks: [app, data]");
    expect(compose).toContain(
      "BOSS_FORGE_REAL_GREET_ENABLED: ${BOSS_FORGE_REAL_GREET_ENABLED:-0}"
    );
    expect(compose).toContain(
      "BOSS_FORGE_CONTACT_DISPATCH_MODE: ${BOSS_FORGE_CONTACT_DISPATCH_MODE:-disabled}"
    );
  });

  it("keeps resume and contact workers independently gated", () => {
    const supervisor = source("apps/boss-worker/src/session-supervisor.ts");
    const safety = source("apps/boss-worker/src/contact-safety.ts");
    const packageJson = source("package.json");
    expect(supervisor).toContain("contactWorkerScriptFromEnvironment(process.env)");
    expect(supervisor).not.toContain(
      'if (process.env.BOSS_FORGE_REAL_GREET_ENABLED === "1")'
    );
    expect(safety).toContain("realContactEnabled(environment)");
    expect(safety).toContain('if (mode === "disabled") return null');
    expect(packageJson).toContain("--approve-real-greet --loop");
  });

  it("removes the direct M0 greeting bypass", () => {
    const m0 = source("apps/boss-worker/src/m0.ts");
    expect(m0).not.toContain('type: "greet"');
    expect(m0).not.toContain("--approve-greet");
    expect(m0).toContain("M0 real greeting is permanently disabled");
  });
});
