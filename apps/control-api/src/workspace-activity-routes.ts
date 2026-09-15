import type { IncomingMessage, ServerResponse } from 'node:http';
import { BossAccountLockTimeoutError, withBossAccountLock } from '@boss-forge/boss-cli-adapter';
import type { SessionPrincipal, WorkspaceActivityRepository } from '@boss-forge/data';

export async function workspaceActivityRoutes(input: {
  request: IncomingMessage; response: ServerResponse; url: URL; principal: SessionPrincipal;
  repository: WorkspaceActivityRepository; accountId: string;
  readJson(request: IncomingMessage): Promise<Record<string, unknown>>;
  send(response: ServerResponse, status: number, body: unknown): void;
  browserIdle?: () => Promise<boolean>;
}): Promise<boolean> {
  if (input.url.pathname !== '/api/workspace/activity') return false;
  const { request, response, principal, repository, accountId, send } = input;
  await repository.assertAccess(principal, accountId);
  if (request.method === 'GET') {
    send(response, 200, { screeningPaused: await repository.communicationActive(accountId) });
    return true;
  }
  if (request.method !== 'POST') { send(response, 405, { message: '不支持此操作。' }); return true; }
  const body = await input.readJson(request);
  if (typeof body.leaseId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(body.leaseId) ||
      !['enter', 'renew', 'leave'].includes(String(body.action))) {
    send(response, 400, { message: '工作模式请求无效。' }); return true;
  }
  const active = await repository.update(principal, accountId, body.leaseId, body.action as 'enter' | 'renew' | 'leave');
  // A mode request takes effect before waiting for the current resume. This
  // nonblocking probe acknowledges handoff only after its browser lock exits.
  const idle = input.browserIdle ?? (async () => {
    try { return await withBossAccountLock(accountId, async () => true, { timeoutMs: 1, pollMs: 10 }); }
    catch (error) { if (error instanceof BossAccountLockTimeoutError) return false; throw error; }
  });
  const ready = active && await idle() && await repository.leaseActive(accountId, body.leaseId, principal.userId);
  send(response, 200, { active, ready, screeningPaused: await repository.communicationActive(accountId), leaseSeconds: 45 });
  return true;
}
