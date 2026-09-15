import {
  BossCliExecutionError,
  parseBossContactNotStarted,
  parseBossContactProviderReceipt,
  runBossCommand,
  withContactGlobalFence
} from "@boss-forge/boss-cli-adapter";
import {
  ContactDispatchPolicyError,
  M2Repository,
  WorkspaceActivityRepository,
  createDatabase
} from "@boss-forge/data";
import { withAccountLock } from "./account-lock.js";
import {
  BossRiskControlledError,
  isBossRiskSignal,
  writeBossRiskStatus
} from "./boss-risk.js";
import {
  ContactSideEffectNotStartedError,
  classifyContactTransportBoundaryError,
  UncertainContactResultError,
  runContactDispatchOnce,
  type ContactTransport
} from "./contact-dispatch.js";
import { assertContactWorkerExecutionAllowed } from "./contact-safety.js";
import { refreshContactCandidateTarget } from "./contact-candidate.js";
import { safeWorkerErrorMessage } from "./error-message.js";
import { workerBossEnvironment } from "./runtime.js";
import { inspectBossBrowserSession } from "./session-health.js";
import { runContactWorkerLoop } from "./contact-worker-loop.js";

const CONTACT_ACCOUNT_LOCK_TIMEOUT_MS = 1_000;
const CONTACT_ACCOUNT_BUSY_RETRY_MS = 30_000;
let stopping = false;

