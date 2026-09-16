import {
  bossBrowserControlSocketPath,
  requestBossGreetingPreviewViaIpc,
  BossBrowserControlError
} from "@boss-forge/boss-cli-adapter";
import {
  contactDispatchModeFromEnvironment,
  contactPreviewApprovalSigningKeyFromEnvironment,
  contactSideEffectsModeFromEnvironment,
  issueContactPreviewApproval,
  type CandidateSourceLocator,
  type ContactPreviewApprovalContext
} from "@boss-forge/contracts";
import type { BossForgeRepository, M2Repository } from "@boss-forge/data";
import { runtimeDirectory } from "./runtime.js";
import { safeWorkerErrorMessage } from "./error-message.js";

function shanghaiMinuteOfDay(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

function requiredSourceLocator(
  locator: CandidateSourceLocator | null | undefined
): CandidateSourceLocator {
  if (!locator?.value?.trim()) {
    throw new Error("候选人缺少稳定的 BOSS 标识，无法自动打招呼。");
  }
  return locator;
}

async function readJobGreeting(input: {
  bossAccountId: string;
  bossJobId: string;
}): Promise<{ jobId: string; greetingId: string; body: string } | null> {
  try {
    const preview = await requestBossGreetingPreviewViaIpc({
      socketPath: bossBrowserControlSocketPath(runtimeDirectory()),
      accountId: input.bossAccountId,
      jobKeyword: input.bossJobId,
      timeoutMs: 40_000
    });
    if (!preview.jobId || !preview.greetingId || !preview.body?.trim()) return null;
    return {
      jobId: preview.jobId,
      greetingId: preview.greetingId,
      body: preview.body
    };
  } catch (error: unknown) {
    if (error instanceof BossBrowserControlError) {
      console.warn(
        JSON.stringify({
          ok: false,
          event: "m1.auto_greet.greeting_unavailable",
          code: error.code,
          message: safeWorkerErrorMessage(error)
        })
      );
      return null;
    }
    throw error;
  }
}

/** Approve chunk passers, enqueue greets when possible, then continue the next chunk. */
export async function finalizeScreeningChunks(input: {
  repository: BossForgeRepository;
  m2Repository: M2Repository;
  bossAccountId: string;
}): Promise<boolean> {
  const taskIds = await input.repository.listTasksReadyForChunkFinalize(
    input.bossAccountId
  );
  if (taskIds.length === 0) return false;
  let worked = false;
  const dispatchMode = contactDispatchModeFromEnvironment(process.env);
  const realGreet =
    contactSideEffectsModeFromEnvironment(process.env) === "real_greet_enabled";
  const transportMode =
    dispatchMode === "real" && realGreet
      ? "real"
      : dispatchMode === "fake"
        ? "fake"
        : null;

  for (const taskId of taskIds) {
    const prepared = await input.repository.prepareAutoGreetPassers(taskId);
    if (prepared.autoGreetEnabled && prepared.passers.length > 0) {
      if (!transportMode) {
        console.warn(
          JSON.stringify({
            ok: false,
            event: "m1.auto_greet.skipped",
            taskId,
            reason: "contact_dispatch_disabled",
            passers: prepared.passers.length
          })
        );
      } else {
        const first = prepared.passers[0]!;
        const greeting = first.bossJobId
          ? await readJobGreeting({
              bossAccountId: first.bossAccountId,
              bossJobId: first.bossJobId
            })
          : null;
        if (!greeting) {
          console.warn(
            JSON.stringify({
              ok: false,
              event: "m1.auto_greet.skipped",
              taskId,
              reason: "greeting_not_configured",
              passers: prepared.passers.length
            })
          );
        } else {
          const now = new Date();
          let submitted = 0;
          for (const passer of prepared.passers) {
            try {
              const target = await input.m2Repository.previewContactTarget(
                passer.stateId
              );
              const context: ContactPreviewApprovalContext = {
                actionKind: "greet",
                approvedBy: "system:auto-greet",
                candidateStateId: target.candidateStateId,
                candidateId: target.candidateId,
                candidateName: target.candidateName,
                positionId: target.positionId,
                positionName: target.positionName,
                taskId: target.taskId,
                bossAccountId: target.bossAccountId,
                source: target.source,
                sourceLocator: requiredSourceLocator(target.sourceLocator),
                templateVersionId: null,
                providerJobId: greeting.jobId,
                providerGreetingId: greeting.greetingId,
                renderedMessage: greeting.body
              };
              const realApproval =
                transportMode === "real"
                  ? issueContactPreviewApproval({
                      context,
                      signingKey:
                        contactPreviewApprovalSigningKeyFromEnvironment(
                          process.env
                        ),
                      now,
                      ttlMs: 10 * 60 * 1000
                    })
                  : undefined;
              await input.m2Repository.createManualContactIntent({
                stateId: passer.stateId,
                actionKind: "greet",
                idempotencyKey: `auto-greet-chunk:${passer.stateId}`,
                templateVersionId: null,
                providerJobId: greeting.jobId,
                providerGreetingId: greeting.greetingId,
                renderedMessage: greeting.body,
                createdBy: "system:auto-greet",
                localMinuteOfDay: shanghaiMinuteOfDay(now),
                now: now.toISOString(),
                transportMode,
                intervalSeconds: 10,
                ...(realApproval ? { realApproval } : {})
              });
              submitted += 1;
            } catch (error: unknown) {
              console.warn(
                JSON.stringify({
                  ok: false,
                  event: "m1.auto_greet.intent_failed",
                  taskId,
                  stateId: passer.stateId,
                  message: safeWorkerErrorMessage(error)
                })
              );
            }
          }
          console.log(
            JSON.stringify({
              ok: true,
              event: "m1.auto_greet.enqueued",
              taskId,
              submitted,
              requested: prepared.passers.length
            })
          );
          worked = true;
        }
      }
    }
    const continued = await input.repository.continueScreeningChunk(taskId);
    if (continued) {
      console.log(
        JSON.stringify({
          ok: true,
          event: "m1.task.chunk.continue",
          taskId,
          candidateCount: prepared.candidateCount,
          candidateLimit: prepared.candidateLimit
        })
      );
      worked = true;
    }
  }
  return worked;
}
