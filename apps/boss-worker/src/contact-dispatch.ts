import {
  ContactDispatchPolicyError,
  type ContactDispatchJob,
  type M2Repository
} from "@boss-forge/data";

export class UncertainContactResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UncertainContactResultError";
  }
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

export type ContactTransport = {
  greet(job: ContactDispatchJob): Promise<{ externalMessage?: string | null }>;
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
  let transportResult: Awaited<ReturnType<ContactTransport["greet"]>>;
  try {
    transportResult = await transport.greet(job);
  } catch (error: unknown) {
    if (error instanceof ContactDispatchPolicyError && error.disposition === "deferred") {
      if (!error.availableAt) {
        throw new Error("Deferred contact policy error is missing availableAt.", { cause: error });
      }
      await store.deferContactDispatch({
        job,
        availableAt: error.availableAt,
        reason: error.message
      });
      return "deferred";
    }
    const uncertain = error instanceof UncertainContactResultError;
    await store.finishContactDispatch({
      job,
      result: uncertain ? "uncertain" : "failed",
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    return uncertain ? "uncertain" : "failed";
  }

  const dispatchResult = job.transportMode === "fake" ? "simulated" : "sent";
  try {
    await store.finishContactDispatch({
      job,
      result: dispatchResult,
      externalMessage: transportResult.externalMessage ?? null
    });
  } catch (error: unknown) {
    throw new ContactPersistenceAfterSideEffectError(job.transportMode, error);
  }
  return dispatchResult;
}
