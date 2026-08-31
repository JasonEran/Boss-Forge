import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { acquireAccountLock, withAccountLock } from "./account-lock.js";

describe.sequential("account lock", () => {
  const originalRuntime = process.env.BOSS_FORGE_RUNTIME_DIR;
  const created: string[] = [];

  afterEach(async () => {
    if (originalRuntime === undefined) delete process.env.BOSS_FORGE_RUNTIME_DIR;
    else process.env.BOSS_FORGE_RUNTIME_DIR = originalRuntime;
    await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function isolatedRuntime(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "boss-forge-lock-"));
    created.push(path);
    process.env.BOSS_FORGE_RUNTIME_DIR = path;
    return path;
  }

  it("serializes access to the same account", async () => {
    await isolatedRuntime();
    const first = await acquireAccountLock("account-01");
    await expect(
      acquireAccountLock("account-01", { timeoutMs: 40, pollMs: 10 })
    ).rejects.toThrow("Timed out waiting for account lock account-01");
    await first.release();
    const second = await acquireAccountLock("account-01");
    await second.release();
  });

  it("records lock ownership and releases after callback", async () => {
    const runtime = await isolatedRuntime();
    await withAccountLock("account-02", async () => {
      const metadata = JSON.parse(
        await readFile(join(runtime, "locks", "account-02.lock"), "utf8")
      ) as { accountId: string; pid: number };
      expect(metadata.accountId).toBe("account-02");
      expect(metadata.pid).toBe(process.pid);
    });
    await expect(readFile(join(runtime, "locks", "account-02.lock"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});
