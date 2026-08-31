import { hostname } from "node:os";
import { mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { ensureRuntimeDirectory } from "./runtime.js";

type LockMetadata = {
  schemaVersion: 1;
  accountId: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
};

export type AccountLock = {
  accountId: string;
  path: string;
  release(): Promise<void>;
};

export type AccountLockOptions = {
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
};

function safeAccountSegment(accountId: string): string {
  const normalized = accountId.trim();
  if (!normalized) throw new Error("accountId must not be empty.");
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error("accountId may only contain letters, numbers, dot, underscore, and hyphen.");
  }
  return normalized;
}

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    return code === "EPERM";
  }
}

async function readMetadata(path: string): Promise<LockMetadata | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<LockMetadata>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.accountId !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.hostname !== "string" ||
      typeof parsed.acquiredAt !== "string"
    ) {
      return null;
    }
    return parsed as LockMetadata;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "ENOENT") return null;
    throw error;
  }
}

async function clearStaleLocalLock(path: string): Promise<boolean> {
  const metadata = await readMetadata(path);
  if (!metadata) return false;
  if (metadata.hostname !== hostname() || processExists(metadata.pid)) return false;
  try {
    await unlink(path);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "ENOENT") return true;
    throw error;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Account lock acquisition aborted."));
      return;
    }
    const finish = (): void => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Account lock acquisition aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer.unref();
  });
}

async function writeLock(handle: FileHandle, metadata: LockMetadata): Promise<void> {
  await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
  await handle.sync();
}

export async function acquireAccountLock(
  accountId: string,
  options: AccountLockOptions = {}
): Promise<AccountLock> {
  const safeId = safeAccountSegment(accountId);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 250;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("timeoutMs must be positive.");
  if (!Number.isInteger(pollMs) || pollMs < 10) throw new Error("pollMs must be at least 10ms.");

  const runtime = await ensureRuntimeDirectory();
  const locksDirectory = join(runtime, "locks");
  await mkdir(locksDirectory, { recursive: true });
  const path = join(locksDirectory, `${safeId}.lock`);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    if (options.signal?.aborted) throw new Error("Account lock acquisition aborted.");
    try {
      const handle = await open(path, "wx", 0o600);
      const metadata: LockMetadata = {
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
          if (!current || current.pid !== process.pid || current.hostname !== hostname()) {
            throw new Error(`Account lock ownership changed before release: ${path}`);
          }
          await unlink(path);
        }
      };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (code !== "EEXIST") throw error;
      if (await clearStaleLocalLock(path)) continue;
      if (Date.now() >= deadline) {
        const owner = await readMetadata(path);
        throw new Error(
          `Timed out waiting for account lock ${safeId}. Owner: ${owner ? JSON.stringify(owner) : "unknown"}.`
        );
      }
      await delay(pollMs, options.signal);
    }
  }
}

export async function withAccountLock<T>(
  accountId: string,
  callback: () => Promise<T>,
  options: AccountLockOptions = {}
): Promise<T> {
  const lock = await acquireAccountLock(accountId, options);
  try {
    return await callback();
  } finally {
    await lock.release();
  }
}
