import {startCommunicationResumeAnalysis} from './communication-resume-analysis.js';
import {readBossChatAttachment} from './boss-attachment.js';
import { sendQueuedBossWechat } from './boss-wechat.js';
import { BossGreetingSaveRejectedError, isUnconfiguredBossGreeting, saveBossJobGreeting } from "./boss-job-greeting.js";
import { readBossJobCatalog, readBossFilterOptions } from "./boss-jobs.js";
import { readBossChat, readBossChatInbox, readBossChatOnlineResume, sendQueuedBossChat } from './boss-communication.js';
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  BossBrowserControlError,
  bossBrowserControlSocketPath,
  parseBossGreetingPreview,
  runBossCommand,
  startBossBrowserControlServer,
  withContactGlobalFence,
  type BossBrowserControlServer,
  type BossGreetingPreview
} from "@boss-forge/boss-cli-adapter";
import { resumeViewPolicyFromEnvironment } from "@boss-forge/contracts";
import { createDatabase, M2Repository, WorkspaceActivityRepository } from '@boss-forge/data';
import { withAccountLock } from "./account-lock.js";
import { ensureRuntimeDirectory } from "./runtime.js";
import { bossRiskStatusActive } from "./boss-risk.js";
import {
  contactDispatchModeFromEnvironment,
  contactWorkerScriptFromEnvironment,
  type ContactDispatchMode
} from "./contact-safety.js";
import {
  classifyWorkerHeartbeat,
  inspectBossBrowserSession,
  type WorkerHeartbeatStatus
} from "./session-health.js";
import {
  isConfiguredM1CanaryCompletion,
  isExpectedM1CanaryExit,
  parseM1CanaryCompletionLine,
  sessionChildExitMessage,
  waitForSessionChildExit,
  type M1CanaryCompletion
} from "./session-process.js";
import { workerBossEnvironment } from "./runtime.js";
import { createSessionRecoveryMonitor, LOGIN_BROWSER_RESTART_EXIT_CODE, LoginBrowserRestartRequested, recoverStoppedBossSession } from "./session-recovery.js";
import { consumeLoginRefreshRequest } from "./login-refresh-request.js";

const STATUS_HEARTBEAT_MS = 5_000;
const WORKER_HEARTBEAT_MAX_AGE_MS = 20_000;
const WORKER_HEARTBEAT_STARTUP_GRACE_MS = 60_000;
const debuggingPort = Number(
  process.env.BOSS_BROWSER_REMOTE_DEBUGGING_PORT ?? "53470"
);
const controlApiHealthUrl =
  process.env.BOSS_FORGE_CONTROL_API_HEALTH_URL?.trim() ||
  "http://api:3100/health";
const releaseId = process.env.BOSS_FORGE_RELEASE_ID?.trim() || "unversioned";
const resumePolicy = resumeViewPolicyFromEnvironment(process.env);
const contactDispatchMode = contactDispatchModeFromEnvironment(process.env);
const contactWorkerScript = contactWorkerScriptFromEnvironment(process.env);
const bossAccountId =
  process.env.BOSS_FORGE_ACCOUNT_ID?.trim() || "boss-account-01";

let stopping = false;
const activeChildren = new Set<ChildProcess>();
let browserControlServer: BossBrowserControlServer | null = null;
type SessionMonitorFailure = {
  state: "error" | "risk_controlled";
  message: string;
  browserAuthenticated?: boolean;
  workerHeartbeatFresh?: false;
  reconnectWhenAvailable?: boolean;
  restartLoginRelay?: boolean;
};
let sessionMonitorFailure: SessionMonitorFailure | null = null;
let statusWriteSequence = 0;
let restartSessionRequested = false;