function contactDispatchClock(): { now: Date; localMinuteOfDay: number } {
  const now = new Date();
  const localParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const hour = Number(localParts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(localParts.find((part) => part.type === "minute")?.value ?? "0");
  return { now, localMinuteOfDay: hour * 60 + minute };
}

async function main(): Promise<void> {
  const fakeMode =
    assertContactWorkerExecutionAllowed(process.argv, process.env) === "fake";
  const loop = process.argv.includes("--loop");
  const sql = createDatabase();
  const repository = new M2Repository(sql);
  const activity = new WorkspaceActivityRepository(sql);
  const accountId = process.env.BOSS_FORGE_ACCOUNT_ID?.trim() || "boss-account-01";
  const workerId = process.env.BOSS_FORGE_CONTACT_WORKER_ID?.trim() || "contact-worker-local-01";
  const transport: ContactTransport = {
    async perform(job) {
      if (job.bossAccountId !== accountId) {
        throw new Error("Claimed contact does not belong to the worker BOSS account.");
      }
      const { now, localMinuteOfDay } = contactDispatchClock();
      if (fakeMode) {
        await repository.assertContactDispatchAllowed({
          job,
          now: now.toISOString(),
          localMinuteOfDay
        });
        return {
          externalMessage:
            `FAKE ${job.actionKind} completed for ${job.candidateStateId}`
        };
      }
      // Every control-plane mutation that can invalidate a real contact takes
      // this same global fence. Holding it outside the account lock gives one
      // invariant lock order (global -> account) and closes the race between
      // the final database assertion and the irreversible BOSS write.
      let externalWriteStarted = false;
      try {
        return await withContactGlobalFence(() => withAccountLock(accountId, async () => {
        if (await activity.communicationActive(accountId)) {
          throw new ContactDispatchPolicyError({ disposition: 'deferred', reasons: ['boss_account_busy'], availableAt: new Date(Date.now() + CONTACT_ACCOUNT_BUSY_RETRY_MS).toISOString() });
        }
        let verifiedCandidate: Awaited<ReturnType<typeof refreshContactCandidateTarget>>;
        try {
          const debuggingPort = Number(
            process.env.BOSS_BROWSER_REMOTE_DEBUGGING_PORT ?? "53470"
          );
          if (!Number.isInteger(debuggingPort) || debuggingPort < 1 || debuggingPort > 65_535) {
            throw new Error("BOSS browser debugging port is invalid.");
          }
          const browserSession = await inspectBossBrowserSession(debuggingPort);
          if (browserSession.state !== "authenticated") {
            throw new Error(
              browserSession.state === "unavailable"
                ? browserSession.message
                : "BOSS 登录状态未通过发送前实时验证。"
            );
          }
          await repository.recordVerifiedBossAccountHealth(accountId, now.toISOString());
          await repository.assertContactDispatchAllowed({
            job,
            now: now.toISOString(),
            localMinuteOfDay
          });
          if (!job.candidateSnapshot.sourceLocator) {
            throw new Error(
              "BOSS_STABLE_LOCATOR_MISSING：候选人没有稳定的 BOSS 标识，已阻止真实联系。请重新采集后再审核。"
            );
          }
          if (job.source !== "recommend") {
            throw new Error(
              "BOSS_WRITE_SOURCE_UNSUPPORTED：当前仅支持对推荐列表中的稳定候选人标识执行真实联系；搜索结果请人工处理。"
            );
          }
          verifiedCandidate = job.actionKind === "greet"
            ? await refreshContactCandidateTarget(job)
            : job.candidateSnapshot;
          // Messages are verified against the exact conversation below; they do
          // not depend on a previously contacted person remaining recommended.
          if (!verifiedCandidate.sourceLocator) {
            throw new Error(
              "BOSS_STABLE_LOCATOR_MISSING：刷新后的候选人没有稳定标识，已阻止真实联系。"
            );
          }
        } catch (error: unknown) {
          if (error instanceof ContactDispatchPolicyError) throw error;
          throw new ContactSideEffectNotStartedError(
            safeWorkerErrorMessage(error),
            error
          );
        }

        if (job.actionKind === "greet") {
          if (
            !job.bossJobKeyword ||
            !job.providerJobId ||
            !job.providerGreetingId ||
            job.templateVersionId !== null ||
            verifiedCandidate.sourceLocator.kind !== "boss_geek_id"
          ) {
            throw new ContactSideEffectNotStartedError(
              "BOSS_GREETING_APPROVAL_BINDING_MISSING：打招呼许可缺少岗位、招呼语配置或候选人稳定标识，已停止。"
            );
          }
          try {
            // The database fence is checked again after all read-only identity
            // work and immediately before starting the one-write CLI command.
            const finalClock = contactDispatchClock();
            await repository.assertContactDispatchAllowed({
              job,
              now: finalClock.now.toISOString(),
              localMinuteOfDay: finalClock.localMinuteOfDay
            });
          } catch (error: unknown) {
            if (error instanceof ContactDispatchPolicyError) throw error;
            throw new ContactSideEffectNotStartedError(
              safeWorkerErrorMessage(error),
              error
            );
          }
          try {
            externalWriteStarted = true;
            const result = await runBossCommand(
              {
                type: "greet",
                candidateTarget: verifiedCandidate.name,
                sourceLocator: verifiedCandidate.sourceLocator,
                jobKeyword: job.bossJobKeyword,
                expectedJobId: job.providerJobId,
                expectedGreetingId: job.providerGreetingId,
                expectedMessageSha256: job.renderedMessageSha256
              },
              { timeoutMs: 60_000, env: workerBossEnvironment() }
            );
            const notStarted = parseBossContactNotStarted(result.stdout, {
              candidateId: verifiedCandidate.sourceLocator.value,
              jobId: job.providerJobId,
              greetingId: job.providerGreetingId,
              bodySha256: job.renderedMessageSha256
            });
            if (notStarted) {
              externalWriteStarted = false;
              throw new ContactSideEffectNotStartedError(
                `${notStarted.code}：${notStarted.message}`
              );
            }
            const provider = parseBossContactProviderReceipt(result.stdout, "greet");
            if (
              provider.candidateId !== verifiedCandidate.sourceLocator.value ||
              provider.providerCandidateId !== verifiedCandidate.sourceLocator.value ||
              provider.jobId !== job.providerJobId ||
              provider.greetingId !== job.providerGreetingId ||
              provider.bodySha256 !== job.renderedMessageSha256
            ) {
              throw new Error(
                "BOSS_GREET_POST_WRITE_RECEIPT_MISMATCH：开聊回执与许可绑定不一致。"
              );
            }
            return {
              receipt: {
                schemaVersion: 1,
                contactIntentId: job.id,
                attemptNo: job.attemptNo,
                actionKind: "greet",
                candidateStateId: job.candidateStateId,
                bossAccountId: job.bossAccountId,
                candidateLocatorSha256: job.sourceLocatorSha256!,
                renderedMessageSha256: job.renderedMessageSha256,
                providerJobId: provider.jobId,
                providerGreetingId: provider.greetingId,
                providerCandidateId: provider.providerCandidateId,
                responseCode: provider.responseCode,
                responseStatus: provider.responseStatus,
                newFriend: provider.newFriend,
                responseEvidenceSha256: provider.responseEvidenceSha256,
                acceptedAt: provider.acceptedAt
              }
            };
          } catch (error: unknown) {
            if (error instanceof ContactSideEffectNotStartedError) throw error;
            if (isBossRiskSignal(error)) throw new BossRiskControlledError(error);
            const timing =
              error instanceof BossCliExecutionError &&
              (error.result.timedOut || error.result.aborted)
                ? "命令超时或被中断"
                : "BOSS 回执未通过核验";
            throw new UncertainContactResultError(
              `真实打招呼命令已开始，随后${timing}，结果无法确认且不会自动重试：${safeWorkerErrorMessage(error)}`
            );
          }
        }

        try {
          // Opening and verifying the exact conversation is read-only. Keep it
          // in the same account lock as the send so another worker cannot
          // change the active conversation between verification and the write.
          await runBossCommand(
            {
              type: "chat-by-name",
              candidateName: verifiedCandidate.name,
              sourceLocator: verifiedCandidate.sourceLocator,
              strict: true
            },
            { timeoutMs: 60_000, env: workerBossEnvironment() }
          );
          // Read-only navigation can take long enough for approval, quota,
          // working hours or an emergency stop to change. Re-check immediately
          // before the one and only external write.
          const finalClock = contactDispatchClock();
          await repository.assertContactDispatchAllowed({
            job,
            now: finalClock.now.toISOString(),
            localMinuteOfDay: finalClock.localMinuteOfDay
          });
        } catch (error: unknown) {
          if (error instanceof ContactDispatchPolicyError) throw error;
          throw new ContactSideEffectNotStartedError(
            safeWorkerErrorMessage(error),
            error
          );
        }

        try {
          externalWriteStarted = true;
          const sendResult = await runBossCommand(
            {
              type: "send",
              text: job.renderedMessage,
              candidateTarget: verifiedCandidate.name,
              sourceLocator: verifiedCandidate.sourceLocator
            },
            { timeoutMs: 60_000, env: workerBossEnvironment() }
          );
          const provider = parseBossContactProviderReceipt(sendResult.stdout, "message");
          if (
            verifiedCandidate.sourceLocator.kind !== "boss_geek_id" ||
            provider.candidateId !== verifiedCandidate.sourceLocator.value ||
            provider.bodySha256 !== job.renderedMessageSha256
          ) {
            throw new Error(
              "BOSS_SEND_POST_WRITE_RECEIPT_MISMATCH：消息投递回执与许可候选人或正文不一致。"
            );
          }
          return {
            receipt: {
              schemaVersion: 1,
              contactIntentId: job.id,
              attemptNo: job.attemptNo,
              actionKind: "message",
              candidateStateId: job.candidateStateId,
              bossAccountId: job.bossAccountId,
              candidateLocatorSha256: job.sourceLocatorSha256!,
              renderedMessageSha256: job.renderedMessageSha256,
              providerMessageId: provider.serverMid,
              providerConversationId: provider.providerConversationId,
              acceptedAt: provider.acceptedAt
            }
          };
        } catch (error: unknown) {
          if (error instanceof UncertainContactResultError) throw error;
          if (isBossRiskSignal(error)) throw new BossRiskControlledError(error);
          const timing =
            error instanceof BossCliExecutionError &&
            (error.result.timedOut || error.result.aborted)
              ? "命令超时或被中断"
              : "BOSS 返回失败";
          throw new UncertainContactResultError(
            `真实消息发送已开始，随后${timing}，发送结果无法确认：${safeWorkerErrorMessage(error)}`
          );
        }
        }, { timeoutMs: CONTACT_ACCOUNT_LOCK_TIMEOUT_MS }));
      } catch (error: unknown) {
        throw classifyContactTransportBoundaryError({
          error,
          externalWriteStarted,
          safeMessage: safeWorkerErrorMessage(error),
          accountLockRetryAt: new Date(
            Date.now() + CONTACT_ACCOUNT_BUSY_RETRY_MS
          ).toISOString()
        });
      }
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
    await runContactWorkerLoop({
      runOnce: async () => !fakeMode && await activity.communicationActive(accountId) ? "idle" : runContactDispatchOnce(dispatchStore, transport, workerId),
      loop,
      shouldStop: () => stopping,
      onResult(result) {
        console.log(JSON.stringify({
          ok: result !== "failed" && result !== "uncertain",
          event: `m2.contact.${result}`
        }));
      }
    });
  } finally {
    await sql.end();
  }
}

process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });

main().catch(async (error: unknown) => {
  if (isBossRiskSignal(error)) {
    await writeBossRiskStatus().catch(() => undefined);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
