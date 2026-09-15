type Entry = { value: unknown; updatedAt: number };
const entries = new Map<string, Entry>();
const pending = new Map<string, Promise<unknown>>();
let generation = 0;
function key(scope: string, path: string) {
  return JSON.stringify([scope, path]);
}

export function cachedRequest<T>(
  scope: string,
  path: string,
  maxAge = 30_000,
): T | null {
  const entry = entries.get(key(scope, path));
  return entry && Date.now() - entry.updatedAt <= maxAge
    ? (entry.value as T)
    : null;
}
export function clearRequestCache() {
  generation++;
  entries.clear();
  pending.clear();
}

/** Share only concurrent reads. A successful mutation invalidates both cached and in-flight snapshots. */
export function sharedRequest<T>(
  scope: string,
  path: string,
  fetcher: () => Promise<T>,
): Promise<T> {
  const cacheKey = key(scope, path);
  const existing = pending.get(cacheKey);
  if (existing) return existing as Promise<T>;
  const version = generation;
  const request = fetcher()
    .then((value) => {
      if (version === generation)
        entries.set(cacheKey, { value, updatedAt: Date.now() });
      return value;
    })
    .finally(() => {
      if (pending.get(cacheKey) === request) pending.delete(cacheKey);
    });
  pending.set(cacheKey, request);
  return request;
}
