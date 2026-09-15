import { withAccountLock } from './account-lock.js';
import type { WorkspaceActivityRepository } from '@boss-forge/data';

/** Check again under the browser lock before claiming any database job. */
export async function withScreeningBrowser(
  accountId: string,
  activity: Pick<WorkspaceActivityRepository, 'communicationActive'>,
  operation: () => Promise<boolean>,
): Promise<boolean> {
  if (await activity.communicationActive(accountId)) return false;
  return withAccountLock(accountId, async () => {
    if (await activity.communicationActive(accountId)) return false;
    return operation();
  });
}
