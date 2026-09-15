import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

export const CONTACT_GLOBAL_FENCE_FILE_NAME = "contact-global.fence";

type ContactGlobalFenceMetadata = {
  schemaVersion: 1;
  token: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
};

export type ContactGlobalFence = {
  path: string;
  release(): Promise<void>;
};

export type ContactGlobalFenceOptions = {
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
};

function runtimeDirectory(): string {
  const configured = process.env.BOSS_FORGE_RUNTIME_DIR?.trim();
  return resolve(configured || resolve(process.cwd(), ".boss-forge", "runtime"));
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, reject) => {
    if (signal?.aborted) {
      reject(new Error("Contact-global fence acquisition aborted."));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("Contact-global fence acquisition aborted."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, ms);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function writeMetadata(
  handle: FileHandle,
  metadata: ContactGlobalFenceMetadata
): Promise<void> {
  await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
  await handle.sync();
}

async function readMetadata(path: string): Promise<ContactGlobalFenceMetadata | null> {
  try {
    const parsed = JSON.parse(
      await readFile(path, "utf8")
    ) as Partial<ContactGlobalFenceMetadata>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.token !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.hostname !== "string" ||
      typeof parsed.acquiredAt !== "string"
    ) {
      return null;
    }
    return parsed as ContactGlobalFenceMetadata;
  } catch (error: unknown) {
    const code =
      error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "ENOENT") return null;
    throw error;
  }
}

export async function acquireContactGlobalFence(
  options: ContactGlobalFenceOptions = {}
): Promise<ContactGlobalFence> {
  const timeoutMs = options.timeoutMs ?? 70_000;
  const pollMs = options.pollMs ?? 100;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("timeoutMs must be positive.");
  }
  if (!Number.isInteger(pollMs) || pollMs < 10) {
    throw new Error("pollMs must be at least 10ms.");
  }
  const locksDirectory = join(runtimeDirectory(), "locks");
  await mkdir(locksDirectory, { recursive: true, mode: 0o700 });
  const path = join(locksDirectory, CONTACT_GLOBAL_FENCE_FILE_NAME);
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();

  while (true) {
    if (options.signal?.aborted) {
      throw new Error("Contact-global fence acquisition aborted.");
    }
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await writeMetadata(handle, {
          schemaVersion: 1,
          token,
          pid: process.pid,
          hostname: hostname(),
          acquiredAt: new Date().toISOString()
        });
      } finally {
        await handle.close();
      }
      let released = false;
      return {
        path,
        async release(): Promise<void> {
          if (released) return;
          const current = await readMetadata(path);
          if (!current || current.token !== token) {
            throw new Error(`Contact-global fence ownership changed before release: ${path}`);
          }
          await unlink(path);
          released = true;
        }
      };
    } catch (error: unknown) {
      const code =
        error && typeof error === "object" && "code" in error ? error.code : null;
      if (code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        const owner = await readMetadata(path);
        throw new Error(
          `Timed out waiting for the contact-global fence. Owner: ${
            owner ? JSON.stringify(owner) : "unknown"
          }. An administrator must first confirm that no contact Worker is running and no BOSS write is in progress, then remove the leftover fence file: ${path}.`
        );
      }
      await delay(pollMs, options.signal);
    }
  }
}

export async function withContactGlobalFence<T>(
  callback: () => Promise<T>,
  options: ContactGlobalFenceOptions = {}
): Promise<T> {
  const fence = await acquireContactGlobalFence(options);
  try {
    return await callback();
  } finally {
    await fence.release();
  }
}
