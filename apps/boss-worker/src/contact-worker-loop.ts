import { setTimeout as delay } from "node:timers/promises";
import type { runContactDispatchOnce } from "./contact-dispatch.js";

type DispatchResult = Awaited<ReturnType<typeof runContactDispatchOnce>>;
const POLL_INTERVAL_MIN_MS = 2_000;
const POLL_INTERVAL_MAX_MS = 30_000;

export async function runContactWorkerLoop(input: {
  runOnce: () => Promise<DispatchResult>;
  loop: boolean;
  shouldStop: () => boolean;
  onResult: (result: Exclude<DispatchResult, "idle">) => void;
  wait?: (milliseconds: number) => Promise<unknown>;
}): Promise<void> {
  const wait = input.wait ?? delay;
  let idlePollMs = POLL_INTERVAL_MIN_MS;
  do {
    const result = await input.runOnce();
    if (result !== "idle") {
      input.onResult(result);
      idlePollMs = POLL_INTERVAL_MIN_MS;
    }
    if (!input.loop || input.shouldStop()) return;
    // An uncertain receipt is a persisted task state, not a process failure.
    // Fresh uncertain briefly blocks new claims (see claimContactDispatch grace
    // window); stay alive so the supervisor does not also stop screening.
    if (result === "idle" || result === "uncertain") {
      await wait(idlePollMs);
      idlePollMs = Math.min(idlePollMs * 2, POLL_INTERVAL_MAX_MS);
    }
  } while (!input.shouldStop());
}
