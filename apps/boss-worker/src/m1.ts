import { withScreeningBrowser } from './workspace-browser.js';
import { remainingResumeDwellMs } from './resume-dwell.js';
import { readBoundBossRecommendation } from "./boss-jobs.js";
import { describeBossFilters, planBossRecommendationFilters } from "@boss-forge/contracts";
import { createHash } from "node:crypto";
import { collectedRecommendJobLabel } from "./resume-source-context.js";
import { recoverResumeCandidateInRecommendation } from "./resume-list-recovery.js";
import { pathToFileURL } from "node:url";
import {
  readResumeArtifact,
  parseBossOutput,
  runBossCommand,
  type BossCommand
} from "@boss-forge/boss-cli-adapter";
import {
  BossForgeRepository,
  WorkspaceActivityRepository,
  M2Repository,
  ResumeScreeningLeaseLostError,
  createDatabase,
  limitScreeningRecords,
  type ResumeScreeningJob,
  type Task
} from "@boss-forge/data";
import {
  candidateRuleText,
  collectSemanticRules,
  evaluateCandidate
} from "@boss-forge/m1-core";
import {
  applySemanticCatalogEntries,
  evaluateSemanticRules,
  semanticProviderFromEnvironment,
  semanticProviderReadinessFromEnvironment
} from "@boss-forge/semantic-engine";
import {
  contactSideEffectsModeFromEnvironment,
  resumeDwellSeconds,
  nextResumeViewingAt,
  resumeViewPolicyState,
  resumeViewPolicyFromEnvironment,
  shanghaiDayStart,
  type ParsedCandidate
} from "@boss-forge/contracts";
import { isBossRiskSignal, writeBossRiskStatus } from "./boss-risk.js";
import { selectUnambiguousCandidateTarget } from "./candidate-target.js";
import { safeWorkerErrorMessage } from "./error-message.js";
import {
  startHeartbeatLoop,
  writeHeartbeat,
  type HeartbeatInput,
  type HeartbeatLoop
} from "./heartbeat.js";
import {
  autoRetryableResumeScreeningError,
  resumeRetryAt,
  resumeScreeningErrorCode,
} from "./resume-recovery.js";
import {
  effectiveOcrEnabled,
  resumePreviewEnabled,
  resumeOcrProvider,
  workerBossEnvironment
} from "./runtime.js";
import {
  recognizeResumeWithTencentOcr,
  resumeOcrLooksUsable,
  tencentOcrConfigured
} from "./tencent-ocr.js";

const POLL_INTERVAL_MS = 2_000;
const RESUME_SCREENING_MAX_CLAIM_ATTEMPTS = 3;
const RESUME_VIEW_POLICY = resumeViewPolicyFromEnvironment(process.env);
const SEMANTIC_PROVIDER_READINESS = semanticProviderReadinessFromEnvironment(process.env);
let stopping = false;
let continuousResumeViews = 0;
let heartbeatInput: HeartbeatInput = { state: "ready" };
let heartbeatLoop: HeartbeatLoop | null = null;

export type M1Mode = "normal" | "collection-only" | "resume-only";

export type M1ExecutionOptions = {
  loop: boolean;
  mode: M1Mode;
  maxResumeAttempts: number | null;
};

export type M1ModeCapabilities = {
  materializeSchedules: boolean;
  processCollections: boolean;
  processResumes: boolean;
};

export function contactPriorityTransportModeFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env
): "fake" | "real" | null {
  const mode = contactSideEffectsModeFromEnvironment(environment);
  if (mode === "fake_only") return "fake";
  if (mode === "real_greet_enabled") return "real";
  return null;
}

const M1_MODES = new Set<M1Mode>([
  "normal",
  "collection-only",
  "resume-only"
]);

function parseM1Mode(value: string, source: string): M1Mode {
  if (!M1_MODES.has(value as M1Mode)) {
    throw new Error(
      `${source} 必须是 normal、collection-only 或 resume-only，当前值为 ${JSON.stringify(value)}`
    );
  }
  return value as M1Mode;
}

