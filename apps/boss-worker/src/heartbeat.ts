import { hostname } from "node:os";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getBossCliInstallation } from "@boss-forge/boss-cli-adapter";
import {
  WorkerHeartbeatSchema,
  type WorkerHeartbeat,
  type WorkerState
} from "@boss-forge/contracts";
import { effectiveOcrEnabled, ensureRuntimeDirectory, resolveChromePath } from "./runtime.js";

export type HeartbeatInput = {
  state: WorkerState;
  activeAccountId?: string | null;
  lastError?: string | null;
};

export async function createHeartbeat(input: HeartbeatInput): Promise<WorkerHeartbeat> {
  const installation = await getBossCliInstallation();
  const chromePath = resolveChromePath();
  return WorkerHeartbeatSchema.parse({
    schemaVersion: 1,
    workerId: process.env.BOSS_FORGE_WORKER_ID?.trim() || "worker-local-01",
    hostname: hostname(),
    pid: process.pid,
    state: input.state,
    observedAt: new Date().toISOString(),
    nodeVersion: process.version,
    bossCli: {
      packageName: installation.packageName,
      version: installation.version,
      entrypoint: installation.entrypoint
    },
    chrome: {
      available: chromePath !== null,
      path: chromePath
    },
    ocrEnabled: effectiveOcrEnabled(),
    activeAccountId: input.activeAccountId ?? null,
    lastError: input.lastError ?? null
  });
}

export async function writeHeartbeat(input: HeartbeatInput): Promise<{
  heartbeat: WorkerHeartbeat;
  path: string;
}> {
  const runtime = await ensureRuntimeDirectory();
  const path = join(runtime, "worker-heartbeat.json");
  const temporaryPath = join(runtime, `worker-heartbeat.${process.pid}.tmp`);
  const heartbeat = await createHeartbeat(input);
  await writeFile(temporaryPath, `${JSON.stringify(heartbeat, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporaryPath, path);
  return { heartbeat, path };
}