function authenticatedStatusMessage(mode: ContactDispatchMode): string {
  switch (mode) {
    case "disabled":
      return "已实时验证 BOSS 登录与筛选 Worker；联系发送仅可预览，联系 Worker 未启动。";
    case "fake":
      return "已实时验证 BOSS 登录与筛选 Worker；模拟联系 Worker 正在运行，不会向候选人发送消息。";
    case "real":
      return "已实时验证 BOSS 登录与筛选 Worker；真实联系 Worker 正在运行。";
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function controlApiRuntimeConsistency(): Promise<{
  consistent: boolean;
  reasons: string[];
}> {
  try {
    const response = await fetch(controlApiHealthUrl, {
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) return { consistent: false, reasons: ["api_unavailable"] };
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { consistent: false, reasons: ["api_health_invalid"] };
    }
    const health = payload as Record<string, unknown>;
    const reasons: string[] = [];
    if (health.releaseId !== releaseId) reasons.push("release_mismatch");
    if (health.contactDispatchMode !== contactDispatchMode) {
      reasons.push("contact_dispatch_mode_mismatch");
    }
    if (canonicalJson(health.resumePolicy) !== canonicalJson(resumePolicy)) {
      reasons.push("resume_policy_mismatch");
    }
    return { consistent: reasons.length === 0, reasons };
  } catch {
    return { consistent: false, reasons: ["api_unavailable"] };
  }
}

async function closeBrowserControlServer(): Promise<void> {
  const current = browserControlServer;
  browserControlServer = null;
  if (current) await current.close();
}

function forwardStopSignal(): void {
  stopping = true;
  for (const child of activeChildren) child.kill("SIGTERM");
  void closeBrowserControlServer().catch((error: unknown) => {
    console.error(
      `Failed to close browser-control socket: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  });
}

process.once("SIGINT", forwardStopSignal);
process.once("SIGTERM", forwardStopSignal);

type SessionScript =
  | "boss-login-relay"
  | "m1:worker"
  | "m2:contact-worker:real"
  | "m2:contact-worker:fake";

function startScript(
  script: SessionScript,
  onStdoutLine?: (line: string) => void
): ChildProcess {
  const entrypoints: Record<SessionScript, [string, ...string[]]> = {
    "boss-login-relay": ["login-relay.ts"],
    "m1:worker": ["m1.ts", "--loop"],
    "m2:contact-worker:real": ["contact-worker.ts", "--approve-real-greet", "--loop"],
    "m2:contact-worker:fake": ["contact-worker.ts", "--fake", "--loop"]
  };
  const [filename, ...args] = entrypoints[script];
  const child = spawn(process.execPath, ["--import", "tsx", "--env-file-if-exists=.env", fileURLToPath(new URL(filename, import.meta.url)), ...args], {
    env: process.env,
    stdio: onStdoutLine ? ["inherit", "pipe", "inherit"] : "inherit"
  });
  if (onStdoutLine && child.stdout) {
    let pending = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      process.stdout.write(chunk);
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        onStdoutLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    });
    child.stdout.on("end", () => {
      if (pending) onStdoutLine(pending);
    });
  }
  activeChildren.add(child);
  return child;
}

async function writeSessionStatus(
  statusPath: string,
  input: {
    state: "starting" | "authenticated" | "error" | "risk_controlled";
    message: string;
    browserAuthenticated?: boolean;
    workerHeartbeatFresh?: boolean;
  }
): Promise<void> {
  statusWriteSequence += 1;
  const temporaryPath = `${statusPath}.${process.pid}.${statusWriteSequence}.tmp`;
  const {
    browserAuthenticated = input.state === "authenticated",
    workerHeartbeatFresh = input.state === "authenticated",
    ...status
  } = input;
  const payload = {
    ...status,
    updatedAt: new Date().toISOString(),
    imageUpdatedAt: null,
    releaseId,
    contactDispatchMode,
    resumePolicy,
    verification: {
      method: "chromium_cdp_and_worker_heartbeat",
      browserAuthenticated,
      workerHeartbeatFresh,
      verifiedAt: new Date().toISOString()
    }
  };
  await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600
  });
  await rename(temporaryPath, statusPath);
}

async function workerHeartbeatStatus(
  heartbeatPath: string,
  workerStartedAt: number,
  observedM1CanaryCompletion: () => M1CanaryCompletion | null
): Promise<WorkerHeartbeatStatus> {
  let raw: unknown = null;
  try {
    raw = JSON.parse(await readFile(heartbeatPath, "utf8"));
  } catch (error: unknown) {
    if (
      !(error instanceof SyntaxError) &&
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
  return classifyWorkerHeartbeat(
    raw,
    workerStartedAt,
    Date.now(),
    WORKER_HEARTBEAT_STARTUP_GRACE_MS,
    WORKER_HEARTBEAT_MAX_AGE_MS,
    {
      acceptStoppingAsCompleted: isConfiguredM1CanaryCompletion(
        observedM1CanaryCompletion(),
        process.env
      )
    }
  );
}

function sessionWorkersRunning(children: readonly ChildProcess[]): boolean {
  return children.every(
    (child) => child.exitCode === null && child.signalCode === null
  );
}

function stopSessionWorkers(children: readonly ChildProcess[]): void {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}

async function readExactGreetingInAuthenticatedSession(input: {
  jobKeyword: string;
}): Promise<BossGreetingPreview> {
  if (stopping || sessionMonitorFailure) {
    throw new BossBrowserControlError(
      "not_authenticated",
      "BOSS session supervisor is not available for preview."
    );
  }
  const beforeLock = await inspectBossBrowserSession(debuggingPort);
  if (beforeLock.state !== "authenticated") {
    throw new BossBrowserControlError(
      "not_authenticated",
      "BOSS login is not authenticated."
    );
  }
  const apiRuntime = await controlApiRuntimeConsistency();
  if (!apiRuntime.consistent) {
    throw new BossBrowserControlError(
      "unavailable",
      "API and browser supervisor runtime settings do not match."
    );
  }
  try {
    return await withAccountLock(
      bossAccountId,
      async () => {
        if (stopping || sessionMonitorFailure) {
          throw new BossBrowserControlError(
            "not_authenticated",
            "BOSS session supervisor stopped before preview."
          );
        }
        const session = await inspectBossBrowserSession(debuggingPort);
        if (session.state !== "authenticated") {
          throw new BossBrowserControlError(
            "not_authenticated",
            "BOSS login is not authenticated."
          );
        }
        const result = await runBossCommand(
          { type: "greeting-preview", jobKeyword: input.jobKeyword },
          {
            timeoutMs: 30_000,
            env: {
              ...workerBossEnvironment(),
              // A failed CDP probe must never fall back to spawning a second
              // browser against the persisted login profile.
              BOSS_BROWSER_REMOTE_ONLY: "1"
            }
          }
        );
        return parseBossGreetingPreview(result.stdout);
      },
      { timeoutMs: 5_000, pollMs: 100 }
    );
  } catch (error: unknown) {
    if (error instanceof BossBrowserControlError) throw error;
    if (error instanceof Error && error.message.includes("Timed out waiting for account lock")) {
      throw new BossBrowserControlError("busy", "BOSS browser is currently in use.");
    }
    if (isUnconfiguredBossGreeting(error)) throw new BossBrowserControlError('greeting_not_configured', '该岗位尚未设置专属招呼语。');
    throw new BossBrowserControlError(
      "greeting_unavailable",
      "The exact job greeting could not be read from BOSS."
    );
  }
}

async function readInAuthenticatedSession<T>(operation: () => Promise<T>, refreshChatHealth = false, leaseId?: string): Promise<T> {
  if (stopping || sessionMonitorFailure || (await inspectBossBrowserSession(debuggingPort)).state !== "authenticated") {
    throw new BossBrowserControlError("not_authenticated", "请先登录 BOSS。");
  }
  try {
    return await withAccountLock(bossAccountId, async () => {
      if (leaseId) {
        const sql = createDatabase();
        try {
          if (!(await new WorkspaceActivityRepository(sql).leaseActive(bossAccountId, leaseId))) {
            throw new BossBrowserControlError('mode_inactive', '实时沟通已暂停，请返回实时沟通页面。');
          }
        } finally { await sql.end(); }
      }
      if ((await inspectBossBrowserSession(debuggingPort)).state !== "authenticated") {
        throw new BossBrowserControlError("not_authenticated", "请先登录 BOSS。");
      }
      const result = await operation();
      if (refreshChatHealth) {
        if ((await inspectBossBrowserSession(debuggingPort)).state !== 'authenticated') {
          throw new BossBrowserControlError('not_authenticated', 'BOSS 登录状态已变化。');
        }
        const sql=createDatabase();
        try {await new M2Repository(sql).recordVerifiedBossAccountHealth(bossAccountId,new Date().toISOString());}
        finally {await sql.end();}
      }
      return result;
    }, { timeoutMs: 5_000, pollMs: 100 });
  } catch (error) {
    if (error instanceof BossBrowserControlError) throw error;
    if (error instanceof Error && error.message.includes("Timed out waiting for account lock")) {
      throw new BossBrowserControlError("busy", "BOSS 正在筛选，请稍后同步。");
    }
    if (error instanceof BossGreetingSaveRejectedError) {
      console.error("BOSS greeting save rejected:", error.message);
      throw new BossBrowserControlError('greeting_save_rejected', 'BOSS 未接受此条招呼语，本次未应用。');
    }
    console.error("BOSS browser read failed:", error instanceof Error ? error.message : String(error));
    throw new BossBrowserControlError("unavailable", "BOSS 页面读取失败。");
  }
}

async function maintainWorkerStatus(
  children: readonly ChildProcess[],
  statusPath: string,
  heartbeatPath: string,
  workerStartedAt: number,
  observedM1CanaryCompletion: () => M1CanaryCompletion | null
): Promise<void> {
  const observeSession = createSessionRecoveryMonitor();
  while (
    !stopping &&
    !sessionMonitorFailure &&
    sessionWorkersRunning(children)
  ) {
    const riskActive = await bossRiskStatusActive(statusPath);
    if (stopping || sessionMonitorFailure || !sessionWorkersRunning(children)) return;
    if (riskActive) {
      sessionMonitorFailure = {
        state: "risk_controlled",
        message: "检测到 BOSS 风控或安全验证，已停止全部 BOSS Worker。"
      };
      stopSessionWorkers(children);
      return;
    }

    const browserSession = await inspectBossBrowserSession(debuggingPort);
    if (stopping || sessionMonitorFailure || !sessionWorkersRunning(children)) return;
    const observation = observeSession(browserSession, Date.now());
    if (observation.kind === "stop") {
      sessionMonitorFailure = observation.failure;
      await writeSessionStatus(statusPath, sessionMonitorFailure);
      stopSessionWorkers(children);
      return;
    }

    const apiRuntime = await controlApiRuntimeConsistency();
    if (stopping || sessionMonitorFailure || !sessionWorkersRunning(children)) return;
    if (!apiRuntime.consistent) {
      sessionMonitorFailure = {
        state: "error",
        message: `API 与 BOSS Worker 的发布版本或简历安全策略在运行中不再一致，已停止全部 BOSS Worker（${apiRuntime.reasons.join(",")}）。请完成一致发布后受控重启。`,
        browserAuthenticated: true,
        workerHeartbeatFresh: false
      };
      await writeSessionStatus(statusPath, sessionMonitorFailure);
      stopSessionWorkers(children);
      return;
    }

    const heartbeatStatus = await workerHeartbeatStatus(
      heartbeatPath,
      workerStartedAt,
      observedM1CanaryCompletion
    );
    if (stopping || sessionMonitorFailure || !sessionWorkersRunning(children)) return;
    if (heartbeatStatus === "completed") return;
    if (heartbeatStatus === "failed") {
      sessionMonitorFailure = {
        state: "error",
        message: "筛选 Worker 心跳已中断，系统已停止全部 BOSS Worker。请管理员检查服务日志后再恢复。",
        browserAuthenticated: true,
        workerHeartbeatFresh: false
      };
      await writeSessionStatus(statusPath, sessionMonitorFailure);
      stopSessionWorkers(children);
      return;
    }

    if (observation.kind === "wait") {
      // Preserve an in-flight operation during a brief page transition. Do not
      // publish authenticated status, and keep checking API/worker health above.
      await writeSessionStatus(statusPath, {
        state: "starting", message: observation.message,
        browserAuthenticated: false, workerHeartbeatFresh: heartbeatStatus === "fresh"
      });
      await delay(STATUS_HEARTBEAT_MS);
      continue;
    }

    if (heartbeatStatus === "starting") {
      await writeSessionStatus(statusPath, {
        state: "starting",
        message: "BOSS 登录已确认，筛选 Worker 正在启动并等待首条心跳。",
        browserAuthenticated: true,
        workerHeartbeatFresh: false
      });
      await delay(STATUS_HEARTBEAT_MS);
      continue;
    }

    if (stopping || sessionMonitorFailure || !sessionWorkersRunning(children)) return;
    await writeSessionStatus(statusPath, {
      state: "authenticated",
      message: authenticatedStatusMessage(contactDispatchMode)
    });
    await delay(STATUS_HEARTBEAT_MS);
  }
}

async function main(): Promise<void> {
  const runtime = await ensureRuntimeDirectory();
  const statusPath = join(runtime, "boss-login-status.json");
  const heartbeatPath = join(runtime, "worker-heartbeat.json");
  const refreshRequestPath = join(runtime, "boss-login-refresh-request.json");

  const loginRelay = startScript("boss-login-relay");
  const loginExit = await waitForSessionChildExit(loginRelay, () => {
    activeChildren.delete(loginRelay);
  });
  if (stopping) return;
  if (loginExit.code === LOGIN_BROWSER_RESTART_EXIT_CODE) throw new LoginBrowserRestartRequested();
  if (loginExit.error || loginExit.signal || loginExit.code !== 0) {
    throw new Error(`BOSS login relay failed: ${sessionChildExitMessage(loginExit)}`);
  }
  // A request accepted during a transient outage is satisfied by this fresh
  // login verification. Do not replay it after a later, unrelated outage.
  await consumeLoginRefreshRequest(refreshRequestPath);

  const apiRuntime = await controlApiRuntimeConsistency();
  if (!apiRuntime.consistent) {
    const mismatch: SessionMonitorFailure = {
      state: "error",
      message: `API 与 BOSS Worker 的发布版本或简历安全策略不一致，Worker 未启动（${apiRuntime.reasons.join(",")}）。请完成一致发布后受控重启。`,
      browserAuthenticated: true,
      workerHeartbeatFresh: false
    };
    while (!stopping) {
      await writeSessionStatus(statusPath, mismatch);
      await delay(STATUS_HEARTBEAT_MS);
    }
    return;
  }

  browserControlServer = await startBossBrowserControlServer({
    socketPath: bossBrowserControlSocketPath(runtime),
    accountId: bossAccountId,
    positions: () => readInAuthenticatedSession(readBossJobCatalog),
    chatInbox: (geekIds, leaseId) => readInAuthenticatedSession(() => readBossChatInbox(geekIds), true, leaseId),
    chatAttachment: (geekId, leaseId) => readInAuthenticatedSession(() => readBossChatAttachment(geekId), true, leaseId),
    chatResume: (geekId, leaseId) => readInAuthenticatedSession(() => readBossChatOnlineResume(geekId, bossAccountId), true, leaseId),
    chatRead: (geekId, leaseId) => readInAuthenticatedSession(() => readBossChat(geekId), true, leaseId),
    chatSend: (outgoingId, leaseId) => withContactGlobalFence(() => readInAuthenticatedSession(async () => {
      if (contactDispatchMode !== 'real') throw new BossBrowserControlError('unavailable', '真实发送未开启。');
      if (!(await controlApiRuntimeConsistency()).consistent) throw new BossBrowserControlError('unavailable', '发布版本不一致。');
      return sendQueuedBossChat(outgoingId, bossAccountId);
    }, false, leaseId)),
    chatWechat: (actionId, leaseId) => withContactGlobalFence(() => readInAuthenticatedSession(async () => {
      if (contactDispatchMode !== 'real') throw new BossBrowserControlError('unavailable', '真实发送未开启。');
      if (!(await controlApiRuntimeConsistency()).consistent) throw new BossBrowserControlError('unavailable', '发布版本不一致。');
      return sendQueuedBossWechat(actionId, bossAccountId);
    }, false, leaseId)),
    filterOptions: ({ bossJobId, jobKeyword }) => readInAuthenticatedSession(() => readBossFilterOptions({ id: bossJobId, name: jobKeyword, allowNameFallback: false })),
    greetingSave: (request) => readInAuthenticatedSession(() => saveBossJobGreeting(request)),
    greetingPreview: ({ jobKeyword }) =>
      readExactGreetingInAuthenticatedSession({ jobKeyword })
  });

  try {
    const m1CanaryObservation: { completion: M1CanaryCompletion | null } = {
      completion: null
    };
    const m1Worker = startScript("m1:worker", (line) => {
      const completion = parseM1CanaryCompletionLine(line);
      if (completion) m1CanaryObservation.completion = completion;
    });
    const workerEntries: Array<{ script: SessionScript; child: ChildProcess }> = [
      { script: "m1:worker", child: m1Worker }
    ];
    if (contactWorkerScript) {
      workerEntries.push({
        script: contactWorkerScript,
        child: startScript(contactWorkerScript)
      });
    }
    const workers = workerEntries.map(({ child }) => child);
    const workerStartedAt = Date.now();
    const statusHeartbeat = maintainWorkerStatus(
      workers,
      statusPath,
      heartbeatPath,
      workerStartedAt,
      () => m1CanaryObservation.completion
    );
    const exits = workerEntries.map(({ script, child }) =>
      waitForSessionChildExit(child, () => {
        activeChildren.delete(child);
      }).then((result) => ({ script, result }))
    );
    const firstExit = await Promise.race(exits);
    if (stopping) {
      stopSessionWorkers(workers);
      await Promise.allSettled(exits);
      await statusHeartbeat;
      return;
    }
    const observedM1CanaryCompletion = m1CanaryObservation.completion;
    if (
      firstExit.script === "m1:worker" &&
      !sessionMonitorFailure &&
      observedM1CanaryCompletion !== null &&
      isExpectedM1CanaryExit(
        firstExit.result,
        observedM1CanaryCompletion,
        process.env
      )
    ) {
      stopSessionWorkers(workers);
      await Promise.allSettled(exits);
      await statusHeartbeat;
      console.log(
        JSON.stringify({
          ok: true,
          event: "boss_session_supervisor.canary.completed",
          mode: observedM1CanaryCompletion.mode,
          recordedResumeAttempts: observedM1CanaryCompletion.recordedResumeAttempts,
          maxResumeAttempts: observedM1CanaryCompletion.maxResumeAttempts
        })
      );
      return;
    }
    if (!sessionMonitorFailure) {
      sessionMonitorFailure = {
        state: "error",
        message: sessionChildExitMessage(firstExit.result)
      };
    }
    stopSessionWorkers(workers);
    if (await bossRiskStatusActive(statusPath)) {
      sessionMonitorFailure = {
        state: "risk_controlled",
        message: "检测到 BOSS 风控或安全验证，已停止全部 BOSS Worker。"
      };
    }
    await Promise.allSettled(exits);
    await statusHeartbeat;
    if (sessionMonitorFailure) {
      if (sessionMonitorFailure.restartLoginRelay && !stopping) {
        // Workers have exited. Re-enter the existing login relay to expose the
        // real WeChat QR, or reuse a login that has already recovered.
        restartSessionRequested = true;
        sessionMonitorFailure = null;
        return;
      }
      while (!stopping) {
        const recovery = await recoverStoppedBossSession(sessionMonitorFailure, {
          riskActive: () => bossRiskStatusActive(statusPath),
          consumeRefresh: () => consumeLoginRefreshRequest(refreshRequestPath, () => writeSessionStatus(statusPath, {
            state: "starting", message: "正在检查扫码登录连接，请稍候…"
          })),
          inspect: () => inspectBossBrowserSession(debuggingPort)
        });
        if (stopping) return;
        if (recovery === "risk_controlled") {
          sessionMonitorFailure = {
            state: "risk_controlled",
            message: "BOSS 页面要求安全验证，任务保持暂停。请在官方页面完成验证后再恢复。"
          };
        }
        if (recovery === "restart_browser") {
          await writeSessionStatus(statusPath, {
            state: "starting", message: "正在重启扫码登录连接，请稍候…"
          });
          // The on-failure container restart replaces the stalled Chromium
          // while keeping its persisted profile. Consume once before exiting.
          throw new LoginBrowserRestartRequested();
        }
        if (recovery === "login_relay") {
          // The former workers have exited and their claims can be recovered.
          // Return through finally before opening a fresh browser-control socket.
          restartSessionRequested = true;
          sessionMonitorFailure = null;
          return;
        }
        await writeSessionStatus(statusPath, sessionMonitorFailure);
        await delay(STATUS_HEARTBEAT_MS);
      }
      return;
    }
  } finally {
    await closeBrowserControlServer();
  }
}

async function superviseSessions(): Promise<void> {
  do {
    restartSessionRequested = false;
    await main();
  } while (!stopping && restartSessionRequested);
}

const stopCommunicationResumeAnalysis=startCommunicationResumeAnalysis(bossAccountId);
superviseSessions().finally(stopCommunicationResumeAnalysis).catch((error: unknown) => {
  const requestedRestart = error instanceof LoginBrowserRestartRequested;
  (requestedRestart ? console.log : console.error)(
    JSON.stringify({
      ok: false,
      event: requestedRestart ? "boss_session_supervisor.browser_restart_requested" : "boss_session_supervisor.failed",
      message: error instanceof Error ? error.message : String(error)
    })
  );
  // BOSS workers and IPC have drained, and the analysis worker was awaited in
  // finally. A failed CDP connection must not keep this restart alive forever.
  if (requestedRestart) process.exit(1);
  process.exitCode = 1;
});
