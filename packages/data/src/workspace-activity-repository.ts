import type { Database } from './client.js';
import { AuthorizationError, type SessionPrincipal } from './department-repository.js';

export const COMMUNICATION_LEASE_SECONDS = 45;

/** Short leases pause new browser work, never cancel or reset task progress. */
export class WorkspaceActivityRepository {
  constructor(private readonly sql: Database) {}

  async assertAccess(principal: SessionPrincipal, accountId: string): Promise<void> {
    if (!['admin', 'recruiting_lead', 'recruiter'].includes(principal.role)) {
      throw new AuthorizationError('没有切换工作模式的权限。');
    }
    const positions = await this.sql`
      SELECT p.id FROM positions p
      WHERE p.boss_account_id = ${accountId} AND p.department_id = ${principal.departmentId}
        AND (${principal.role} IN ('admin', 'recruiting_lead') OR EXISTS (
          SELECT 1 FROM position_members pm WHERE pm.position_id = p.id AND pm.user_id = ${principal.userId}
        )) LIMIT 1
    `;
    if (!positions.length) throw new AuthorizationError('没有此 BOSS 账号的岗位权限。');
  }

  async communicationActive(accountId: string): Promise<boolean> {
    return Boolean((await this.sql`
      SELECT id FROM communication_browser_leases
      WHERE boss_account_id = ${accountId} AND released_at IS NULL AND expires_at > now() LIMIT 1
    `)[0]);
  }

  async leaseActive(accountId: string, leaseId: string, userId?: string): Promise<boolean> {
    return Boolean((await this.sql`
      SELECT id FROM communication_browser_leases WHERE id = ${leaseId}::uuid
        AND boss_account_id = ${accountId} AND released_at IS NULL AND expires_at > now()
        AND (${userId ?? null}::uuid IS NULL OR user_id = ${userId ?? null}::uuid)
    `)[0]);
  }

  async update(principal: SessionPrincipal, accountId: string, leaseId: string, action: 'enter' | 'renew' | 'leave'): Promise<boolean> {
    await this.assertAccess(principal, accountId);
    if (action === 'enter' || action === 'leave') {
      await this.sql`
        INSERT INTO communication_browser_leases (id, boss_account_id, user_id, expires_at, released_at)
        VALUES (${leaseId}::uuid, ${accountId}, ${principal.userId},
          now() + ${COMMUNICATION_LEASE_SECONDS} * interval '1 second',
          CASE WHEN ${action} = 'leave' THEN now() ELSE NULL END)
        ON CONFLICT (id) DO NOTHING
      `;
    }
    const owner = (await this.sql`SELECT user_id, boss_account_id FROM communication_browser_leases WHERE id = ${leaseId}::uuid`)[0];
    if (owner && (owner.user_id !== principal.userId || owner.boss_account_id !== accountId)) {
      throw new AuthorizationError('不能更改其他页面的工作模式。');
    }
    if (action === 'leave') {
      await this.sql`UPDATE communication_browser_leases SET released_at = COALESCE(released_at, now()) WHERE id = ${leaseId}::uuid`;
    } else if (action === 'renew') {
      await this.sql`
        UPDATE communication_browser_leases SET expires_at = now() + ${COMMUNICATION_LEASE_SECONDS} * interval '1 second'
        WHERE id = ${leaseId}::uuid AND released_at IS NULL AND expires_at > now()
      `;
    }
    return this.leaseActive(accountId, leaseId, principal.userId);
  }
}
