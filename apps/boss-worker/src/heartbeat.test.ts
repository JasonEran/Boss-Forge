import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerHeartbeatSchema } from "@boss-forge/contracts";
import { writeHeartbeat } from "./heartbeat.js";

describe.sequential("worker heartbeat", () => {
  const originalRuntime = process.env.BOSS_FORGE_RUNTIME_DIR;
  const originalOcr = process.env.BOSS_RESUME_OCR;
  const created: string[] = [];

  afterEach(async () => {
    if (originalRuntime === undefined) delete process.env.BOSS_FORGE_RUNTIME_DIR;
    else process.env.BOSS_FORGE_RUNTIME_DIR = originalRuntime;
    if (originalOcr === undefined) delete process.env.BOSS_RESUME_OCR;
    else process.env.BOSS_RESUME_OCR = originalOcr;
    await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
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
