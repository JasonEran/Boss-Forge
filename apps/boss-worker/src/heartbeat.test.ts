import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerHeartbeatSchema } from "@boss-forge/contracts";
import { startHeartbeatLoop, writeHeartbeat } from "./heartbeat.js";

describe.sequential("worker heartbeat", () => {
  const originalRuntime = process.env.BOSS_FORGE_RUNTIME_DIR;
  const originalOcr = process.env.BOSS_RESUME_OCR;
  const created: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    if (originalRuntime === undefined) delete process.env.BOSS_FORGE_RUNTIME_DIR;
    else process.env.BOSS_FORGE_RUNTIME_DIR = originalRuntime;
    if (originalOcr === undefined) delete process.env.BOSS_RESUME_OCR;
    else process.env.BOSS_RESUME_OCR = originalOcr;
    await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("continues heartbeats while idle and stops without a trailing write", async () => {
    vi.useFakeTimers();
    const writer = vi.fn(async () => undefined);
    const loop = startHeartbeatLoop(
      () => ({ state: "ready" }),
      { intervalMs: 1_000, writer }
    );
    await vi.advanceTimersByTimeAsync(3_100);
    expect(writer).toHaveBeenCalledTimes(3);
    await loop.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(writer).toHaveBeenCalledTimes(3);
  });

  it("writes a schema-valid atomic heartbeat with OCR disabled", async () => {
    const runtime = await mkdtemp(join(tmpdir(), "boss-forge-heartbeat-"));
    created.push(runtime);
    process.env.BOSS_FORGE_RUNTIME_DIR = runtime;
    process.env.BOSS_RESUME_OCR = "0";

    const result = await writeHeartbeat({ state: "ready" });
    const stored = WorkerHeartbeatSchema.parse(JSON.parse(await readFile(result.path, "utf8")));
    expect(stored.state).toBe("ready");
    expect(stored.ocrEnabled).toBe(false);
    expect(stored.bossCli.version).toBe("0.6.6");
    expect(typeof stored.chrome.available).toBe("boolean");
  });
});