function parseResumeAttemptLimit(value: string, source: string): number {
  if (!/^(?:[1-9]|1\d|20)$/u.test(value)) {
    throw new Error(`${source} 必须是 1 到 20 之间的整数`);
  }
  return Number(value);
}

/**
 * Parse the deliberately small M1 command surface. Explicit CLI values take
 * precedence over valid environment values so an operator can safely narrow a
 * long-running supervisor without editing its environment file.
 */
export function parseM1ExecutionOptions(
  argv: readonly string[] = process.argv.slice(2),
  environment: Readonly<Record<string, string | undefined>> = process.env
): M1ExecutionOptions {
  const environmentModeValue = environment.BOSS_FORGE_M1_MODE?.trim();
  const environmentMode =
    !environmentModeValue
      ? "normal"
      : parseM1Mode(environmentModeValue, "BOSS_FORGE_M1_MODE");
  const environmentLimitValue =
    environment.BOSS_FORGE_CANARY_MAX_RESUME_ATTEMPTS?.trim();
  const environmentLimit =
    !environmentLimitValue
      ? null
      : parseResumeAttemptLimit(
          environmentLimitValue,
          "BOSS_FORGE_CANARY_MAX_RESUME_ATTEMPTS"
        );

  let loop = false;
  let cliMode: M1Mode | null = null;
  let cliLimit: number | null = null;
  let cliLimitProvided = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--loop") {
      loop = true;
      continue;
    }
    if (argument === "--collection-only" || argument === "--resume-only") {
      const requestedMode: M1Mode =
        argument === "--collection-only" ? "collection-only" : "resume-only";
      if (cliMode && cliMode !== requestedMode) {
        throw new Error("--collection-only 与 --resume-only 不能同时使用");
      }
      cliMode = requestedMode;
      continue;
    }
    if (argument === "--max-resume-attempts") {
      if (cliLimitProvided) {
        throw new Error("--max-resume-attempts 只能设置一次");
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--max-resume-attempts 需要一个 1 到 20 之间的整数");
      }
      cliLimit = parseResumeAttemptLimit(value, "--max-resume-attempts");
      cliLimitProvided = true;
      index += 1;
      continue;
    }
    if (argument.startsWith("--max-resume-attempts=")) {
      if (cliLimitProvided) {
        throw new Error("--max-resume-attempts 只能设置一次");
      }
      cliLimit = parseResumeAttemptLimit(
        argument.slice("--max-resume-attempts=".length),
        "--max-resume-attempts"
      );
      cliLimitProvided = true;
      continue;
    }
    throw new Error(`未知的 M1 参数：${argument}`);
  }

  const mode = cliMode ?? environmentMode;
  const maxResumeAttempts = cliLimitProvided ? cliLimit : environmentLimit;
  if (mode === "collection-only" && maxResumeAttempts !== null) {
    throw new Error("collection-only 模式不会查看简历，不能设置简历尝试上限");
  }
  return { loop, mode, maxResumeAttempts };
}

export function m1ModeCapabilities(mode: M1Mode): M1ModeCapabilities {
  return {
    materializeSchedules: mode !== "resume-only",
    processCollections: mode !== "resume-only",
    processResumes: mode !== "collection-only"
  };
}

export function mayClaimAnotherResume(
  recordedResumeAttempts: number,
  maxResumeAttempts: number | null
): boolean {
  return maxResumeAttempts === null || recordedResumeAttempts < maxResumeAttempts;
}

async function setWorkerHeartbeat(input: HeartbeatInput): Promise<void> {
  heartbeatInput = input;
  if (heartbeatLoop) {
    await heartbeatLoop.pulse();
    return;
  }
  await writeHeartbeat(input);
}

async function waitWhileRunning(milliseconds: number): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!stopping && Date.now() < deadline) {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(1_000, deadline - Date.now()))
    );
  }
}

type ResumeViewingAvailability =
  | { available: true }
  | {
      available: false;
      code:
        | "outside_working_hours"
        | "daily_hard_limit_reached"
        | "hourly_quota_reached"
        | "daily_quota_reached";
      reason: string;
      nextRunAt: Date;
    };

