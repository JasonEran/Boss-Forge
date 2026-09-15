import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { SessionPrincipal, WorkspaceActivityRepository } from '@boss-forge/data';
import { workspaceActivityRoutes } from './workspace-activity-routes.js';

describe('workspace activity handoff API', () => {
  async function scenario(action: string, idle: boolean, expiresDuringProbe = false) {
    let active = false, status = 0, body: unknown;
    const update = vi.fn(async () => { active = action !== 'leave'; return active; });
    const browserIdle = vi.fn(async () => {
      expect(active).toBe(true); // Pause is committed before waiting for browser ownership.
      if (expiresDuringProbe) active = false;
      return idle;
    });
    const repository = {
      assertAccess: async () => {}, update,
      communicationActive: async () => active, leaseActive: async () => active,
    } as unknown as WorkspaceActivityRepository;
    await workspaceActivityRoutes({
      request: { method: 'POST' } as IncomingMessage, response: {} as ServerResponse,
      url: new URL('http://localhost/api/workspace/activity'), principal: {} as SessionPrincipal,
      repository, accountId: 'account-test', browserIdle,
      readJson: async () => ({ action, leaseId: randomUUID() }),
      send: (_response, value, result) => { status = value; body = result; },
    });
    return { status, body, update, browserIdle };
  }
  it('pauses new claims while acknowledging that the current operation is finishing', async () => {
    expect((await scenario('enter', false)).body).toMatchObject({ active: true, ready: false, screeningPaused: true });
    expect((await scenario('renew', true)).body).toMatchObject({ active: true, ready: true, screeningPaused: true });
  });
  it('does not resume an expired lease when the browser finally becomes available', async () => {
    expect((await scenario('renew', true, true)).body).toMatchObject({ ready: false, screeningPaused: false });
  });
  it('releases without waiting for a running chat to finish', async () => {
    const result = await scenario('leave', false);
    expect(result.body).toMatchObject({ active: false, ready: false, screeningPaused: false });
    expect(result.browserIdle).not.toHaveBeenCalled();
  });
  it('rejects invalid mode requests before changing the lease', async () => {
    const result = await scenario('send', true);
    expect(result.status).toBe(400);
    expect(result.update).not.toHaveBeenCalled();
  });
});
