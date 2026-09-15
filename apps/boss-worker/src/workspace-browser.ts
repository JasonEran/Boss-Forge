import { acquireAccountLock } from './account-lock.js';
import { BossAccountLockTimeoutError } from '@boss-forge/boss-cli-adapter';
import type { WorkspaceActivityRepository } from '@boss-forge/data';

/** Only immutable, saved evidence may be processed after releaseBrowser(). */
export async function withScreeningBrowser(
  accountId: string,
  activity: Pick<WorkspaceActivityRepository, 'communicationActive'>,
  operation: (releaseBrowser: () => Promise<void>) => Promise<boolean>,
): Promise<boolean> {
  if (await activity.communicationActive(accountId)) return false;
  let lock;
  try {
    lock = await acquireAccountLock(accountId, { timeoutMs: 1, pollMs: 10 });
  } catch (error) {
    // A busy browser is normal scheduling contention, not a failed task.
    if (error instanceof BossAccountLockTimeoutError) return false;
    throw error;
  }
  // The resume pipeline can release as soon as its screenshot is durable while
  // this wrapper still owns the callback. Reuse that promise in finally so a
  // second release cannot race the unlink or hide an ownership failure.
  let releasePromise: Promise<void> | null = null;
  const releaseBrowser = () => {
    releasePromise ??= lock.release();
    return releasePromise;
  };
  try {
    if (await activity.communicationActive(accountId)) return false;
    return await operation(releaseBrowser);
  } finally {
    await releaseBrowser();
  }
}