async function resumeViewingAvailability(
  repository: BossForgeRepository,
  accountId: string,
  now: Date
): Promise<ResumeViewingAvailability> {
  const usage = await repository.resumeViewUsage(
    accountId,
    shanghaiDayStart(now),
    new Date(now.getTime() - 60 * 60 * 1_000)
  );
  const state = resumeViewPolicyState(now, RESUME_VIEW_POLICY, usage);
  if (state === "outside_working_hours") {
    return {
      available: false,
      code: "outside_working_hours",
      reason: `当前不在安全查看时段（${RESUME_VIEW_POLICY.workdayStartHour}:00–${RESUME_VIEW_POLICY.workdayEndHour}:00），系统将在下个工作时段继续`,
      nextRunAt: nextResumeViewingAt(now, RESUME_VIEW_POLICY)
    };
  }
  if (state === "daily_hard_limit_reached") {
    return {
      available: false,
      code: state,
      reason: "今日简历查看已达到系统安全硬上限，系统将在下个工作日继续",
      nextRunAt: nextResumeViewingAt(now, RESUME_VIEW_POLICY)
    };
  }
  if (state === "daily_quota_reached") {
    return {
      available: false,
      code: state,
      reason: "今日安全查看额度已用完，系统将在下个工作日继续",
      nextRunAt: nextResumeViewingAt(now, RESUME_VIEW_POLICY)
    };
  }
  if (state === "hourly_quota_reached") {
    return {
      available: false,
      code: state,
      reason: "每小时安全查看额度已用完，系统将在额度恢复后继续",
      nextRunAt: usage.nextHourlyAvailableAt ?? new Date(now.getTime() + 60 * 60 * 1_000)
    };
  }
  return { available: true };
}

function collectionCommand(task: Task): BossCommand {
  if (task.source === "search") {
    return task.searchKeyword
      ? { type: "search", keyword: task.searchKeyword }
      : { type: "search" };
  }
  return task.bossJobKeyword
    ? { type: "recommend", jobKeyword: task.bossJobKeyword }
    : { type: "recommend" };
}

function resumeContextCommand(job: ResumeScreeningJob): BossCommand {
  if (job.source === "search") {
    return job.searchKeyword
      ? { type: "search", keyword: job.searchKeyword }
      : { type: "search" };
  }
  return job.bossJobKeyword
    ? { type: "recommend", jobKeyword: job.bossJobKeyword }
    : { type: "recommend" };
}

function resumeScreeningEnabled(): boolean {
  const ocrReady =
    resumeOcrProvider() === "tencent" ? tencentOcrConfigured() : effectiveOcrEnabled();
  return resumePreviewEnabled() && ocrReady;
}

type ResumePreviewArtifact = {
  screenshotPath: string | null;
  resumeText: string;
  ocrLineCount: number | null;
  ocrAverageConfidence: number | null;
  ocrRequestId: string | null;
};

function previewCommandForCandidate(
  candidate: ParsedCandidate
): BossCommand {
  return {
    type: "preview",
    candidateTarget: candidate.name,
    ...(candidate.sourceLocator ? { sourceLocator: candidate.sourceLocator } : {})
  };
}

async function refreshResumeCandidateTarget(
  job: ResumeScreeningJob
): Promise<ParsedCandidate> {
  const contextCommand = resumeContextCommand(job);
  const contextResult = job.source === "recommend" && job.bossJobId
    ? await readBoundBossRecommendation({ id: job.bossJobId, name: job.bossJobKeyword ?? "", allowNameFallback: job.bossJobNameUnique === true, filters: job.sourceBossFilters ?? null })
    : await runBossCommand(contextCommand, {
    timeoutMs: 60_000,
    env: workerBossEnvironment()
  });
  const context = parseBossOutput(
    contextResult.version,
    contextCommand,
    contextResult.stdout
  );
  if (context.kind !== "candidates") {
    throw new Error("Candidate context did not return a candidate list.");
  }
  try {
    return selectUnambiguousCandidateTarget(job.candidate, context.candidates, {
    // Resume preview is read-only. A refreshed BOSS iframe can replace the
    // opaque card ID; recover it only when the unique name and stable card
    // fingerprint still identify the same collected candidate.
      allowExpiredLocatorFingerprintFallback: true
    });
  } catch (error) {
    if (job.source !== "recommend" || !(error instanceof Error) ||
      !/BOSS_SOURCE_EXPIRED|BOSS_TARGET_MISSING/u.test(error.message)) throw error;
    const recovered = await recoverResumeCandidateInRecommendation(job.candidate, job.bossJobKeyword);
    if (recovered) return recovered;
    throw new Error("BOSS_SOURCE_EXPIRED：返回岗位并检查更多已加载卡片后，仍未定位到原候选人。可能是推荐已更新或候选人暂不可见；跨天旧任务建议重新采集，不能据此认定候选人已删除。");
  }
}

