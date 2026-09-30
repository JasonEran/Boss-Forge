import { readFileSync } from "node:fs";
import { join } from "node:path";

const runtime = process.env.BOSS_FORGE_RUNTIME_DIR || "/var/lib/boss-forge/runtime";
try {
  const status = JSON.parse(readFileSync(join(runtime, "boss-login-status.json"), "utf8"));
  const now = Date.now();
  const fresh = (timestamp) => {
    const age = now - Date.parse(timestamp);
    return age >= -5_000 && age < 20_000;
  };
  if (!fresh(status.updatedAt) || !["starting", "awaiting_scan", "authenticated"].includes(status.state)) {
    process.exit(1);
  }
  if (status.state === "authenticated") {
    const heartbeat = JSON.parse(readFileSync(join(runtime, "worker-heartbeat.json"), "utf8"));
    if (!status.verification?.browserAuthenticated || !status.verification?.workerHeartbeatFresh ||
        !fresh(heartbeat.observedAt) || !["ready", "busy", "degraded"].includes(heartbeat.state)) {
      process.exit(1);
    }
  }
  process.exit(0);
} catch {
  process.exit(1);
}
