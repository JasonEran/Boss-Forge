import { describe, expect, it, vi } from "vitest";
import { runContactWorkerLoop } from "./contact-worker-loop.js";

describe("contact worker lifecycle", () => {
  it("stays alive after uncertain delivery and backs off while account claims are blocked", async () => {
    const runOnce = vi.fn().mockResolvedValue("idle").mockResolvedValueOnce("uncertain");
    const onResult = vi.fn();
    const waits: number[] = [];
    await runContactWorkerLoop({
      runOnce, loop: true, shouldStop: () => waits.length === 7, onResult,
      wait: async milliseconds => { waits.push(milliseconds); }
    });
    expect(runOnce).toHaveBeenCalledTimes(7);
    expect(onResult).toHaveBeenCalledExactlyOnceWith("uncertain");
    expect(waits).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it("still completes a requested one-shot run without waiting", async () => {
    const runOnce = vi.fn().mockResolvedValue("uncertain");
    const wait = vi.fn();
    await runContactWorkerLoop({ runOnce, loop: false, shouldStop: () => false, onResult() {}, wait });
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("does not claim again when shutdown is requested during dispatch", async () => {
    let stopping = false;
    const runOnce = vi.fn(async () => { stopping = true; return "uncertain" as const; });
    const wait = vi.fn();
    await runContactWorkerLoop({ runOnce, loop: true, shouldStop: () => stopping, onResult() {}, wait });
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("propagates infrastructure and risk failures to the supervisor", async () => {
    const failure = new Error("database unavailable");
    const runOnce = vi.fn().mockRejectedValue(failure);
    await expect(runContactWorkerLoop({ runOnce, loop: true, shouldStop: () => false, onResult() {} })).rejects.toBe(failure);
    expect(runOnce).toHaveBeenCalledTimes(1);
  });
});