async function readResumePreview(
  command: BossCommand,
  provider: ReturnType<typeof resumeOcrProvider>,
  onScreenshot: (path: string) => Promise<void>
): Promise<ResumePreviewArtifact> {
  const previewResult = await runBossCommand(command, {
    timeoutMs: 240_000,
    env: workerBossEnvironment()
  });
  const preview = parseBossOutput(
    previewResult.version,
    command,
    previewResult.stdout
  );
  if (preview.kind !== "resume") {
    throw new Error(`Expected resume result, received ${preview.kind}.`);
  }
  if (!preview.resume.screenshotPath || !(await readResumeArtifact(preview.resume.screenshotPath)).complete) {
    throw new Error("BOSS_RESUME_INCOMPLETE：本次简历未取得完整截图，请重新读取。");
  }
  await onScreenshot(preview.resume.screenshotPath);
  let resumeText = preview.resume.ocrText?.trim() || "";
  let ocrLineCount: number | null = resumeText
    ? resumeText.split(/\r?\n/u).length
    : null;
  let ocrAverageConfidence: number | null = null;
  let ocrRequestId: string | null = null;
  if (!resumeText && provider === "tencent" && preview.resume.screenshotPath) {
    const ocrResult = await recognizeResumeWithTencentOcr(preview.resume.screenshotPath);
    resumeText = ocrResult.text.trim();
    ocrLineCount = ocrResult.lineCount;
    ocrAverageConfidence = ocrResult.averageConfidence;
    ocrRequestId = ocrResult.requestId;
  }
  if (
    provider === "tencent" &&
    preview.resume.screenshotPath &&
    !resumeOcrLooksUsable(resumeText)
  ) {
    throw new Error(
      "BOSS_RESUME_CONTENT_EMPTY：简历截图中没有取得可用正文，系统将自动重新打开并等待内容稳定。"
    );
  }
  return {
    screenshotPath: preview.resume.screenshotPath,
    resumeText,
    ocrLineCount,
    ocrAverageConfidence,
    ocrRequestId
  };
}

export async function readSingleResumePreviewAttempt(
  job: ResumeScreeningJob,
  provider: ReturnType<typeof resumeOcrProvider>,
  beforePreview: () => Promise<void> = async () => undefined,
  onScreenshot: (path: string) => Promise<void> = async () => undefined
): Promise<ResumePreviewArtifact> {
  // One claimed attempt may issue at most one preview command. A failed preview
  // can already have opened the resume and consumed a platform view, so recovery
  // must happen through the claim-level 5/10 minute backoff where a fresh audit
  // record and quota check are created. Never retry a click inside this function.
  // A stable locator identifies a card, not the currently selected BOSS job.
  // Collections, contact work and a browser reconnect can all change that list
  // between claims (including the very first attempt). Restore this task's list
  // and resolve the current card on EVERY claim. runRecommend keeps the existing
  // list when its job already matches; it does not force a browser refresh.
  const target = await refreshResumeCandidateTarget(job);
  await beforePreview();
  return readResumePreview(previewCommandForCandidate(target), provider, onScreenshot);
}

