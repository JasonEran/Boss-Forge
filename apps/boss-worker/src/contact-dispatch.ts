import type { ContactDispatchJob, M2Repository } from "@boss-forge/data";

export class UncertainContactResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UncertainContactResultError";
  }
}

export type ContactTransport = {
  greet(job: ContactDispatchJob): Promise<{ externalMessage?: string | null }>;
};

type DispatchStore = Pick<M2Repository, "claimContactDispatch" | "finishContactDispatch">;

export async function runContactDispatchOnce(
  store: DispatchStore,
  transport: ContactTransport,
  workerId: string
): Promise<"idle" | "sent" | "failed" | "uncertain"> {
  const job = await store.claimContactDispatch(workerId);
  if (!job) return "idle";
  try {
    const result = await transport.greet(job);
    await store.finishContactDispatch({
      job,
      result: "sent",
      externalMessage: result.externalMessage ?? null
    });
    return "sent";
  } catch (error: unknown) {
    const uncertain = error instanceof UncertainContactResultError;
    await store.finishContactDispatch({
      job,
      result: uncertain ? "uncertain" : "failed",
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    return uncertain ? "uncertain" : "failed";
  }
}
