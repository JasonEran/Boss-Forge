/** Share one account scan across tabs. Failed scans are never cached. */
export function createCommunicationSyncCache<T>(now = Date.now) {
  const scans = new Map<string, { promise: Promise<T>; expires: number }>();
  return (accountId: string, scan: () => Promise<T>): Promise<T> => {
    const current = scans.get(accountId);
    if (current && current.expires > now()) return current.promise;
    const entry = { promise: Promise.resolve().then(scan), expires: Infinity };
    scans.set(accountId, entry);
    void entry.promise.then(
      () => {
        entry.expires = now() + 2_000;
      },
      () => {
        if (scans.get(accountId) === entry) scans.delete(accountId);
      },
    );
    return entry.promise;
  };
}