async function processNextTask(repository: BossForgeRepository, activity: WorkspaceActivityRepository): Promise<boolean> {
  const workerId = process.env.BOSS_FORGE_WORKER_ID?.trim() || "worker-local-01";
  const accountId = process.env.BOSS_FORGE_ACCOUNT_ID?.trim() || "boss-account-01";
  return withScreeningBrowser(accountId, activity, async () => {
    const task = await repository.claimNextTask(workerId, accountId);
    if (!task) return false;
    if (task.bossAccountId !== accountId) {
      throw new Error("Claimed task does not belong to the worker BOSS account.");
    }
    await setWorkerHeartbeat({ state: "busy", activeAccountId: accountId });
    try {
      const command = collectionCommand(task);
      const officialFilters = task.source === "recommend" && task.bossJobId ? planBossRecommendationFilters(task.ruleConfig) : null;
      if (officialFilters) console.log(JSON.stringify({ event: "m1.task.official_filters", taskId: task.id, stage: "applying", summary: describeBossFilters(officialFilters) }));
      const result = task.source === "recommend" && task.bossJobId
        ? await readBoundBossRecommendation({ id: task.bossJobId, name: task.bossJobKeyword ?? "", allowNameFallback: task.bossJobNameUnique === true, filters: officialFilters },
          { candidateLimit: task.candidateLimit ?? 20, task: { id: task.id, claimToken: task.claimToken } })
        : await runBossCommand(command, {
        timeoutMs: 60_000,
        env: workerBossEnvironment()
      });
      const parsed = parseBossOutput(result.version, command, result.stdout);
      if (parsed.kind !== "candidates") {
        throw new Error(`Expected candidates result, received ${parsed.kind}.`);
      }
      await repository.recordBossAccountHealthy(
        accountId,
        "Authenticated BOSS candidate read completed successfully."
      );
      const records = parsed.candidates.map((candidate) =>
        evaluateCandidate(candidate, task.ruleConfig, null, [], officialFilters)
      );
      await repository.completeTask(
        task,
        records,
        task.source === "recommend" ? collectedRecommendJobLabel(parsed.raw) : null,
        officialFilters
      );
      console.log(
        JSON.stringify({
          ok: true,
          event: "m1.task.completed",
          taskId: task.id,
          source: task.source,
          candidateCount: records.length,
          admittedCandidateCount: limitScreeningRecords(records, task.candidateLimit ?? 20).length,
          candidateLimit: task.candidateLimit ?? 20,
          decisions: records.reduce<Record<string, number>>((summary, record) => {
            summary[record.decision] = (summary[record.decision] ?? 0) + 1;
            return summary;
          }, {})
        })
      );
    } catch (error: unknown) {
      const message = safeWorkerErrorMessage(error);
      await repository.failTask(task.id, message, task.claimToken);
      throw error;
    } finally {
      await setWorkerHeartbeat({ state: "ready" });
    }
    return true;
  });
}

