import {
  parseBossOutput,
  runBossCommand,
  type BossCommand
} from "@boss-forge/boss-cli-adapter";
import { BossForgeRepository, M2Repository, createDatabase, type Task } from "@boss-forge/data";
import { evaluateCandidate } from "@boss-forge/m1-core";
import { withAccountLock } from "./account-lock.js";
import { writeHeartbeat } from "./heartbeat.js";
import { workerBossEnvironment } from "./runtime.js";

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
      const processed = await processNextTask(repository);
      if (!processed) console.log(JSON.stringify({ ok: true, event: "m1.no_queued_task" }));
      return;
    }
    console.log(JSON.stringify({ ok: true, event: "m1.worker.ready", pollIntervalMs: POLL_INTERVAL_MS }));
    while (!stopping) {
      try {
        const scheduled = await m2Repository.materializeDueSchedules();
        if (scheduled > 0) {
          console.log(JSON.stringify({ ok: true, event: "m2.schedules.materialized", count: scheduled }));
        }
        const processed = await processNextTask(repository);
        if (!processed) await waitForNextPoll();
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
