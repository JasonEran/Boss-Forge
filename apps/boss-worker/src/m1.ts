import { createHash } from "node:crypto";
import {
  parseBossOutput,
  runBossCommand,
  type BossCommand
} from "@boss-forge/boss-cli-adapter";
import {
  BossForgeRepository,
  M2Repository,
  createDatabase,
  type ResumeScreeningJob,
  type Task
} from "@boss-forge/data";
import { evaluateCandidate } from "@boss-forge/m1-core";
import { withAccountLock } from "./account-lock.js";
import { writeHeartbeat } from "./heartbeat.js";
import { effectiveOcrEnabled, workerBossEnvironment } from "./runtime.js";

const POLL_INTERVAL_MS = 2_000;
let stopping = false;

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
  const value = (process.env.BOSS_FORGE_RESUME_PREVIEW_ENABLED ?? "0").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(value) && effectiveOcrEnabled();
}

async function processNextTask(repository: BossForgeRepository): Promise<boolean> {
  const workerId = process.env.BOSS_FORGE_WORKER_ID?.trim() || "worker-local-01";
  const accountId = process.env.BOSS_FORGE_ACCOUNT_ID?.trim() || "boss-account-01";
  const task = await repository.claimNextTask(workerId);
  if (!task) return false;
  await withAccountLock(accountId, async () => {
    await writeHeartbeat({ state: "busy", activeAccountId: accountId });
    try {
      const command = collectionCommand(task);
      const result = await runBossCommand(command, {
        timeoutMs: 60_000,
        env: workerBossEnvironment()
      });
      const parsed = parseBossOutput(result.version, command, result.stdout);
      if (parsed.kind !== "candidates") {
        throw new Error(`Expected candidates result, received ${parsed.kind}.`);
      }
      const records = parsed.candidates.map((candidate) =>
        evaluateCandidate(candidate, task.ruleConfig)
      );
      await repository.completeTask(task, records);
      console.log(
        JSON.stringify({
          ok: true,
          event: "m1.task.completed",
          taskId: task.id,
          source: task.source,
          candidateCount: records.length,
          decisions: records.reduce<Record<string, number>>((summary, record) => {
            summary[record.decision] = (summary[record.decision] ?? 0) + 1;
            return summary;
          }, {})
        })
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await repository.failTask(task.id, message);
      throw error;
    } finally {
      await writeHeartbeat({ state: "ready" });
    }
  });
  return true;
}

async function processNextResumeScreening(repository: BossForgeRepository): Promise<boolean> {
  const workerId = process.env.BOSS_FORGE_WORKER_ID?.trim() || "worker-local-01";
  const accountId = process.env.BOSS_FORGE_ACCOUNT_ID?.trim() || "boss-account-01";
  const job = await repository.claimNextResumeScreening(workerId);
  if (!job) return false;
  await withAccountLock(accountId, async () => {
    await writeHeartbeat({ state: "busy", activeAccountId: accountId });
    try {
      const contextCommand = resumeContextCommand(job);
      const contextResult = await runBossCommand(contextCommand, {
        timeoutMs: 60_000,
        env: workerBossEnvironment()
      });
      const context = parseBossOutput(
        contextResult.version,
        contextCommand,
        contextResult.stdout
      );
      if (
        context.kind !== "candidates" ||
        !context.candidates.some((candidate) => candidate.name === job.candidateName)
      ) {
        throw new Error("Candidate is no longer present in the refreshed BOSS result list.");
      }
      const previewCommand: BossCommand = {
        type: "preview",
        candidateTarget: job.candidateName
      };
      const previewResult = await runBossCommand(previewCommand, {
        timeoutMs: 120_000,
        env: workerBossEnvironment()
      });
      const preview = parseBossOutput(
        previewResult.version,
        previewCommand,
        previewResult.stdout
      );
      if (preview.kind !== "resume") {
        throw new Error(`Expected resume result, received ${preview.kind}.`);
      }
      if (!preview.resume.ocrText?.trim()) {
        await repository.completeResumeScreeningWithoutText({
          stateId: job.stateId,
          taskId: job.taskId,
          screenshotPath: preview.resume.screenshotPath,
          workerId
        });
        return;
      }
      const resumeText = preview.resume.ocrText.trim();
      const record = evaluateCandidate(job.candidate, job.ruleConfig, resumeText);
      await repository.completeResumeScreening({
        job,
        record,
        screenshotPath: preview.resume.screenshotPath,
        resumeTextHash: createHash("sha256").update(resumeText).digest("hex"),
        workerId
      });
      console.log(
        JSON.stringify({
          ok: true,
          event: "m1.resume_screening.completed",
          stateId: job.stateId,
          decision: record.decision,
          currentEnglishLevel: record.currentEnglishLevel
        })
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await repository.failResumeScreening({
        stateId: job.stateId,
        taskId: job.taskId,
        message,
        workerId
      });
      console.error(
        JSON.stringify({
          ok: false,
          event: "m1.resume_screening.failed",
          stateId: job.stateId,
          message
        })
      );
    } finally {
      await writeHeartbeat({ state: "ready" });
    }
  });
  return true;
}

async function waitForNextPoll(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
}

async function main(): Promise<void> {
  const loop = process.argv.includes("--loop");
  const sql = createDatabase();
  const repository = new BossForgeRepository(sql);
  const m2Repository = new M2Repository(sql);
  try {
    await writeHeartbeat({ state: "ready" });
    if (!loop) {
      await m2Repository.materializeDueSchedules();
      const taskProcessed = await processNextTask(repository);
      const resumeProcessed = resumeScreeningEnabled()
        ? await processNextResumeScreening(repository)
        : false;
      if (!taskProcessed && !resumeProcessed) {
        console.log(JSON.stringify({ ok: true, event: "m1.no_queued_task" }));
      }
      return;
    }
    console.log(
      JSON.stringify({
        ok: true,
        event: "m1.worker.ready",
        pollIntervalMs: POLL_INTERVAL_MS,
        resumeScreeningEnabled: resumeScreeningEnabled()
      })
    );
    while (!stopping) {
      try {
        const scheduled = await m2Repository.materializeDueSchedules();
        if (scheduled > 0) {
          console.log(JSON.stringify({ ok: true, event: "m2.schedules.materialized", count: scheduled }));
        }
        const taskProcessed = await processNextTask(repository);
        const resumeProcessed = resumeScreeningEnabled()
          ? await processNextResumeScreening(repository)
          : false;
        if (!taskProcessed && !resumeProcessed) await waitForNextPoll();
      } catch (error: unknown) {
        console.error(
          JSON.stringify({
            ok: false,
            event: "m1.task.failed",
            message: error instanceof Error ? error.message : String(error)
          })
        );
        if (!stopping) await waitForNextPoll();
      }
    }
  } finally {
    await writeHeartbeat({ state: "stopping" }).catch(() => undefined);
    await sql.end();
  }
}

process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