async function processNextResumeScreening(
  repository: BossForgeRepository,
  activity: WorkspaceActivityRepository,
  onResumeViewRecorded: () => void = () => undefined,
  contactPriorityTransportMode: "fake" | "real" | null = null
): Promise<boolean> {
  const workerId = process.env.BOSS_FORGE_WORKER_ID?.trim() || "worker-local-01";
  const accountId = process.env.BOSS_FORGE_ACCOUNT_ID?.trim() || "boss-account-01";
  const now = new Date();
  const availability = await resumeViewingAvailability(repository, accountId, now);
  if (!availability.available) {
    await repository.markResumeScreeningWait({
      bossAccountId: accountId,
      code: availability.code,
      reason: availability.reason,
      nextRunAt: availability.nextRunAt
    });
    return false;
  }
  await repository.clearResumeScreeningWait(accountId);
  let postLockBatchBreakMs = 0;
  const processed = await withScreeningBrowser(accountId, activity, async () => {
    const job = await repository.claimNextResumeScreening(
      workerId,
      accountId,
      shanghaiDayStart(now),
      contactPriorityTransportMode
    );
    if (!job) return false;
    if (job.bossAccountId !== accountId) {
      throw new Error("Claimed resume job does not belong to the worker BOSS account.");
    }

    await setWorkerHeartbeat({ state: "busy", activeAccountId: accountId });
    let resumeLoadedAt: number | null = null;
    let dwellSeconds = RESUME_VIEW_POLICY.dwellTargetSeconds;
    let riskDetected = false;
    try {
      const provider = resumeOcrProvider();
      const {
        screenshotPath,
        resumeText,
        ocrLineCount,
        ocrAverageConfidence,
        ocrRequestId
      } = await readSingleResumePreviewAttempt(job, provider, async () => {
        // Resolve the card first. A missing card has not opened a resume and
        // must not consume a view. Record immediately before the one preview
        // command, which also rechecks the task lease after list recovery.
        const attemptedAt = Date.now();
        await repository.recordResumeView({
          stateId: job.stateId,
          candidateId: job.candidateId,
          taskId: job.taskId,
          bossAccountId: job.bossAccountId,
          workerId,
          openedAt: new Date(attemptedAt).toISOString()
        });
        onResumeViewRecorded();
        continuousResumeViews += 1;
      }, async path => {
        // readResumePreview verifies a complete captured resume before this callback.
        resumeLoadedAt = Date.now();
        await repository.saveResumeScreenshot({ stateId: job.stateId, taskId: job.taskId, workerId, screenshotPath: path });
      });
      dwellSeconds = resumeDwellSeconds(RESUME_VIEW_POLICY, resumeText.length);
      if (!resumeText) {
        await repository.completeResumeScreeningWithoutText({
          stateId: job.stateId,
          taskId: job.taskId,
          screenshotPath,
          workerId
        });
        return true;
      }
      const semanticRules = applySemanticCatalogEntries(
        collectSemanticRules(job.ruleConfig),
        job.semanticCatalogEntries
      );
      const semanticEvaluations =
        semanticRules.length === 0
          ? []
          : await evaluateSemanticRules({
              candidateText: `${candidateRuleText(job.candidate)}\n完整简历：${resumeText}`,
              rules: semanticRules,
              provider: job.semanticMode === "off" ? null : semanticProviderFromEnvironment(),
              runtimeMode: job.semanticMode,
              catalogVersion: job.semanticCatalogVersionId
            });
      const record = evaluateCandidate(
        job.candidate,
        job.ruleConfig,
        resumeText,
        semanticEvaluations,
        job.sourceBossFilters
      );
      await repository.completeResumeScreening({
        job,
        record,
        screenshotPath,
        resumeTextHash: createHash("sha256").update(resumeText).digest("hex"),
        workerId,
        ocrProvider: provider,
        ocrLineCount,
        ocrAverageConfidence,
        ocrRequestId
      });
      console.log(
        JSON.stringify({
          ok: true,
          event: "m1.resume_screening.completed",
          stateId: job.stateId,
          decision: record.decision,
          currentEnglishLevel: record.currentEnglishLevel,
          semanticEvaluationCount: semanticEvaluations.length,
          semanticRuntimeMode: job.semanticMode,
          semanticCatalogVersionId: job.semanticCatalogVersionId,
          ocrProvider: provider,
          ocrLineCount,
          ocrAverageConfidence
        })
      );
    } catch (error: unknown) {
      const message = safeWorkerErrorMessage(error);
      if (error instanceof ResumeScreeningLeaseLostError) {
        // The database atomically proved that this worker no longer owns an
        // open task/state lease. Nothing has reached BOSS, so do not mark the
        // cancelled or reassigned state failed and do not schedule a retry.
        console.warn(
          JSON.stringify({
            ok: true,
            event: "m1.resume_screening.skipped_lease_lost",
            stateId: job.stateId,
            taskId: job.taskId,
            message
          })
        );
        return true;
      }
      const errorCode = resumeScreeningErrorCode(message);
      if (isBossRiskSignal(error)) {
        riskDetected = true;
        await repository.failResumeScreening({
          stateId: job.stateId,
          taskId: job.taskId,
          message,
          workerId,
          errorCode: "risk_control"
        });
        throw error;
      }
      if (
        autoRetryableResumeScreeningError(errorCode) &&
        job.resumeScreeningAttempts < RESUME_SCREENING_MAX_CLAIM_ATTEMPTS
      ) {
        const nextAttemptAt = resumeRetryAt(new Date(), job.resumeScreeningAttempts);
        await repository.deferResumeScreening({
          stateId: job.stateId,
          taskId: job.taskId,
          message,
          workerId,
          errorCode,
          nextAttemptAt
        });
        console.warn(
          JSON.stringify({
            ok: true,
            event: "m1.resume_screening.deferred",
            stateId: job.stateId,
            claimAttempt: job.resumeScreeningAttempts,
            maxClaimAttempts: RESUME_SCREENING_MAX_CLAIM_ATTEMPTS,
            reason: message,
            nextAttemptAt: nextAttemptAt.toISOString()
          })
        );
      } else {
        await repository.failResumeScreening({
          stateId: job.stateId,
          taskId: job.taskId,
          message,
          workerId,
          errorCode
        });
        console.error(
          JSON.stringify({
            ok: false,
            event: "m1.resume_screening.failed",
            stateId: job.stateId,
            message
          })
        );
      }
    } finally {
      if (!riskDetected) {
        const remainingMs = remainingResumeDwellMs(resumeLoadedAt, Date.now(), dwellSeconds);
        if (remainingMs > 0) await waitWhileRunning(remainingMs);
      }
      await setWorkerHeartbeat({ state: "ready" });
      if (
        !riskDetected &&
        continuousResumeViews >= RESUME_VIEW_POLICY.continuousBatchSize
      ) {
        console.log(
          JSON.stringify({
            ok: true,
            event: "m1.resume_viewing.break",
            viewed: continuousResumeViews,
            breakMinutes: RESUME_VIEW_POLICY.breakMinutes
          })
        );
        continuousResumeViews = 0;
        await repository.markResumeScreeningWait({
          bossAccountId: accountId,
          code: "batch_break",
          reason: `连续查看 ${RESUME_VIEW_POLICY.continuousBatchSize} 份简历后安全休息`,
          nextRunAt: new Date(Date.now() + RESUME_VIEW_POLICY.breakMinutes * 60 * 1_000)
        });
        postLockBatchBreakMs = RESUME_VIEW_POLICY.breakMinutes * 60 * 1_000;
      }
    }
    return true;
  });
  // The batch break paces future BOSS reads but does not protect active browser
  // state. Release the account lock first so an explicitly approved contact is
  // not held behind a ten-minute idle sleep.
  if (postLockBatchBreakMs > 0) {
    await waitWhileRunning(postLockBatchBreakMs);
  }
  return processed;
}

