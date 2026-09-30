import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function check(state: string, heartbeatState = "ready", age = 0) {
  const dir = mkdtempSync(join(tmpdir(), "boss-health-"));
  try {
    writeFileSync(join(dir, "boss-login-status.json"), JSON.stringify({
      state, updatedAt: new Date().toISOString(), verification: { browserAuthenticated: true, workerHeartbeatFresh: true }
    }));
    writeFileSync(join(dir, "worker-heartbeat.json"), JSON.stringify({ state: heartbeatState, observedAt: new Date(Date.now() - age).toISOString() }));
    return spawnSync(process.execPath, ["apps/boss-worker/scripts/login-healthcheck.mjs"], {
      env: { ...process.env, BOSS_FORGE_RUNTIME_DIR: dir }
    }).status;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("login container health", () => {
  it("does not report a recently updated error or risk hold as healthy", () => {
    expect(check("error")).toBe(1);
    expect(check("risk_controlled")).toBe(1);
  });
  it("requires a live worker for authenticated service", () => {
    expect(check("authenticated")).toBe(0);
    expect(check("authenticated", "stopping")).toBe(1);
    expect(check("authenticated", "ready", 60_000)).toBe(1);
  });
  it("allows the login service to wait for a human scan without workers", () => {
    expect(check("awaiting_scan", "stopping", 60_000)).toBe(0);
  });
});
