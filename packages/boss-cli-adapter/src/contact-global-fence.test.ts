import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTACT_GLOBAL_FENCE_FILE_NAME,
  acquireContactGlobalFence,
  withContactGlobalFence
} from "./contact-global-fence.js";

describe.sequential("contact-global fence", () => {
  const originalRuntime = process.env.BOSS_FORGE_RUNTIME_DIR;
  const created: string[] = [];

  afterEach(async () => {
    if (originalRuntime === undefined) delete process.env.BOSS_FORGE_RUNTIME_DIR;
    else process.env.BOSS_FORGE_RUNTIME_DIR = originalRuntime;
    await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function isolatedRuntime(): Promise<string> {
    const runtime = await mkdtemp(join(tmpdir(), "boss-contact-fence-"));
    created.push(runtime);
    process.env.BOSS_FORGE_RUNTIME_DIR = runtime;
    return runtime;
  }

  it("serializes callers and creates a 0600 token-owned fence", async () => {
    const runtime = await isolatedRuntime();
    const first = await acquireContactGlobalFence();
    const metadata = JSON.parse(await readFile(first.path, "utf8")) as { token: string };
    expect(metadata.token).toMatch(/^[0-9a-f-]{36}$/u);
    expect((await stat(first.path)).mode & 0o777).toBe(0o600);

    await expect(acquireContactGlobalFence({ timeoutMs: 30, pollMs: 10 }))
      .rejects.toThrow("administrator must first confirm that no contact Worker is running");
    expect(await readFile(join(runtime, "locks", CONTACT_GLOBAL_FENCE_FILE_NAME), "utf8"))
      .toContain(metadata.token);

    await first.release();
    await expect(withContactGlobalFence(async () => "ok", { timeoutMs: 100 }))
      .resolves.toBe("ok");
  });

  it("never removes an existing fence automatically", async () => {
    await isolatedRuntime();
    const first = await acquireContactGlobalFence();
    await expect(acquireContactGlobalFence({ timeoutMs: 30, pollMs: 10 }))
      .rejects.toThrow("remove the leftover fence file");
    expect(await readFile(first.path, "utf8")).toContain("acquiredAt");
    await first.release();
  });
});