async function waitForNextPoll(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
}

async function main(options: M1ExecutionOptions): Promise<void> {
  const capabilities = m1ModeCapabilities(options.mode);
  const contactPriorityTransportMode =
    contactPriorityTransportModeFromEnvironment(process.env);
  let recordedResumeAttempts = 0;
  const recordResumeAttempt = (): void => {
    recordedResumeAttempts += 1;
  };
  const sql = createDatabase();
  const repository = new BossForgeRepository(sql);
  const m2Repository = new M2Repository(sql);
  const activity = new WorkspaceActivityRepository(sql);
  try {
    await setWorkerHeartbeat({ state: "ready" });
    heartbeatLoop = startHeartbeatLoop(() => heartbeatInput, {
      onError(error) {
        console.error(
          JSON.stringify({
            ok: false,
            event: "m1.heartbeat.failed",
            message: safeWorkerErrorMessage(error)
          })
        );
      }
    });
    if (!options.loop) {
      if (capabilities.materializeSchedules) {
        await m2Repository.materializeDueSchedules();
      }
      const taskProcessed = capabilities.processCollections
        ? await processNextTask(repository, activity)
        : false;
      const resumeProcessed =
        capabilities.processResumes &&
        resumeScreeningEnabled() &&
        mayClaimAnotherResume(recordedResumeAttempts, options.maxResumeAttempts)
          ? await processNextResumeScreening(
              repository,
              activity,
              recordResumeAttempt,
              contactPriorityTransportMode
            )
        : false;
      if (!taskProcessed && !resumeProcessed) {
        console.log(JSON.stringify({ ok: true, event: "m1.no_queued_task" }));
      }
      if (
        options.maxResumeAttempts !== null &&
        !mayClaimAnotherResume(recordedResumeAttempts, options.maxResumeAttempts)
      ) {
        console.log(
          JSON.stringify({
            ok: true,
            event: "m1.canary.completed",
            mode: options.mode,
            recordedResumeAttempts,
            maxResumeAttempts: options.maxResumeAttempts
          })
        );
      }
      return;
    }
    console.log(
      JSON.stringify({
        ok: true,
        event: "m1.worker.ready",
        mode: options.mode,
        maxResumeAttempts: options.maxResumeAttempts,
        pollIntervalMs: POLL_INTERVAL_MS,
        resumeScreeningEnabled: resumeScreeningEnabled(),
        resumeProcessingActive:
          capabilities.processResumes && resumeScreeningEnabled(),
        resumeViewPolicy: RESUME_VIEW_POLICY,
        ocrProvider: resumeOcrProvider(),
        semanticEnabled: SEMANTIC_PROVIDER_READINESS.enabled,
        semanticProviderReady: SEMANTIC_PROVIDER_READINESS.ready,
        semanticProviderReason: SEMANTIC_PROVIDER_READINESS.reason,
        semanticEndpointHost: SEMANTIC_PROVIDER_READINESS.endpointHost,
        semanticModel: SEMANTIC_PROVIDER_READINESS.model,
        semanticModeSource: "position"
      })
    );
    while (
      !stopping &&
      mayClaimAnotherResume(recordedResumeAttempts, options.maxResumeAttempts)
    ) {
      try {
        if (capabilities.materializeSchedules) {
          // A broken schedule must not block already collected resumes or
          // manually created tasks in the same worker loop.
          const scheduled = await m2Repository.materializeDueSchedules().catch((error: unknown) => {
            console.error(JSON.stringify({ ok: false, event: "m2.schedules.failed", message: safeWorkerErrorMessage(error) }));
            return 0;
          });
          if (scheduled > 0) {
            console.log(
              JSON.stringify({
                ok: true,
                event: "m2.schedules.materialized",
                count: scheduled
              })
            );
          }
        }
        const resumeProcessed =
          capabilities.processResumes &&
          resumeScreeningEnabled() &&
          mayClaimAnotherResume(recordedResumeAttempts, options.maxResumeAttempts)
            ? await processNextResumeScreening(
                repository,
                activity,
                recordResumeAttempt,
                contactPriorityTransportMode
              )
          : false;
        const taskProcessed = !resumeProcessed && capabilities.processCollections
          ? await processNextTask(repository, activity)
          : false;
        if (!mayClaimAnotherResume(recordedResumeAttempts, options.maxResumeAttempts)) {
          break;
        }
        if (!taskProcessed && !resumeProcessed) await waitForNextPoll();
      } catch (error: unknown) {
        if (isBossRiskSignal(error)) {
          await writeBossRiskStatus();
          throw error;
        }
        console.error(
          JSON.stringify({
            ok: false,
            event: "m1.task.failed",
            message: safeWorkerErrorMessage(error)
          })
        );
        if (!stopping) await waitForNextPoll();
      }
    }
    if (
      !stopping &&
      options.maxResumeAttempts !== null &&
      !mayClaimAnotherResume(recordedResumeAttempts, options.maxResumeAttempts)
    ) {
      console.log(
        JSON.stringify({
          ok: true,
          event: "m1.canary.completed",
          mode: options.mode,
          recordedResumeAttempts,
          maxResumeAttempts: options.maxResumeAttempts
        })
      );
    }
  } finally {
    await heartbeatLoop?.stop().catch(() => undefined);
    heartbeatLoop = null;
    await setWorkerHeartbeat({ state: "stopping" }).catch(() => undefined);
    await sql.end();
  }
}

function isDirectM1Execution(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}

async function runM1Cli(): Promise<void> {
  const options = parseM1ExecutionOptions();
  process.once("SIGINT", () => {
    stopping = true;
  });
  process.once("SIGTERM", () => {
    stopping = true;
  });
  await main(options);
}

if (isDirectM1Execution()) {
  runM1Cli().catch((error: unknown) => {
    console.error(safeWorkerErrorMessage(error));
    process.exitCode = 1;
  });
}
