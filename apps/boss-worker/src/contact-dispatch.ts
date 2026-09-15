import {
  BossAccountLockTimeoutError
} from "@boss-forge/boss-cli-adapter";
import {
  ContactDispatchPolicyError,
  type ContactDispatchJob,
  type M2Repository
} from "@boss-forge/data";
import { BossRiskControlledError, isBossRiskSignal } from "./boss-risk.js";

export class UncertainContactResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UncertainContactResultError";
  }
}

/**
 * Marks a transport failure that happened while all operations were still
 * read-only. Real transports otherwise fail as uncertain because the
 * dispatcher cannot safely infer whether BOSS accepted an external write.
 */
export class ContactSideEffectNotStartedError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ContactSideEffectNotStartedError";
  }
}

/**
 * Converts failures at the worker's outer transport boundary into a definite
 * pre-write failure only while no irreversible BOSS command has started.
 * Once a write may have started, preserving the original error makes the
 * dispatcher fail closed as uncertain.
 */
export function classifyContactTransportBoundaryError(input: {
  error: unknown;
  externalWriteStarted: boolean;
  safeMessage: string;
  accountLockRetryAt: string;
}): unknown {
  if (
    !input.externalWriteStarted &&
    input.error instanceof BossAccountLockTimeoutError
  ) {
    return new ContactDispatchPolicyError({
      disposition: "deferred",
      reasons: ["boss_account_busy"],
      availableAt: input.accountLockRetryAt
    });
  }
  if (
    input.externalWriteStarted ||
    input.error instanceof ContactSideEffectNotStartedError ||
    input.error instanceof ContactDispatchPolicyError
  ) {
    return input.error;
  }
  return new ContactSideEffectNotStartedError(input.safeMessage, input.error);
}

