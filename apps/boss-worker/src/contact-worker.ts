import { BossCliExecutionError, runBossCommand } from "@boss-forge/boss-cli-adapter";
import { M2Repository, createDatabase } from "@boss-forge/data";
import { withAccountLock } from "./account-lock.js";
import {
  UncertainContactResultError,
  runContactDispatchOnce,
  type ContactTransport
} from "./contact-dispatch.js";
import { assertRealGreetExecutionAllowed } from "./contact-safety.js";
import { workerBossEnvironment } from "./runtime.js";

const POLL_INTERVAL_MS = 2_000;
let stopping = false;

async function waitForNextPoll(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
}

async function main(): Promise<void> {
  assertRealGreetExecutionAllowed(process.argv, process.env);
  const loop = process.argv.includes("--loop");
  const sql = createDatabase();
  const repository = new M2Repository(sql);
  const accountId = process.env.BOSS_FORGE_ACCOUNT_ID?.trim() || "boss-account-01";
  const workerId = process.env.BOSS_FORGE_CONTACT_WORKER_ID?.trim() || "contact-worker-local-01";
  const transport: ContactTransport = {
    async greet(job) {
      const now = new Date();
      const localParts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Shanghai",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      }).formatToParts(now);
      const hour = Number(localParts.find((part) => part.type === "hour")?.value ?? "0");
      const minute = Number(localParts.find((part) => part.type === "minute")?.value ?? "0");
      await repository.assertContactDispatchAllowed({
        job,
        now: now.toISOString(),
        localMinuteOfDay: hour * 60 + minute
      });
      return withAccountLock(accountId, async () => {
        try {
          const result = await runBossCommand(
            {
              type: "greet",
              candidateTarget: job.candidateTarget,
              ...(job.bossJobKeyword ? { jobKeyword: job.bossJobKeyword } : {})
            },
            { timeoutMs: 60_000, env: workerBossEnvironment() }
          );
          return { externalMessage: result.stdout || "boss-cli greet completed" };
        } catch (error: unknown) {
          if (error instanceof BossCliExecutionError && (error.result.timedOut || error.result.aborted)) {
            throw new UncertainContactResultError(error.message);
          }
          throw error;
        }
      });
    }
  };
  try {
    await repository.recoverStaleContactDispatches();
    do {
      const result = await runContactDispatchOnce(repository, transport, workerId);
      console.log(JSON.stringify({ ok: result !== "failed", event: `m2.contact.${result}` }));
      if (!loop || result === "uncertain") break;
      if (result === "idle") await waitForNextPoll();
    } while (!stopping);
  } finally {
    await sql.end();
  }
}

process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
