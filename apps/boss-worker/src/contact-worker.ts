import {
  BossCliExecutionError,
  parseBossOutput,
  runBossCommand,
  type BossCommand
} from "@boss-forge/boss-cli-adapter";
import { M2Repository, createDatabase } from "@boss-forge/data";
import { withAccountLock } from "./account-lock.js";
import {
  UncertainContactResultError,
  runContactDispatchOnce,
  type ContactTransport
} from "./contact-dispatch.js";
import { assertRealGreetExecutionAllowed } from "./contact-safety.js";
import { selectUnambiguousCandidateTarget } from "./candidate-target.js";
import { workerBossEnvironment } from "./runtime.js";

const POLL_INTERVAL_MS = 2_000;
let stopping = false;

async function waitForNextPoll(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
}

async function main(): Promise<void> {
  const fakeMode = process.argv.includes("--fake");
  if (!fakeMode) assertRealGreetExecutionAllowed(process.argv, process.env);
  const loop = process.argv.includes("--loop");
  const sql = createDatabase();
  const repository = new M2Repository(sql);
  const accountId = process.env.BOSS_FORGE_ACCOUNT_ID?.trim() || "boss-account-01";
  const workerId = process.env.BOSS_FORGE_CONTACT_WORKER_ID?.trim() || "contact-worker-local-01";
  const transport: ContactTransport = {
    async greet(job) {
      if (job.bossAccountId !== accountId) {
        throw new Error("Claimed contact does not belong to the worker BOSS account.");
      }
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
      if (fakeMode) {
        return { externalMessage: `FAKE contact completed for ${job.candidateStateId}` };
      }
      return withAccountLock(accountId, async () => {
        const contextCommand: BossCommand =
          job.source === "search"
            ? {
                type: "search",
                ...(job.searchKeyword ? { keyword: job.searchKeyword } : {})
              }
            : {
                type: "recommend",
                ...(job.bossJobKeyword ? { jobKeyword: job.bossJobKeyword } : {})
              };
        const contextResult = await runBossCommand(contextCommand, {
          timeoutMs: 60_000,
          env: workerBossEnvironment()
        });
        const parsedContext = parseBossOutput(
          contextResult.version,
          contextCommand,
          contextResult.stdout
        );
        if (parsedContext.kind !== "candidates") {
          throw new Error("Candidate identity refresh did not return a candidate list.");
        }
        const verifiedCandidate = selectUnambiguousCandidateTarget(
          job.candidateSnapshot,
          parsedContext.candidates
        );
        try {
          const result = await runBossCommand(
            {
              type: "greet",
              candidateTarget: verifiedCandidate.name,
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
    await repository.recoverStaleContactDispatches(
      accountId,
      fakeMode ? "fake" : "real"
    );
    const dispatchStore = {
      claimContactDispatch: (claimedBy: string) =>
        repository.claimContactDispatch(
          claimedBy,
          fakeMode ? "fake" : "real",
          accountId
        ),
      deferContactDispatch: repository.deferContactDispatch.bind(repository),
      finishContactDispatch: repository.finishContactDispatch.bind(repository)
    };
    do {
      const result = await runContactDispatchOnce(dispatchStore, transport, workerId);
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