export class ContactPersistenceAfterSideEffectError extends Error {
  constructor(transportMode: ContactDispatchJob["transportMode"], cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Contact transport (${transportMode}) returned successfully, but completion persistence failed; ` +
        `the dispatch remains processing for stale recovery: ${detail}`,
      { cause }
    );
    this.name = "ContactPersistenceAfterSideEffectError";
  }
}

type VerifiedContactReceiptCommon = {
  schemaVersion: 1;
  contactIntentId: string;
  attemptNo: number;
  actionKind: ContactDispatchJob["actionKind"];
  candidateStateId: string;
  bossAccountId: string;
  candidateLocatorSha256: string;
  renderedMessageSha256: string;
  acceptedAt: string;
};

export type VerifiedGreetReceipt = VerifiedContactReceiptCommon & {
  actionKind: "greet";
  providerJobId: string;
  providerGreetingId: string;
  providerCandidateId: string;
  responseCode: 0;
  responseStatus: 1;
  newFriend: 1;
  responseEvidenceSha256: string;
};

export type VerifiedMessageReceipt = VerifiedContactReceiptCommon & {
  actionKind: "message";
  providerMessageId: string;
  providerConversationId: string;
};

export type VerifiedContactReceipt = VerifiedGreetReceipt | VerifiedMessageReceipt;

export type ContactTransportResult = {
  /** Human-readable diagnostic output. It is not delivery proof. */
  externalMessage?: string | null;
  /**
   * A real dispatch is successful only when the provider/DOM transport can
   * return an immutable receipt bound to the exact approved action, target and
   * body. Plain CLI stdout must never be treated as a delivery receipt.
   */
  receipt?: VerifiedContactReceipt | null;
};

export class UnverifiedContactReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnverifiedContactReceiptError";
  }
}

function requiredReceiptText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) {
    throw new UnverifiedContactReceiptError(
      `真实联系回执缺少可核验的 ${field}，结果已锁定为待人工核验。`
    );
  }
  return value;
}

export function assertVerifiedContactReceipt(
  receipt: unknown,
  job: ContactDispatchJob,
  now: Date = new Date()
): asserts receipt is VerifiedContactReceipt {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new UnverifiedContactReceiptError(
      "真实联系仅返回本地操作结果，没有 BOSS 消息回执，结果已锁定为待人工核验。"
    );
  }
  const value = receipt as Partial<VerifiedContactReceipt>;
  const acceptedAt = Date.parse(requiredReceiptText(value.acceptedAt, "acceptedAt"));
  const createdAt = Date.parse(job.createdAt);
  if (
    !Number.isFinite(acceptedAt) ||
    !Number.isFinite(createdAt) ||
    acceptedAt < createdAt - 30_000 ||
    acceptedAt > now.getTime() + 30_000
  ) {
    throw new UnverifiedContactReceiptError(
      "真实联系回执时间无效，结果已锁定为待人工核验。"
    );
  }
  if (
    value.schemaVersion !== 1 ||
    value.contactIntentId !== job.id ||
    value.attemptNo !== job.attemptNo ||
    value.actionKind !== job.actionKind ||
    value.candidateStateId !== job.candidateStateId ||
    value.bossAccountId !== job.bossAccountId ||
    !job.sourceLocatorSha256 ||
    value.candidateLocatorSha256 !== job.sourceLocatorSha256 ||
    value.renderedMessageSha256 !== job.renderedMessageSha256
  ) {
    throw new UnverifiedContactReceiptError(
      "真实联系回执与本次许可的动作、候选人或正文不一致，结果已锁定为待人工核验。"
    );
  }
  if (job.actionKind === "greet") {
    const greet = value as Partial<VerifiedGreetReceipt>;
    const sourceLocator = job.candidateSnapshot.sourceLocator;
    if (
      job.templateVersionId !== null ||
      !job.providerJobId ||
      !job.providerGreetingId ||
      greet.providerJobId !== job.providerJobId ||
      greet.providerGreetingId !== job.providerGreetingId ||
      sourceLocator?.kind !== "boss_geek_id" ||
      greet.providerCandidateId !== sourceLocator.value ||
      greet.responseCode !== 0 ||
      greet.responseStatus !== 1 ||
      greet.newFriend !== 1 ||
      !/^[a-f0-9]{64}$/u.test(
        requiredReceiptText(greet.responseEvidenceSha256, "responseEvidenceSha256")
      )
    ) {
      throw new UnverifiedContactReceiptError(
        "打招呼回执与许可岗位、文案配置或候选人不一致，结果已锁定为待人工核验。"
      );
    }
    return;
  }
  if (
    !job.templateVersionId ||
    job.providerJobId !== null ||
    job.providerGreetingId !== null
  ) {
    throw new UnverifiedContactReceiptError(
      "正文消息任务缺少唯一模板版本绑定，结果已锁定为待人工核验。"
    );
  }
  const message = value as Partial<VerifiedMessageReceipt>;
  requiredReceiptText(message.providerMessageId, "providerMessageId");
  requiredReceiptText(message.providerConversationId, "providerConversationId");
}

export function serializeVerifiedContactReceipt(receipt: VerifiedContactReceipt): string {
  return JSON.stringify(receipt);
}

export type ContactTransport = {
  perform(job: ContactDispatchJob): Promise<ContactTransportResult>;
};

type DispatchStore = {
  claimContactDispatch(workerId: string): Promise<ContactDispatchJob | null>;
  deferContactDispatch: M2Repository["deferContactDispatch"];
  finishContactDispatch: M2Repository["finishContactDispatch"];
};

export async function runContactDispatchOnce(
  store: DispatchStore,
  transport: ContactTransport,
  workerId: string
): Promise<"idle" | "deferred" | "sent" | "simulated" | "failed" | "uncertain"> {
  const job = await store.claimContactDispatch(workerId);
  if (!job) return "idle";
  let transportResult: Awaited<ReturnType<ContactTransport["perform"]>>;
  try {
    transportResult = await transport.perform(job);
    if (job.transportMode === "real") {
      assertVerifiedContactReceipt(transportResult.receipt, job);
    }
  } catch (error: unknown) {
    if (error instanceof ContactDispatchPolicyError) {
      if (error.disposition === "deferred") {
        if (!error.availableAt) {
          throw new Error("Deferred contact policy error is missing availableAt.", {
            cause: error
          });
        }
        await store.deferContactDispatch({
          job,
          availableAt: error.availableAt,
          reason: error.message
        });
        return "deferred";
      }
      // A policy error is only raised by preflight checks, before the transport
      // performs an external write. A permanent block is therefore a definite
      // failure, including for real jobs, never an uncertain send.
      await store.finishContactDispatch({
        job,
        result: "failed",
        errorMessage: error.message
      });
      return "failed";
    }
    const riskControlled = isBossRiskSignal(error);
    const explicitlyReadOnly = error instanceof ContactSideEffectNotStartedError;
    const uncertain =
      !explicitlyReadOnly &&
      (job.transportMode === "real" ||
        error instanceof UncertainContactResultError ||
        riskControlled);
    await store.finishContactDispatch({
      job,
      result: uncertain ? "uncertain" : "failed",
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    if (riskControlled) throw new BossRiskControlledError(error);
    return uncertain ? "uncertain" : "failed";
  }

  const dispatchResult = job.transportMode === "fake" ? "simulated" : "sent";
  try {
    await store.finishContactDispatch({
      job,
      result: dispatchResult,
      externalMessage:
        job.transportMode === "real"
          ? serializeVerifiedContactReceipt(transportResult.receipt!)
          : transportResult.externalMessage ?? null
    });
  } catch (error: unknown) {
    throw new ContactPersistenceAfterSideEffectError(job.transportMode, error);
  }
  return dispatchResult;
}
