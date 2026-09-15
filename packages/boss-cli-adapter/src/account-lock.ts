import { open, readFile, unlink, mkdir, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

type BossAccountLockMetadata = {
  schemaVersion: 1;
  accountId: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
};

export type BossAccountLock = {
  accountId: string;
  path: string;
  release(): Promise<void>;
};

export type BossAccountLockOptions = {
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
};
type AccountLockEnv = {
  accountLockStaleMs: number;
};

export class BossAccountLockTimeoutError extends Error {
  readonly accountId: string;
  readonly lockPath: string;

  constructor(accountId: string, lockPath: string, owner: BossAccountLockMetadata | null) {
    super(
      `Timed out waiting for account lock ${accountId}. Owner: ${
        owner ? JSON.stringify(owner) : "unknown"
      }. If this lock belongs to another container, an administrator must first confirm that no other browser or Worker is using this BOSS account, then remove the leftover lock file: ${lockPath}.`
    );
    this.name = "BossAccountLockTimeoutError";
    this.accountId = accountId;
    this.lockPath = lockPath;
  }
}

function safeAccountSegment(accountId: string): string {
  const normalized = accountId.trim();
  if (!normalized) throw new Error("accountId must not be empty.");
  if (!/^[A-Za-z0-9._-]+$/u.test(normalized)) {
    throw new Error(
      "accountId may only contain letters, numbers, dot, underscore, and hyphen."
    );
  }
  return normalized;
}

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code =
      error && typeof error === "object" && "code" in error ? error.code : null;
    return code === "EPERM";
  }
}

function accountLockEnv(): AccountLockEnv {
  const staleMsValue = process.env.BOSS_FORGE_ACCOUNT_LOCK_STALE_MS?.trim();
  const staleMs = staleMsValue === undefined ? 15 * 60_000 : Number(staleMsValue);
  if (!Number.isFinite(staleMs) || staleMs < 60_000 || !Number.isInteger(staleMs)) {
    throw new Error("BOSS_FORGE_ACCOUNT_LOCK_STALE_MS must be an integer >= 60000.");
  }
  return { accountLockStaleMs: staleMs };
}

function lockMetadataAgeMs(raw: string): number | null {
  const acquiredAt = Date.parse(raw);
  if (Number.isNaN(acquiredAt)) return null;
  return Date.now() - acquiredAt;
}

async function readMetadata(path: string): Promise<BossAccountLockMetadata | null> {
  try {
    const parsed = JSON.parse(
      await readFile(path, "utf8")
    ) as Partial<BossAccountLockMetadata>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.accountId !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.hostname !== "string" ||
      typeof parsed.acquiredAt !== "string"
    ) {
      return null;
    }
    return parsed as BossAccountLockMetadata;
  } catch (error: unknown) {
    const code =
      error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "ENOENT") return null;
    throw error;
  }
}

async function clearStaleLocalLock(path: string): Promise<boolean> {
  const metadata = await readMetadata(path);
  if (!metadata) return false;
  // A PID is meaningful only inside the current host/container namespace. Never
  // remove a lock written by another hostname: it may still protect the one
  // authenticated browser session in a sibling container.
  const { accountLockStaleMs } = accountLockEnv();
  const isForeignLock = metadata.hostname !== hostname();
  if (isForeignLock) {
    const ageMs = lockMetadataAgeMs(metadata.acquiredAt);
    if (ageMs === null || ageMs < accountLockStaleMs) return false;
  }
  if (processExists(metadata.pid)) return false;
  try {
    await unlink(path);
    return true;
  } catch (error: unknown) {
    const code =
      error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "ENOENT") return true;
    throw error;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, reject) => {
    if (signal?.aborted) {
      reject(new Error("BOSS account lock acquisition aborted."));
      return;
    }
    const finish = (): void => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("BOSS account lock acquisition aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // This is awaited foreground work. An unref'ed timer lets an otherwise
    // idle Worker exit successfully while it still owns a database claim.
  });
}

async function writeLock(
  handle: FileHandle,
  metadata: BossAccountLockMetadata
): Promise<void> {
  await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
  await handle.sync();
}

function bossRuntimeDirectory(): string {
  const configured = process.env.BOSS_FORGE_RUNTIME_DIR?.trim();
  return resolve(configured || resolve(process.cwd(), ".boss-forge", "runtime"));
}

export async function acquireBossAccountLock(
  accountId: string,
  options: BossAccountLockOptions = {}
): Promise<BossAccountLock> {
  const safeId = safeAccountSegment(accountId);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 250;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("timeoutMs must be positive.");
  }
  if (!Number.isInteger(pollMs) || pollMs < 10) {
    throw new Error("pollMs must be at least 10ms.");
  }
  const locksDirectory = join(bossRuntimeDirectory(), "locks");
  await mkdir(locksDirectory, { recursive: true, mode: 0o700 });
  const path = join(locksDirectory, `${safeId}.lock`);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    if (options.signal?.aborted) {
      throw new Error("BOSS account lock acquisition aborted.");
    }
    try {
      const handle = await open(path, "wx", 0o600);
      const metadata: BossAccountLockMetadata = {
        schemaVersion: 1,
        accountId: safeId,
        pid: process.pid,
        hostname: hostname(),
        acquiredAt: new Date().toISOString()
      };
      try {
        await writeLock(handle, metadata);
      } finally {
        await handle.close();
      }
      let released = false;
      return {
        accountId: safeId,
        path,
        async release(): Promise<void> {
          if (released) return;
          released = true;
          const current = await readMetadata(path);
          if (
            !current ||
            current.pid !== process.pid ||
            current.hostname !== hostname()
          ) {
            throw new Error(`BOSS account lock ownership changed before release: ${path}`);
          }
          await unlink(path);
        }
      };
    } catch (error: unknown) {
      const code =
        error && typeof error === "object" && "code" in error ? error.code : null;
      if (code !== "EEXIST") throw error;
      if (await clearStaleLocalLock(path)) continue;
      if (Date.now() >= deadline) {
        const owner = await readMetadata(path);
        throw new BossAccountLockTimeoutError(safeId, path, owner);
      }
      await delay(pollMs, options.signal);
    }
  }
}

export async function withBossAccountLock<T>(
  accountId: string,
  callback: () => Promise<T>,
  options: BossAccountLockOptions = {}
): Promise<T> {
  const lock = await acquireBossAccountLock(accountId, options);
  try {
    return await callback();
  } finally {
    await lock.release();
  }
}
