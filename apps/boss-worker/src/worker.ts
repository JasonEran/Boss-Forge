import { writeHeartbeat } from "./heartbeat.js";

const HEARTBEAT_INTERVAL_MS = 15_000;

let stopping = false;

async function emit(state: "ready" | "stopping", lastError: string | null = null): Promise<void> {
  const result = await writeHeartbeat({ state, lastError });
  console.log(JSON.stringify({ event: "worker.heartbeat", path: result.path, ...result.heartbeat }));
}

async function main(): Promise<void> {
  await emit("ready");
  const timer = setInterval(() => {
    void emit("ready").catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ event: "worker.heartbeat_failed", message }));
    });
  }, HEARTBEAT_INTERVAL_MS);

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    await emit("stopping");
  };

  process.once("SIGINT", () => void stop().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void stop().finally(() => process.exit(0)));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
