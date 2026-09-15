/** Report an accepted, unconsumed refresh as pending rather than replaying the
 * previous error while the relay is waking up. Never mask risk or offline state. */
export function loginRefreshPending(state: string, updatedAt: string, request: unknown, now = Date.now()): boolean {
  if (state !== 'error' || !request || typeof request !== 'object') return false;
  const r = request as Record<string, unknown>;
  if (typeof r.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(r.requestId) || typeof r.requestedAt !== 'string') return false;
  const requested = Date.parse(r.requestedAt), heartbeat = Date.parse(updatedAt);
  return Number.isFinite(requested) && Number.isFinite(heartbeat) &&
    now >= requested && now - requested < 30_000 && now - heartbeat < 20_000;
}
