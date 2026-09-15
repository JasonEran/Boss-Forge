import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { BossAccountLockTimeoutError } from "@boss-forge/boss-cli-adapter";
import { acquireAccountLock, withAccountLock } from "./account-lock.js";

describe.sequential("account lock", () => {
  const originalRuntime = process.env.BOSS_FORGE_RUNTIME_DIR;
  const originalStaleMs = process.env.BOSS_FORGE_ACCOUNT_LOCK_STALE_MS;
  const created: string[] = [];

  afterEach(async () => {
    if (originalRuntime === undefined) delete process.env.BOSS_FORGE_RUNTIME_DIR;
    else process.env.BOSS_FORGE_RUNTIME_DIR = originalRuntime;
    if (originalStaleMs === undefined) delete process.env.BOSS_FORGE_ACCOUNT_LOCK_STALE_MS;
    else process.env.BOSS_FORGE_ACCOUNT_LOCK_STALE_MS = originalStaleMs;
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
    const blocked = acquireAccountLock("account-01", { timeoutMs: 40, pollMs: 10 });
    await expect(blocked).rejects.toBeInstanceOf(BossAccountLockTimeoutError);
    await expect(blocked).rejects.toThrow("Timed out waiting for account lock account-01");
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

  it("never removes a lock owned by another container hostname", async () => {
    const runtime = await isolatedRuntime();
    const locksDirectory = join(runtime, "locks");
    await mkdir(locksDirectory, { recursive: true });
    await writeFile(
      join(locksDirectory, "account-03.lock"),
      `${JSON.stringify({
        schemaVersion: 1,
        accountId: "account-03",
        pid: process.pid,
        hostname: "replaced-container",
        acquiredAt: new Date().toISOString()
      })}\n`,
      "utf8"
    );

    await expect(
      acquireAccountLock("account-03", { timeoutMs: 40, pollMs: 10 })
    ).rejects.toThrow(
      "an administrator must first confirm that no other browser or Worker is using this BOSS account"
    );
    const metadata = JSON.parse(
      await readFile(join(locksDirectory, "account-03.lock"), "utf8")
    ) as { hostname: string };
    expect(metadata.hostname).toBe("replaced-container");
  });

  it("keeps a worker alive until a pending lock acquisition settles", async () => {
    const runtime = await isolatedRuntime();
    await mkdir(join(runtime, "locks"), { recursive: true });
    await writeFile(join(runtime, "locks", "account-wait.lock"), JSON.stringify({
      schemaVersion: 1, accountId: "account-wait", pid: 1,
      hostname: "another-container", acquiredAt: new Date().toISOString()
    }));
    // No database socket or other timer keeps this child alive. A pending
    // promise alone cannot prevent Node from exiting before its timeout.
    const script = `
      import { acquireBossAccountLock } from './packages/boss-cli-adapter/src/account-lock.ts';
      acquireBossAccountLock('account-wait', { timeoutMs: 120, pollMs: 20 })
        .then(() => { process.exitCode = 1; })
        .catch(error => { console.log(error.name); });
    `;
    const output = execFileSync(process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script], {
        encoding: "utf8", cwd: new URL("../../../", import.meta.url),
        env: { ...process.env, BOSS_FORGE_RUNTIME_DIR: runtime }, timeout: 5_000
      });
    expect(output.trim()).toBe("BossAccountLockTimeoutError");
  });

  it("clears stale lock metadata from another hostname after age threshold", async () => {
    const runtime = await isolatedRuntime();
    const locksDirectory = join(runtime, "locks");
    await mkdir(locksDirectory, { recursive: true });
    process.env.BOSS_FORGE_ACCOUNT_LOCK_STALE_MS = "60000";
    await writeFile(
      join(locksDirectory, "account-04.lock"),
      `${JSON.stringify({
        schemaVersion: 1,
        accountId: "account-04",
        pid: 99999,
        hostname: "other-host",
        acquiredAt: new Date(Date.now() - 90_000).toISOString()
      })}\n`,
      "utf8"
    );

    const lock = await acquireAccountLock("account-04", { timeoutMs: 200, pollMs: 20 });
    const metadata = JSON.parse(
      await readFile(join(locksDirectory, "account-04.lock"), "utf8")
    ) as { hostname: string; pid: number };
    expect(metadata.hostname).toBe(hostname());
    expect(metadata.pid).toBe(process.pid);
    await lock.release();
  });
});
