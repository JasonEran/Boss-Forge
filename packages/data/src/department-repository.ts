import { parseRuleConfig } from "./rule-config.js";
import { contactWindowFromPolicy } from "./contact-window.js";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import {
  bossJobCatalogSchema,
  bossJobAvailability,
  type BossJobCatalog,
  REAL_CONTACT_TRANSPORT_AVAILABLE,
  contactDispatchModeFromEnvironment,
  contactSideEffectsModeFromEnvironment,
  SEMANTIC_ACTIVE_DECISIONS_AVAILABLE
} from "@boss-forge/contracts";
import type { Database } from "./client.js";
import { assertIsolatedTestDatabase } from "./test-safety.js";
import type { Position } from "./types.js";

type JsonValue = Parameters<Database["json"]>[0];

export type DepartmentRole = "admin" | "recruiting_lead" | "recruiter" | "interviewer";
export type SessionPrincipal = {
  userId: string;
  departmentId: string;
  email: string;
  displayName: string;
  role: DepartmentRole;
};

export class AuthenticationError extends Error {}
export class AuthorizationError extends Error {}

const tokenHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const passwordHash = (value: string, salt: string): string =>
  scryptSync(value, salt, 64).toString("hex");

function contactAuthorizationMutationAllowed(): boolean {
  if (REAL_CONTACT_TRANSPORT_AVAILABLE) return true;
  if (
    process.env.BOSS_FORGE_TEST_CONTACTS !== "1" ||
    process.env.BOSS_FORGE_ALLOW_CONTACT_TEST_DATA !==
      "I_UNDERSTAND_ISOLATED_ONLY"
  ) {
    return false;
  }
  assertIsolatedTestDatabase(process.env, { contactSideEffects: true });
  return true;
}
const canManage = (role: DepartmentRole): boolean =>
  role === "admin" || role === "recruiting_lead";

function validPassword(value: string): void {
  if (value.length < 12 || value.length > 200) {
    throw new Error("password must contain 12 to 200 characters.");
  }
}

export class DepartmentAtsRepository {
  constructor(private readonly sql: Database) {}

  async ensureBootstrap(input: {
    departmentName: string;
    adminEmail: string;
    adminName: string;
    password: string;
  }): Promise<void> {
    validPassword(input.password);
    if ((await this.sql`SELECT id FROM users LIMIT 1`)[0]) return;
    const departmentId = randomUUID();
    const userId = randomUUID();
    const salt = randomBytes(24).toString("hex");
    const stages = [
      ["screening", "筛选中"], ["review", "待审核"], ["approved", "已通过"],
      ["contact", "待联系"], ["communicating", "沟通中"], ["interview", "面试"],
      ["offer", "Offer"], ["hired", "已入职"], ["rejected", "已淘汰"]
    ] as const;
    await this.sql.begin(async (tx) => {
      await tx`INSERT INTO departments (id, slug, name) VALUES (${departmentId}, 'default', ${input.departmentName})`;
      await tx`
        INSERT INTO users (id, department_id, email, display_name, role, password_salt, password_hash)
        VALUES (${userId}, ${departmentId}, ${input.adminEmail.toLowerCase()}, ${input.adminName},
          'admin', ${salt}, ${passwordHash(input.password, salt)})
      `;
      for (let index = 0; index < stages.length; index += 1) {
        const [key, label] = stages[index]!;
        await tx`
          INSERT INTO pipeline_stages (id, department_id, stage_key, label, stage_order, terminal)
          VALUES (${randomUUID()}, ${departmentId}, ${key}, ${label}, ${(index + 1) * 10},
            ${key === "hired" || key === "rejected"})
        `;
      }
      await tx`UPDATE positions SET department_id = ${departmentId}, owner_user_id = ${userId} WHERE department_id IS NULL`;
      await tx`
        INSERT INTO position_members (position_id, user_id, member_role)
        SELECT id, ${userId}, 'owner' FROM positions ON CONFLICT DO NOTHING
      `;
      await tx`
        INSERT INTO contact_controls (id, scope_type, scope_id, enabled, approval_required, updated_by)
        VALUES (${randomUUID()}, 'global', 'global', false, true, ${userId}) ON CONFLICT DO NOTHING
      `;
    });
  }

  async login(email: string, password: string): Promise<{
    token: string;
    expiresAt: string;
    principal: SessionPrincipal;
  }> {
    const users = await this.sql<Array<{
      id: string; department_id: string; email: string; display_name: string;
      role: DepartmentRole; password_salt: string | null; password_hash: string | null;
    }>>`
      SELECT id, department_id, email, display_name, role, password_salt, password_hash
      FROM users WHERE lower(email) = lower(${email}) AND status = 'active'
    `;
    if (users.length !== 1) {
      throw new AuthenticationError("Invalid email or password.");
    }
    const user = users[0];
    if (!user?.password_salt || !user.password_hash) {
      throw new AuthenticationError("Invalid email or password.");
    }
    const supplied = Buffer.from(passwordHash(password, user.password_salt), "hex");
    const expected = Buffer.from(user.password_hash, "hex");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new AuthenticationError("Invalid email or password.");
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1_000).toISOString();
    await this.sql`
      INSERT INTO user_sessions (id, user_id, token_hash, expires_at)
      VALUES (${randomUUID()}, ${user.id}, ${tokenHash(token)}, ${expiresAt})
    `;
    return {
      token,
      expiresAt,
      principal: {
        userId: user.id,
        departmentId: user.department_id,
        email: user.email,
        displayName: user.display_name,
        role: user.role
      }
    };
  }

  async authenticate(token: string): Promise<SessionPrincipal> {
    const rows = await this.sql<Array<{
      session_id: string; user_id: string; department_id: string; email: string;
      display_name: string; role: DepartmentRole;
    }>>`
      SELECT s.id AS session_id, u.id AS user_id, u.department_id, u.email, u.display_name, u.role
      FROM user_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ${tokenHash(token)} AND s.revoked_at IS NULL
        AND s.expires_at > now() AND u.status = 'active'
    `;
    const row = rows[0];
    if (!row) throw new AuthenticationError("Invalid or expired session.");
    await this.sql`UPDATE user_sessions SET last_seen_at = now() WHERE id = ${row.session_id}`;
    return {
      userId: row.user_id,
      departmentId: row.department_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role
    };
  }

  async logout(token: string): Promise<void> {
    await this.sql`UPDATE user_sessions SET revoked_at = now() WHERE token_hash = ${tokenHash(token)}`;
  }

  async listUsers(principal: SessionPrincipal): Promise<readonly unknown[]> {
    return this.sql`
      SELECT id, email, display_name AS "displayName", role, status, created_at AS "createdAt"
      FROM users WHERE department_id = ${principal.departmentId} ORDER BY display_name
    `;
  }

  async createUser(principal: SessionPrincipal, input: {
    email: string;
    displayName: string;
    role: DepartmentRole;
    password: string;
  }): Promise<unknown> {
    if (!canManage(principal.role)) throw new AuthorizationError("Manager role required.");
    validPassword(input.password);
    const id = randomUUID();
    const salt = randomBytes(24).toString("hex");
    const normalizedEmail = input.email.trim().toLowerCase();
    return this.sql.begin(async (tx) => {
      await tx`
        SELECT pg_advisory_xact_lock(hashtextextended(${normalizedEmail}::text, 0))
      `;
      if ((await tx`SELECT id FROM users WHERE lower(email) = ${normalizedEmail} LIMIT 1`)[0]) {
        throw new Error("This email is already used by another account.");
      }
      const rows = await tx`
        INSERT INTO users (id, department_id, email, display_name, role, password_salt, password_hash)
        VALUES (${id}, ${principal.departmentId}, ${normalizedEmail}, ${input.displayName},
          ${input.role}, ${salt}, ${passwordHash(input.password, salt)})
        RETURNING id, email, display_name AS "displayName", role, status
      `;
      return rows[0];
    });
  }

  async positionIds(principal: SessionPrincipal): Promise<string[]> {
    const rows = canManage(principal.role)
      ? await this.sql<Array<{ id: string }>>`
          SELECT id FROM positions WHERE department_id = ${principal.departmentId}
        `
      : await this.sql<Array<{ id: string }>>`
          SELECT p.id FROM positions p JOIN position_members pm ON pm.position_id = p.id
          WHERE p.department_id = ${principal.departmentId} AND pm.user_id = ${principal.userId}
        `;
    return rows.map((row) => row.id);
  }

  async assertPosition(principal: SessionPrincipal, positionId: string): Promise<void> {
    if (!(await this.positionIds(principal)).includes(positionId)) {
      throw new AuthorizationError("Position access denied.");
    }
  }

  async adoptPosition(principal: SessionPrincipal, positionId: string): Promise<void> {
    if (!canManage(principal.role)) throw new AuthorizationError("Manager role required.");
    await this.sql.begin(async (tx) => {
      const adopted = await tx<Array<{ id: string }>>`
        UPDATE positions SET department_id = ${principal.departmentId}, owner_user_id = ${principal.userId}
        WHERE id = ${positionId} AND (department_id IS NULL OR department_id = ${principal.departmentId})
        RETURNING id
      `;
      if (!adopted[0]) throw new AuthorizationError("Position adoption was denied.");
      await tx`
        INSERT INTO position_members (position_id, user_id, member_role)
        VALUES (${positionId}, ${principal.userId}, 'owner')
        ON CONFLICT (position_id, user_id) DO UPDATE SET member_role = 'owner'
      `;
    });
  }

  /**
   * Create (or update the same-department match) and assign a position as one
   * transaction.  This is the safe write path for the HTTP create endpoint: a
   * membership failure can no longer leave a globally visible orphan position.
   */
  async createAssignedPosition(principal: SessionPrincipal, input: {
    bossAccountId: string;
    name: string;
    bossJobKeyword?: string | null;
    ownerName?: string;
  }): Promise<Position> {
    if (!canManage(principal.role)) throw new AuthorizationError("Manager role required.");
    const bossAccountId = input.bossAccountId.trim();
    const name = input.name.trim();
    const bossJobKeyword = input.bossJobKeyword?.trim() || null;
    const ownerName = input.ownerName?.trim() || principal.displayName;
    if (!bossAccountId || bossAccountId.length > 200) {
      throw new Error("BOSS account id must contain 1 to 200 characters.");
    }
    if (!name || name.length > 100) {
      throw new Error("Position name must contain 1 to 100 characters.");
    }
    if (bossJobKeyword && bossJobKeyword.length > 120) {
      throw new Error("BOSS job keyword must contain at most 120 characters.");
    }
    if (!ownerName || ownerName.length > 100) {
      throw new Error("Owner name must contain 1 to 100 characters.");
    }
    return this.sql.begin(async (tx) => {
      await tx`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`${bossAccountId}\u001f${name.toLocaleLowerCase("zh-CN")}`}::text, 0)
        )
      `;
      const existing = await tx<Array<{ id: string; department_id: string | null }>>`
        SELECT id, department_id
        FROM positions
        WHERE boss_account_id = ${bossAccountId} AND lower(name) = lower(${name}) AND boss_job_id IS NULL
        FOR UPDATE
      `;
      if (existing[0]?.department_id && existing[0].department_id !== principal.departmentId) {
        throw new AuthorizationError("A position with this name belongs to another department.");
      }
      const positionId = existing[0]?.id ?? randomUUID();
      const rows = await tx<
        Array<{
          id: string;
          boss_account_id: string;
          name: string;
          boss_job_keyword: string | null;
          status: Position["status"];
          owner_name: string;
          semantic_mode: Position["semanticMode"];
          version: number;
          created_at: Date;
          updated_at: Date;
        }>
      >`
        INSERT INTO positions (
          id, boss_account_id, name, boss_job_keyword, owner_name,
          department_id, owner_user_id
        ) VALUES (
          ${positionId}, ${bossAccountId}, ${name}, ${bossJobKeyword}, ${ownerName},
          ${principal.departmentId}, ${principal.userId}
        )
        ON CONFLICT (id) DO UPDATE SET
          boss_job_keyword = EXCLUDED.boss_job_keyword,
          owner_name = EXCLUDED.owner_name,
          department_id = EXCLUDED.department_id,
          owner_user_id = EXCLUDED.owner_user_id,
          version = positions.version + 1,
          updated_at = now()
        RETURNING id, boss_account_id, name, boss_job_keyword, status,
          owner_name, semantic_mode, version, created_at, updated_at
      `;
      await tx`
        INSERT INTO position_members (position_id, user_id, member_role)
        VALUES (${positionId}, ${principal.userId}, 'owner')
        ON CONFLICT (position_id, user_id) DO UPDATE SET member_role = 'owner'
      `;
      await tx`
        INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
        VALUES (
          ${randomUUID()}, ${principal.userId},
          ${existing[0] ? "position.updated_and_assigned" : "position.created_and_assigned"},
          'position', ${positionId},
          ${tx.json({ departmentId: principal.departmentId, bossAccountId })}
        )
      `;
      const row = rows[0]!;
      return {
        id: row.id,
        bossAccountId: row.boss_account_id,
        name: row.name,
        bossJobKeyword: row.boss_job_keyword,
        status: row.status,
        ownerName: row.owner_name,
        semanticMode: row.semantic_mode,
        version: row.version,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString()
      };
    });
  }

  async syncBossPositions(principal: SessionPrincipal, bossAccountId: string, input: BossJobCatalog) {
    if (!canManage(principal.role)) throw new AuthorizationError("Manager role required.");
    const catalog = bossJobCatalogSchema.parse(input);
    // A partial page must never mark jobs as closed or replace the user's list.
    if (!catalog.complete) throw new Error("BOSS 岗位列表尚未完整读取，原有岗位未更改，请稍后重新同步。");
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`boss-jobs:${bossAccountId}`}::text, 0))`;
      const existing = await tx<Array<{ id: string; name: string; boss_job_id: string | null; department_id: string | null }>>`
        SELECT id, name, boss_job_id, department_id FROM positions
        WHERE boss_account_id = ${bossAccountId} FOR UPDATE
      `;
      let created = 0;
      let linked = 0;
      let synced = 0;
      const norm = (name: string) => name.replace(/\s+/gu, "").toLocaleLowerCase("zh-CN");
      for (const job of catalog.jobs) {
        let current = existing.find((position) => position.boss_job_id === job.id);
        // Import open jobs only. Retain and update already-bound jobs when BOSS
        // closes them so their rules, assignments and screening history survive.
        if (!current && bossJobAvailability(job.status) !== "active") continue;
        if (current?.department_id && current.department_id !== principal.departmentId) {
          throw new AuthorizationError("该 BOSS 岗位已归属于其他部门，请由原部门管理员同步。");
        }
        if (!current) {
          const legacy = existing.filter((position) => !position.boss_job_id &&
            position.department_id === principal.departmentId && norm(position.name) === norm(job.name));
          if (legacy.length === 1 && catalog.jobs.filter((other) => norm(other.name) === norm(job.name)).length === 1) {
            current = legacy[0];
            linked++;
          }
        }
        const nameUnique = catalog.jobs.filter((other) => norm(other.name) === norm(job.name)).length === 1;
        const id = current?.id ?? randomUUID();
        synced++;
        if (!current) created++;
        if (current) {
          await tx`UPDATE positions SET name = ${job.name}, boss_job_keyword = ${job.name},
            boss_job_id = ${job.id}, boss_job_name_unique = ${nameUnique}, boss_job_status = ${job.status},
            status = ${bossJobAvailability(job.status)}, boss_synced_at = now(),
            version = version + 1, updated_at = now()
            WHERE id = ${id}`;
          current.boss_job_id = job.id;
        } else {
          await tx`INSERT INTO positions (id, boss_account_id, name, boss_job_keyword,
            boss_job_id, boss_job_name_unique, boss_job_status, boss_synced_at, status, owner_name, department_id, owner_user_id)
            VALUES (${id}, ${bossAccountId}, ${job.name}, ${job.name}, ${job.id}, ${nameUnique}, ${job.status}, now(),
              ${bossJobAvailability(job.status)}, ${principal.displayName}, ${principal.departmentId}, ${principal.userId})`;
          await tx`INSERT INTO position_members (position_id, user_id, member_role)
            VALUES (${id}, ${principal.userId}, 'owner')`;
        }
      }
      const ids = catalog.jobs.map((job) => job.id);
      await tx`UPDATE positions SET status = 'paused', boss_job_status = '本次同步未找到',
        boss_synced_at = now(), version = version + 1, updated_at = now()
        WHERE boss_account_id = ${bossAccountId} AND department_id = ${principal.departmentId}
          AND boss_job_id IS NOT NULL AND NOT (boss_job_id = ANY(${ids}::text[]))`;
      await tx`INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
        VALUES (${randomUUID()}, ${principal.userId}, 'position.boss_synced', 'boss_account', ${bossAccountId},
          ${tx.json({ count: synced, catalogCount: ids.length, created, linked })})`;
      return { count: synced, created, linked };
    });
  }

  /** Move a fresh imported BOSS binding onto a legacy position, keeping all its history. */
  async bindLegacyBossPosition(principal: SessionPrincipal, positionId: string, importedPositionId: string) {
    if (!canManage(principal.role)) throw new AuthorizationError("Manager role required.");
    await this.assertPosition(principal, positionId);
    await this.assertPosition(principal, importedPositionId);
    return this.sql.begin(async (tx) => {
      const rows = await tx`SELECT * FROM positions WHERE id IN (${positionId}, ${importedPositionId}) ORDER BY id FOR UPDATE`;
      const legacy = rows.find((row) => row.id === positionId);
      const imported = rows.find((row) => row.id === importedPositionId);
      if (!legacy || !imported || legacy.boss_job_id || !imported.boss_job_id || legacy.boss_account_id !== imported.boss_account_id) {
        throw new Error("请选择同一 BOSS 账号下的已同步岗位；已绑定岗位不能更换来源。");
      }
      const used = await tx`SELECT id FROM rule_sets WHERE position_id = ${importedPositionId}
        UNION ALL SELECT id FROM tasks WHERE position_id = ${importedPositionId}
        UNION ALL SELECT id FROM schedules WHERE position_id = ${importedPositionId}
        UNION ALL SELECT id FROM message_templates WHERE position_id = ${importedPositionId}
        UNION ALL SELECT id FROM work_items WHERE position_id = ${importedPositionId}
        UNION ALL SELECT id FROM rule_replay_runs WHERE position_id = ${importedPositionId}
        UNION ALL SELECT id FROM contact_policy_snapshots WHERE position_id = ${importedPositionId} LIMIT 1`;
      if (used.length) throw new Error("所选 BOSS 岗位已有规则、任务或其他配置，请直接使用该岗位，避免混合历史数据。");
      // Keep any HR assignments made immediately after import.
      await tx`INSERT INTO position_members (position_id, user_id, member_role)
        SELECT ${positionId}, user_id, member_role FROM position_members WHERE position_id = ${importedPositionId}
        ON CONFLICT (position_id, user_id) DO NOTHING`;
      await tx`DELETE FROM position_members WHERE position_id = ${importedPositionId}`;
      await tx`DELETE FROM positions WHERE id = ${importedPositionId}`;
      await tx`UPDATE positions SET name = ${imported.name}, boss_job_keyword = ${imported.boss_job_keyword},
        boss_job_id = ${imported.boss_job_id}, boss_job_name_unique = ${imported.boss_job_name_unique}, boss_job_status = ${imported.boss_job_status},
        boss_synced_at = ${imported.boss_synced_at}, status = ${imported.status},
        version = version + 1, updated_at = now() WHERE id = ${positionId}`;
      await tx`INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
        VALUES (${randomUUID()}, ${principal.userId}, 'position.boss_bound', 'position', ${positionId},
          ${tx.json({ bossJobId: imported.boss_job_id, importedPositionId })})`;
      return { positionId };
    });
  }

  async updatePosition(principal: SessionPrincipal, positionId: string, input: {
    name: string;
    bossJobKeyword?: string | null;
    ownerName: string;
  }): Promise<unknown> {
    if (!canManage(principal.role)) throw new AuthorizationError("Manager role required.");
    await this.assertPosition(principal, positionId);
    const name = input.name.trim();
    const ownerName = input.ownerName.trim();
    const bossJobKeyword = input.bossJobKeyword?.trim() || null;
    if (name.length > 100) throw new Error("Position name must contain at most 100 characters.");
    if (ownerName.length > 100) throw new Error("Owner name must contain at most 100 characters.");
    if (bossJobKeyword && bossJobKeyword.length > 120) {
      throw new Error("BOSS job keyword must contain at most 120 characters.");
    }
    const duplicate = (await this.sql`
      SELECT other.id FROM positions current_position
      JOIN positions other ON other.boss_account_id = current_position.boss_account_id
        AND lower(other.name) = lower(${name}) AND other.id <> current_position.id
        AND other.boss_job_id IS NULL AND current_position.boss_job_id IS NULL
      WHERE current_position.id = ${positionId} LIMIT 1
    `)[0];
    if (duplicate) throw new Error("Position name must be unique for this BOSS account.");
    const rows = await this.sql`
      UPDATE positions SET
        name = CASE WHEN boss_job_id IS NULL THEN ${name} ELSE name END,
        boss_job_keyword = CASE WHEN boss_job_id IS NULL THEN ${bossJobKeyword} ELSE boss_job_keyword END,
        owner_name = ${ownerName}, version = version + 1, updated_at = now()
      WHERE id = ${positionId} AND department_id = ${principal.departmentId}
      RETURNING id, boss_account_id AS "bossAccountId", name,
        boss_job_keyword AS "bossJobKeyword", status, owner_name AS "ownerName",
        version, created_at AS "createdAt", updated_at AS "updatedAt"
    `;
    if (!rows[0]) throw new Error("Position was not found.");
    await this.audit(principal, "position.updated", "position", positionId, {
      name,
      bossJobKeyword,
      ownerName
    });
    return rows[0];
  }

  async assignPosition(
    principal: SessionPrincipal,
    positionId: string,
    userId: string,
    memberRole: "owner" | "recruiter" | "interviewer" | "viewer"
  ): Promise<void> {
    if (!canManage(principal.role)) throw new AuthorizationError("Manager role required.");
    await this.assertPosition(principal, positionId);
    if (!(await this.sql`SELECT id FROM users WHERE id = ${userId} AND department_id = ${principal.departmentId}`)[0]) {
      throw new Error("User was not found in this department.");
    }
    await this.sql`
      INSERT INTO position_members (position_id, user_id, member_role)
      VALUES (${positionId}, ${userId}, ${memberRole})
      ON CONFLICT (position_id, user_id) DO UPDATE SET member_role = EXCLUDED.member_role
    `;
  }

  async listPipeline(principal: SessionPrincipal, input: {
    positionId?: string;
    stage?: string;
    query?: string;
    sort?: "updated" | "name";
    direction?: "asc" | "desc";
    limit?: number;
    offset?: number;
  }): Promise<{ items: unknown[]; total: number }> {
    const allowed = await this.positionIds(principal);
    if (input.positionId && !allowed.includes(input.positionId)) {
      throw new AuthorizationError("Position access denied.");
    }
    const ids = input.positionId ? [input.positionId] : allowed;
    if (ids.length === 0) return { items: [], total: 0 };
    const stage = input.stage ?? null;
    const query = input.query?.trim() ? `%${input.query.trim()}%` : null;
    const sort = input.sort ?? "updated";
    const direction = input.direction ?? "desc";
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const offset = Math.max(input.offset ?? 0, 0);
    const counts = await this.sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM candidate_position_states cps JOIN candidates c ON c.id = cps.candidate_id
      WHERE cps.is_current AND cps.position_id = ANY(${ids}::uuid[])
        AND (${stage}::text IS NULL OR cps.stage_key = ${stage})
        AND (${query}::text IS NULL OR c.display_name ILIKE ${query})
    `;
    const items = await this.sql`
      SELECT cps.id AS "stateId", cps.candidate_id AS "candidateId", c.display_name AS name,
        p.id AS "positionId", p.name AS "positionName", cps.stage_key AS stage,
        cps.review_status AS "reviewStatus", cps.contact_status AS "contactStatus",
        cps.rule_decision AS "ruleDecision", cps.updated_at AS "updatedAt",
        cps.resume_screening_status AS "resumeScreeningStatus",
        cps.resume_screening_error_code AS "resumeScreeningErrorCode",
        COALESCE(dnc.active, false) AS "doNotContact"
      FROM candidate_position_states cps JOIN candidates c ON c.id = cps.candidate_id
      JOIN positions p ON p.id = cps.position_id
      LEFT JOIN do_not_contact dnc ON dnc.candidate_id = c.id
      WHERE cps.is_current AND cps.position_id = ANY(${ids}::uuid[])
        AND (${stage}::text IS NULL OR cps.stage_key = ${stage})
        AND (${query}::text IS NULL OR c.display_name ILIKE ${query})
      ORDER BY
        CASE WHEN ${sort} = 'name' AND ${direction} = 'asc' THEN c.display_name END ASC,
        CASE WHEN ${sort} = 'name' AND ${direction} = 'desc' THEN c.display_name END DESC,
        CASE WHEN ${sort} = 'updated' AND ${direction} = 'asc' THEN cps.stage_updated_at END ASC,
        CASE WHEN ${sort} = 'updated' AND ${direction} = 'desc' THEN cps.stage_updated_at END DESC,
        cps.id
      LIMIT ${limit} OFFSET ${offset}
    `;
    return { items, total: counts[0]?.count ?? 0 };
  }

  async moveStage(
    principal: SessionPrincipal,
    stateId: string,
    stage: string,
    rejectionReason?: string | null
  ): Promise<void> {
    if (principal.role === "interviewer") {
      throw new AuthorizationError("Interviewers cannot change pipeline stages.");
    }
    const state = (await this.sql<Array<{
      position_id: string;
      stage_key: string;
      review_status: string;
    }>>`
      SELECT position_id, stage_key, review_status
      FROM candidate_position_states WHERE id = ${stateId}
    `)[0];
    if (!state) throw new Error("Candidate state was not found.");
    await this.assertPosition(principal, state.position_id);
    if ((await this.sql`SELECT c.id FROM recruitment_cases c JOIN candidate_position_states s ON s.candidate_id=c.candidate_id AND s.position_id=c.position_id WHERE s.id=${stateId} LIMIT 1`)[0]) {
      throw new Error("此候选人已有招聘跟进档案，请在招聘跟进中更新面试、Offer 或入职状态。");
    }
    if (!(await this.sql`
      SELECT id FROM pipeline_stages
      WHERE department_id = ${principal.departmentId} AND stage_key = ${stage}
    `)[0]) throw new Error("Pipeline stage was not found.");
    if (state.review_status === "rejected" && stage !== "rejected") {
      throw new Error("A screening-rejected candidate cannot move to another pipeline stage.");
    }
    if (
      state.review_status === "pending" &&
      !["screening", "review"].includes(stage)
    ) {
      throw new Error("Candidate screening review must be approved before moving forward.");
    }
    await this.sql.begin(async (tx) => {
      await tx`
        UPDATE candidate_position_states SET stage_key = ${stage}, stage_updated_at = now(),
          rejection_reason = ${rejectionReason ?? null}, updated_at = now(), version = version + 1
        WHERE id = ${stateId}
      `;
      await tx`
        INSERT INTO candidate_activities
          (id, candidate_position_state_id, actor_user_id, activity_type, summary, payload)
        VALUES (${randomUUID()}, ${stateId}, ${principal.userId}, 'stage_changed',
          ${`阶段从 ${state.stage_key} 更新为 ${stage}`}, ${tx.json({ from: state.stage_key, to: stage })})
      `;
    });
  }

  async addNote(
    principal: SessionPrincipal,
    stateId: string,
    body: string,
    mentionedUserIds: string[]
  ): Promise<unknown> {
    const state = (await this.sql<Array<{ position_id: string }>>`
      SELECT position_id FROM candidate_position_states WHERE id = ${stateId}
    `)[0];
    if (!state) throw new Error("Candidate state was not found.");
    await this.assertPosition(principal, state.position_id);
    const rows = await this.sql`
      INSERT INTO candidate_notes
        (id, candidate_position_state_id, author_user_id, body, mentioned_user_ids)
      VALUES (${randomUUID()}, ${stateId}, ${principal.userId}, ${body}, ${this.sql.json(mentionedUserIds)})
      RETURNING id, body, created_at AS "createdAt"
    `;
    return rows[0];
  }

  async setDoNotContact(
    principal: SessionPrincipal,
    candidateId: string,
    active: boolean,
    reason: string
  ): Promise<void> {
    if (principal.role === "interviewer") {
      throw new AuthorizationError("Interviewers cannot change contact safety controls.");
    }
    const allowed = await this.positionIds(principal);
    const state = (await this.sql<Array<{ position_id: string }>>`
      SELECT position_id FROM candidate_position_states
      WHERE candidate_id = ${candidateId} AND position_id = ANY(${allowed}::uuid[]) LIMIT 1
    `)[0];
    if (!state) throw new AuthorizationError("Candidate access denied.");
    await this.sql.begin(async (tx) => {
      await tx`
        SELECT pg_advisory_xact_lock(hashtextextended(${candidateId}::text, 0))
      `;
      await tx`
        INSERT INTO do_not_contact (candidate_id, reason, source, created_by, active)
        VALUES (${candidateId}, ${reason}, 'hr', ${principal.userId}, ${active})
        ON CONFLICT (candidate_id) DO UPDATE SET reason = EXCLUDED.reason,
          active = EXCLUDED.active, created_by = EXCLUDED.created_by, updated_at = now()
      `;
    });
  }

  async assertCandidateContactable(principal: SessionPrincipal, stateId: string): Promise<void> {
    const state = await this.assertState(principal, stateId);
    const currentState = (await this.sql`
      SELECT id FROM candidate_position_states
      WHERE id = ${stateId} AND is_current = true
    `)[0];
    if (!currentState) {
      throw new Error(
        "Contact policy blocked: candidate state is historical; select the current record."
      );
    }
    if ((await this.sql`
      SELECT candidate_id FROM do_not_contact
      WHERE candidate_id = ${state.candidateId} AND active = true
    `)[0]) throw new Error("Contact policy blocked: candidate is Do-Not-Contact.");
  }

  async messageTemplateWorkspace(principal: SessionPrincipal): Promise<unknown> {
    const ids = await this.positionIds(principal);
    if (ids.length === 0) return { templates: [] };
    const templates = await this.sql`
      SELECT p.id AS "positionId", p.name AS "positionName",
        selected.id AS "templateId", selected.name AS "templateName",
        (selected.position_id IS NULL) AS inherited,
        tv.id AS "activeVersionId", tv.version, tv.body,
        tv.created_by AS "createdBy", tv.created_at AS "createdAt"
      FROM positions p
      LEFT JOIN LATERAL (
        SELECT mt.id, mt.name, mt.position_id, mt.active_version_id
        FROM message_templates mt
        WHERE mt.position_id = p.id OR mt.position_id IS NULL
        ORDER BY (mt.position_id = p.id) DESC NULLS LAST, mt.created_at ASC
      ) selected ON true
      LEFT JOIN template_versions tv ON tv.id = selected.active_version_id
      WHERE p.id = ANY(${ids}::uuid[])
      ORDER BY p.name
    `;
    return { templates };
  }

  async savePositionMessageTemplate(
    principal: SessionPrincipal,
    positionId: string,
    bodyInput: string,
    templateName?: string
  ): Promise<unknown> {
    if (principal.role === "interviewer") throw new AuthorizationError("Recruiting role required.");
    await this.assertPosition(principal, positionId);
    const body = bodyInput.trim().replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, variable: string) => `{{${variable.trim()}}}`);
    const name = templateName?.trim();
    if (templateName !== undefined && (!name || name.length > 80)) throw new Error("模板名称必须为 1–80 字。");
    if (body.length < 1 || body.length > 500) {
      throw new Error("Message template body must contain 1 to 500 characters.");
    }
    const allowedVariables = new Set(["candidate_name", "position_name", "hr_name"]);
    const variables = [...body.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((match) => match[1]!);
    const unsupported = variables.find((variable) => !allowedVariables.has(variable));
    if (unsupported) {
      throw new Error(`Message template variable must be supported: ${unsupported}.`);
    }
    const position = (await this.sql<Array<{ name: string }>>`
      SELECT name FROM positions WHERE id = ${positionId} AND department_id = ${principal.departmentId}
    `)[0];
    if (!position) throw new Error("Position was not found.");

    const saved = await this.sql.begin(async (tx) => {
      const templateId = randomUUID();
      const templateRows = await tx<Array<{ id: string }>>`
        INSERT INTO message_templates (id, position_id, name)
        VALUES (${templateId}, ${positionId}, ${name ?? `${position.name}联系模板`})
        ON CONFLICT (position_id, name) WHERE position_id IS NOT NULL
        DO UPDATE SET name = EXCLUDED.name
        RETURNING id
      `;
      const id = templateRows[0]!.id;
      await tx`SELECT id FROM message_templates WHERE id = ${id} FOR UPDATE`;
      const nextRows = await tx<Array<{ version: number }>>`
        SELECT COALESCE(max(version), 0)::int + 1 AS version
        FROM template_versions WHERE template_id = ${id}
      `;
      const version = nextRows[0]!.version;
      const versionId = randomUUID();
      const versions = await tx<Array<{
        activeVersionId: string;
        version: number;
        body: string;
        createdBy: string;
        createdAt: string;
      }>>`
        INSERT INTO template_versions (id, template_id, version, body, created_by)
        VALUES (${versionId}, ${id}, ${version}, ${body}, ${principal.userId})
        RETURNING id AS "activeVersionId", version, body,
          created_by AS "createdBy", created_at AS "createdAt"
      `;
      await tx`UPDATE message_templates SET active_version_id = ${versionId} WHERE id = ${id}`;
      return { templateId: id, positionId, positionName: position.name, inherited: false, ...versions[0] };
    });
    await this.audit(principal, "message_template.version.created", "message_template", saved.templateId, {
      positionId,
      version: saved.version
    });
    return saved;
  }

  private async assertState(principal: SessionPrincipal, stateId: string): Promise<{ positionId: string; candidateId: string }> {
    const row = (await this.sql<Array<{ position_id: string; candidate_id: string }>>`
      SELECT position_id, candidate_id FROM candidate_position_states WHERE id = ${stateId}
    `)[0];
    if (!row) throw new Error("Candidate state was not found.");
    await this.assertPosition(principal, row.position_id);
    return { positionId: row.position_id, candidateId: row.candidate_id };
  }

  private async audit(principal: SessionPrincipal, action: string, resourceType: string, resourceId: string, payload: unknown = {}): Promise<void> {
    await this.sql`
      INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
      VALUES (${randomUUID()}, ${principal.userId}, ${action}, ${resourceType}, ${resourceId}, ${this.sql.json(payload as JsonValue)})
    `;
  }

  async departmentWorkspace(principal: SessionPrincipal): Promise<unknown> {
    const ids = await this.positionIds(principal);
    const [users, positions, members, stages] = await Promise.all([
      this.listUsers(principal),
      ids.length === 0 ? [] : this.sql`
        SELECT id, name, status, boss_account_id AS "bossAccountId",
          owner_user_id AS "ownerUserId", semantic_mode AS "semanticMode"
        FROM positions WHERE id = ANY(${ids}::uuid[]) ORDER BY name
      `,
      ids.length === 0 ? [] : this.sql`
        SELECT pm.position_id AS "positionId", pm.user_id AS "userId", pm.member_role AS "memberRole",
          u.display_name AS "displayName", u.email
        FROM position_members pm JOIN users u ON u.id = pm.user_id
        WHERE pm.position_id = ANY(${ids}::uuid[]) ORDER BY u.display_name
      `,
      this.sql`
        SELECT id, stage_key AS key, label, stage_order AS "order", terminal
        FROM pipeline_stages WHERE department_id = ${principal.departmentId} ORDER BY stage_order
      `
    ]);
    return { users, positions, members, stages, currentUser: principal };
  }

  async updateUserStatus(principal: SessionPrincipal, userId: string, status: "active" | "disabled"): Promise<void> {
    if (!canManage(principal.role)) throw new AuthorizationError("Manager role required.");
    if (userId === principal.userId && status === "disabled") throw new Error("You cannot disable your own account.");
    await this.sql`UPDATE users SET status = ${status}, updated_at = now() WHERE id = ${userId} AND department_id = ${principal.departmentId}`;
    await this.audit(principal, "team.user.status_changed", "user", userId, { status });
  }

  async upsertStage(principal: SessionPrincipal, input: { key: string; label: string; order: number; terminal: boolean }): Promise<void> {
    if (!canManage(principal.role)) throw new AuthorizationError("Manager role required.");
    await this.sql`
      INSERT INTO pipeline_stages (id, department_id, stage_key, label, stage_order, terminal)
      VALUES (${randomUUID()}, ${principal.departmentId}, ${input.key}, ${input.label}, ${input.order}, ${input.terminal})
      ON CONFLICT (department_id, stage_key) DO UPDATE SET label = EXCLUDED.label,
        stage_order = EXCLUDED.stage_order, terminal = EXCLUDED.terminal
    `;
    await this.audit(principal, "pipeline.stage.configured", "pipeline_stage", input.key, input);
  }

  async collaborationWorkspace(principal: SessionPrincipal, stateId?: string): Promise<unknown> {
    const ids = await this.positionIds(principal);
    if (stateId) await this.assertState(principal, stateId);
    if (ids.length === 0) return { activities: [], notes: [], attachments: [], workItems: [], interviews: [], profiles: [] };
    const stateFilter = stateId ?? null;
    const [activities, notes, attachments, workItems, interviews, profiles] = await Promise.all([
      this.sql`
        SELECT a.id, a.candidate_position_state_id AS "stateId", a.activity_type AS type,
          a.summary, a.payload, a.created_at AS "createdAt", u.display_name AS actor
        FROM candidate_activities a JOIN candidate_position_states cps ON cps.id = a.candidate_position_state_id
        LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE cps.position_id = ANY(${ids}::uuid[]) AND (${stateFilter}::uuid IS NULL OR cps.id = ${stateFilter}::uuid)
        ORDER BY a.created_at DESC LIMIT 200
      `,
      this.sql`
        SELECT n.id, n.candidate_position_state_id AS "stateId", n.body,
          n.mentioned_user_ids AS "mentionedUserIds", n.created_at AS "createdAt", u.display_name AS author
        FROM candidate_notes n JOIN candidate_position_states cps ON cps.id = n.candidate_position_state_id
        JOIN users u ON u.id = n.author_user_id
        WHERE cps.position_id = ANY(${ids}::uuid[]) AND (${stateFilter}::uuid IS NULL OR cps.id = ${stateFilter}::uuid)
        ORDER BY n.created_at DESC LIMIT 200
      `,
      this.sql`
        SELECT a.id, a.candidate_position_state_id AS "stateId", a.file_name AS "fileName",
          a.mime_type AS "mimeType", a.storage_path AS "storagePath", a.size_bytes::int AS "sizeBytes",
          a.created_at AS "createdAt", u.display_name AS "uploadedBy"
        FROM candidate_attachments a JOIN candidate_position_states cps ON cps.id = a.candidate_position_state_id
        JOIN users u ON u.id = a.uploaded_by
        WHERE cps.position_id = ANY(${ids}::uuid[]) AND (${stateFilter}::uuid IS NULL OR cps.id = ${stateFilter}::uuid)
        ORDER BY a.created_at DESC LIMIT 200
      `,
      this.sql`
        SELECT w.id, w.position_id AS "positionId", w.candidate_position_state_id AS "stateId",
          w.title, w.description, w.due_at AS "dueAt", w.status, w.created_at AS "createdAt",
          u.display_name AS "assignedTo"
        FROM work_items w JOIN users u ON u.id = w.assigned_to
        WHERE w.department_id = ${principal.departmentId}
          AND (w.position_id IS NULL OR w.position_id = ANY(${ids}::uuid[]))
          AND (${stateFilter}::uuid IS NULL OR w.candidate_position_state_id = ${stateFilter}::uuid)
        ORDER BY w.status, w.due_at NULLS LAST LIMIT 200
      `,
      this.sql`
        SELECT i.id, i.candidate_position_state_id AS "stateId", i.starts_at AS "startsAt",
          i.ends_at AS "endsAt", i.location, i.meeting_url AS "meetingUrl", i.status,
          COALESCE(jsonb_agg(DISTINCT jsonb_build_object('userId', u.id, 'name', u.display_name))
            FILTER (WHERE u.id IS NOT NULL), '[]'::jsonb) AS participants,
          COALESCE(jsonb_agg(DISTINCT jsonb_build_object('reviewer', fu.display_name, 'score', f.score,
            'recommendation', f.recommendation, 'strengths', f.strengths, 'concerns', f.concerns))
            FILTER (WHERE f.id IS NOT NULL), '[]'::jsonb) AS feedback
        FROM interviews i JOIN candidate_position_states cps ON cps.id = i.candidate_position_state_id
        LEFT JOIN interview_participants ip ON ip.interview_id = i.id LEFT JOIN users u ON u.id = ip.user_id
        LEFT JOIN interview_feedback f ON f.interview_id = i.id LEFT JOIN users fu ON fu.id = f.reviewer_user_id
        WHERE cps.position_id = ANY(${ids}::uuid[]) AND (${stateFilter}::uuid IS NULL OR cps.id = ${stateFilter}::uuid)
        GROUP BY i.id ORDER BY i.starts_at DESC LIMIT 200
      `,
      this.sql`
        SELECT c.id AS "candidateId", c.display_name AS name, count(*)::int AS applications,
          jsonb_agg(jsonb_build_object('stateId', cps.id, 'positionId', p.id, 'positionName', p.name,
            'stage', cps.stage_key, 'reviewStatus', cps.review_status) ORDER BY cps.updated_at DESC) AS "applicationViews"
        FROM candidates c JOIN candidate_position_states cps ON cps.candidate_id = c.id
        JOIN positions p ON p.id = cps.position_id
        WHERE cps.is_current AND cps.position_id = ANY(${ids}::uuid[])
        GROUP BY c.id HAVING count(*) >= 1 ORDER BY count(*) DESC, c.display_name LIMIT 200
      `
    ]);
    return { activities, notes, attachments, workItems, interviews, profiles };
  }

  async addAttachment(principal: SessionPrincipal, stateId: string, input: { fileName: string; mimeType: string; storagePath: string; sizeBytes: number }): Promise<unknown> {
    await this.assertState(principal, stateId);
    const rows = await this.sql`
      INSERT INTO candidate_attachments (id, candidate_position_state_id, uploaded_by, file_name, mime_type, storage_path, size_bytes)
      VALUES (${randomUUID()}, ${stateId}, ${principal.userId}, ${input.fileName}, ${input.mimeType}, ${input.storagePath}, ${input.sizeBytes})
      RETURNING id, file_name AS "fileName", created_at AS "createdAt"
    `;
    await this.audit(principal, "candidate.attachment.added", "candidate_position_state", stateId, { fileName: input.fileName });
    return rows[0];
  }

  async createWorkItem(principal: SessionPrincipal, input: { positionId?: string | null; stateId?: string | null; assignedTo: string; title: string; description?: string; dueAt?: string | null }): Promise<unknown> {
    if (input.positionId) await this.assertPosition(principal, input.positionId);
    const state = input.stateId ? await this.assertState(principal, input.stateId) : null;
    const positionId = input.positionId ?? state?.positionId ?? null;
    const id = randomUUID();
    const rows = await this.sql`
      INSERT INTO work_items (id, department_id, position_id, candidate_position_state_id, assigned_to, created_by, title, description, due_at)
      SELECT ${id}, ${principal.departmentId}, ${positionId}, ${input.stateId ?? null}, u.id, ${principal.userId},
        ${input.title}, ${input.description ?? ""}, ${input.dueAt ?? null}
      FROM users u WHERE u.id = ${input.assignedTo} AND u.department_id = ${principal.departmentId}
      RETURNING id, title, status, due_at AS "dueAt"
    `;
    if (!rows[0]) throw new Error("Assigned user was not found.");
    await this.audit(principal, "work_item.created", "work_item", id, { positionId, stateId: input.stateId });
    return rows[0];
  }

  async completeWorkItem(principal: SessionPrincipal, workItemId: string): Promise<void> {
    const row = (await this.sql<Array<{ position_id: string | null; assigned_to: string }>>`
      SELECT position_id, assigned_to FROM work_items WHERE id = ${workItemId} AND department_id = ${principal.departmentId}
    `)[0];
    if (!row) throw new Error("Work item was not found.");
    if (row.position_id) await this.assertPosition(principal, row.position_id);
    if (row.assigned_to !== principal.userId && !canManage(principal.role)) throw new AuthorizationError("Only the assignee or a manager can complete this work item.");
    await this.sql`UPDATE work_items SET status = 'done', completed_at = now(), updated_at = now() WHERE id = ${workItemId}`;
    await this.audit(principal, "work_item.completed", "work_item", workItemId);
  }

  async scheduleInterview(principal: SessionPrincipal, input: { stateId: string; startsAt: string; endsAt: string; location?: string | null; meetingUrl?: string | null; participantIds: string[] }): Promise<unknown> {
    await this.assertState(principal, input.stateId);
    if (Date.parse(input.endsAt) <= Date.parse(input.startsAt)) throw new Error("Interview end time must be after start time.");
    const id = randomUUID();
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO interviews (id, candidate_position_state_id, scheduled_by, starts_at, ends_at, location, meeting_url)
        VALUES (${id}, ${input.stateId}, ${principal.userId}, ${input.startsAt}, ${input.endsAt}, ${input.location ?? null}, ${input.meetingUrl ?? null})
      `;
      for (const userId of input.participantIds) {
        await tx`
          INSERT INTO interview_participants (interview_id, user_id)
          SELECT ${id}, id FROM users WHERE id = ${userId} AND department_id = ${principal.departmentId}
          ON CONFLICT DO NOTHING
        `;
      }
    });
    await this.audit(principal, "interview.scheduled", "interview", id, { stateId: input.stateId });
    return { id, status: "scheduled" };
  }

  async submitInterviewFeedback(principal: SessionPrincipal, input: { interviewId: string; recommendation: string; score: number; strengths: string; concerns: string }): Promise<void> {
    const row = (await this.sql<Array<{ position_id: string }>>`
      SELECT cps.position_id FROM interviews i JOIN candidate_position_states cps ON cps.id = i.candidate_position_state_id
      WHERE i.id = ${input.interviewId}
    `)[0];
    if (!row) throw new Error("Interview was not found.");
    await this.assertPosition(principal, row.position_id);
    await this.sql`
      INSERT INTO interview_feedback (id, interview_id, reviewer_user_id, recommendation, score, strengths, concerns)
      VALUES (${randomUUID()}, ${input.interviewId}, ${principal.userId}, ${input.recommendation}, ${input.score}, ${input.strengths}, ${input.concerns})
      ON CONFLICT (interview_id, reviewer_user_id) DO UPDATE SET recommendation = EXCLUDED.recommendation,
        score = EXCLUDED.score, strengths = EXCLUDED.strengths, concerns = EXCLUDED.concerns, submitted_at = now()
    `;
    await this.audit(principal, "interview.feedback.submitted", "interview", input.interviewId, { score: input.score, recommendation: input.recommendation });
  }

  async ruleWorkspace(principal: SessionPrincipal): Promise<unknown> {
    const ids = await this.positionIds(principal);
    const [versions, templates, replays] = await Promise.all([
      ids.length === 0 ? [] : this.sql`
        SELECT rv.id, rs.position_id AS "positionId", p.name AS "positionName", rv.version, rv.config,
          rv.dictionary_version AS "dictionaryVersion", rv.lifecycle_status AS status,
          rv.parent_version_id AS "parentVersionId", rv.created_by AS "createdBy",
          rv.created_at AS "createdAt", rv.published_at AS "publishedAt",
          (rs.active_version_id = rv.id) AS active
        FROM rule_versions rv JOIN rule_sets rs ON rs.id = rv.rule_set_id JOIN positions p ON p.id = rs.position_id
        WHERE rs.position_id = ANY(${ids}::uuid[]) ORDER BY p.name, rv.version DESC
      `,
      this.sql`
        SELECT rt.id, rt.name, rt.description, rt.active_version_id AS "activeVersionId",
          COALESCE(jsonb_agg(jsonb_build_object('id', rtv.id, 'version', rtv.version, 'status', rtv.status,
            'config', rtv.config) ORDER BY rtv.version DESC) FILTER (WHERE rtv.id IS NOT NULL), '[]'::jsonb) AS versions
        FROM rule_templates rt LEFT JOIN rule_template_versions rtv ON rtv.template_id = rt.id
        WHERE rt.department_id = ${principal.departmentId} GROUP BY rt.id ORDER BY rt.name
      `,
      ids.length === 0 ? [] : this.sql`
        SELECT rr.id, rr.position_id AS "positionId", p.name AS "positionName", rr.status,
          rr.sample_size AS "sampleSize", rr.changed_count AS "changedCount", rr.summary,
          rr.created_at AS "createdAt" FROM rule_replay_runs rr JOIN positions p ON p.id = rr.position_id
        WHERE rr.position_id = ANY(${ids}::uuid[]) ORDER BY rr.created_at DESC LIMIT 100
      `
    ]);
    return { versions, templates, replays };
  }

  private async assertSalaryBudgetPermission(principal: SessionPrincipal, positionId: string, config: unknown, database: Database = this.sql): Promise<void> {
    if (principal.role === "admin") return;
    const parsed = parseRuleConfig(config);
    const next = "recruitment" in parsed ? parsed.recruitment?.salaryCeilingYuan ?? null : null;
    const current = (await database<Array<{ ceiling: string | null }>>`
      SELECT rv.config #>> '{recruitment,salaryCeilingYuan}' AS ceiling
      FROM rule_sets rs LEFT JOIN rule_versions rv ON rv.id = rs.active_version_id
      WHERE rs.position_id = ${positionId}
    `)[0]?.ceiling;
    if (next !== (current == null ? null : Number(current))) throw new AuthorizationError("只有管理员可以设置或修改岗位薪资上限。");
  }

  async createRuleDraft(principal: SessionPrincipal, input: {
    positionId: string;
    name: string;
    config: unknown;
    dictionaryVersion: string;
    parentVersionId?: string | null;
    lifecycleStatus?: "draft" | "pending_approval" | "published";
  }): Promise<unknown> {
    await this.assertPosition(principal, input.positionId);
    if (principal.role === "interviewer") throw new AuthorizationError("Interviewer role cannot create rules.");
    const lifecycleStatus = input.lifecycleStatus ?? "draft";
    if (lifecycleStatus === "published" && !canManage(principal.role)) {
      throw new AuthorizationError("Manager role required to publish rules.");
    }
    return this.sql.begin(async (tx) => {
      const ruleSet = (await tx<Array<{ id: string }>>`
        INSERT INTO rule_sets (id, position_id, name) VALUES (${randomUUID()}, ${input.positionId}, ${input.name})
        ON CONFLICT (position_id) DO UPDATE SET name = EXCLUDED.name RETURNING id
      `)[0]!;
      await tx`
        SELECT pg_advisory_xact_lock(hashtextextended(${ruleSet.id}::text, 0))
      `;
      await this.assertSalaryBudgetPermission(principal, input.positionId, input.config, tx);
      const next = (await tx<Array<{ version: number }>>`
        SELECT (COALESCE(max(version), 0) + 1)::int AS version FROM rule_versions WHERE rule_set_id = ${ruleSet.id}
      `)[0]!.version;
      const id = randomUUID();
      if (lifecycleStatus === "published") {
        await tx`
          UPDATE rule_versions SET lifecycle_status = 'retired', retired_at = now()
          WHERE rule_set_id = ${ruleSet.id} AND lifecycle_status = 'published'
        `;
      }
      const rows = await tx`
        INSERT INTO rule_versions (id, rule_set_id, version, config, dictionary_version, created_by,
          lifecycle_status, parent_version_id, approved_by, published_at)
        VALUES (${id}, ${ruleSet.id}, ${next}, ${tx.json(input.config as JsonValue)}, ${input.dictionaryVersion},
          ${principal.userId}, ${lifecycleStatus}, ${input.parentVersionId ?? null},
          ${lifecycleStatus === "published" ? principal.userId : null},
          ${lifecycleStatus === "published" ? new Date().toISOString() : null})
        RETURNING id, version, lifecycle_status AS status, config
      `;
      if (lifecycleStatus === "published") {
        await tx`UPDATE rule_sets SET active_version_id = ${id} WHERE id = ${ruleSet.id}`;
      }
      await tx`
        INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
        VALUES (${randomUUID()}, ${principal.userId},
          ${lifecycleStatus === "published" ? "rule.published" : lifecycleStatus === "pending_approval" ? "rule.pending_approval.created" : "rule.draft.created"},
          'rule_version', ${id},
          ${tx.json({ positionId: input.positionId, version: next, lifecycleStatus })})
      `;
      return rows[0];
    });
  }

  async setRuleLifecycle(principal: SessionPrincipal, versionId: string, status: "draft" | "pending_approval" | "published" | "retired"): Promise<void> {
    if (status !== "pending_approval" && !canManage(principal.role)) {
      throw new AuthorizationError("Manager role required to approve, publish or retire rules.");
    }
    if (principal.role === "interviewer") {
      throw new AuthorizationError("Interviewer role cannot change rule lifecycle.");
    }
    const row = (await this.sql<Array<{ rule_set_id: string; position_id: string; lifecycle_status: string; config: unknown }>>`
      SELECT rv.config, rv.rule_set_id, rs.position_id, rv.lifecycle_status FROM rule_versions rv
      JOIN rule_sets rs ON rs.id = rv.rule_set_id WHERE rv.id = ${versionId}
    `)[0];
    if (!row) throw new Error("Rule version was not found.");
    await this.assertPosition(principal, row.position_id);
    await this.sql.begin(async (tx) => {
      if (status === "published") {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${row.rule_set_id}::text, 0))`;
        await this.assertSalaryBudgetPermission(principal, row.position_id, row.config, tx);
        await tx`
          UPDATE rule_versions SET lifecycle_status = 'retired', retired_at = now()
          WHERE rule_set_id = ${row.rule_set_id} AND lifecycle_status = 'published' AND id <> ${versionId}
        `;
        await tx`
          UPDATE rule_versions SET lifecycle_status = 'published', approved_by = ${principal.userId},
            published_at = now(), retired_at = NULL WHERE id = ${versionId}
        `;
        await tx`UPDATE rule_sets SET active_version_id = ${versionId} WHERE id = ${row.rule_set_id}`;
      } else {
        await tx`
          UPDATE rule_versions SET lifecycle_status = ${status},
            retired_at = CASE WHEN ${status} = 'retired' THEN now() ELSE retired_at END
          WHERE id = ${versionId}
        `;
      }
    });
    await this.audit(principal, `rule.lifecycle.${status}`, "rule_version", versionId, { previousStatus: row.lifecycle_status });
  }

  async createRuleTemplate(principal: SessionPrincipal, input: { name: string; description: string; config: unknown }): Promise<unknown> {
    if (!canManage(principal.role)) throw new AuthorizationError("Manager role required.");
    const templateId = randomUUID();
    const versionId = randomUUID();
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO rule_templates (id, department_id, name, description, created_by)
        VALUES (${templateId}, ${principal.departmentId}, ${input.name}, ${input.description}, ${principal.userId})
      `;
      await tx`
        INSERT INTO rule_template_versions (id, template_id, version, config, status, created_by, approved_by)
        VALUES (${versionId}, ${templateId}, 1, ${tx.json(input.config as JsonValue)}, 'published', ${principal.userId}, ${principal.userId})
      `;
      await tx`UPDATE rule_templates SET active_version_id = ${versionId} WHERE id = ${templateId}`;
    });
    await this.audit(principal, "rule.template.created", "rule_template", templateId);
    return { id: templateId, activeVersionId: versionId };
  }

  async ruleReplayInput(principal: SessionPrincipal, positionId: string, baselineVersionId: string, candidateVersionId: string): Promise<unknown> {
    await this.assertPosition(principal, positionId);
    const versions = await this.sql`
      SELECT rv.id, rv.config FROM rule_versions rv JOIN rule_sets rs ON rs.id = rv.rule_set_id
      WHERE rs.position_id = ${positionId} AND rv.id = ANY(${[baselineVersionId, candidateVersionId]}::uuid[])
    `;
    if (versions.length !== 2) throw new Error("Both rule versions must belong to this position.");
    const samples = await this.sql`
      SELECT cps.id AS "stateId", c.display_name AS name, cs.source, cs.raw_fields AS fields,
        cs.source_evidence AS evidence, cs.raw_text AS raw, t.source_boss_filters AS "sourceBossFilters"
      FROM candidate_position_states cps JOIN candidates c ON c.id = cps.candidate_id
      JOIN candidate_snapshots cs ON cs.id = cps.latest_snapshot_id
      JOIN tasks t ON t.id = cs.task_id
      WHERE cps.position_id = ${positionId} AND cps.is_current
      ORDER BY cps.updated_at DESC LIMIT 500
    `;
    return { versions, samples };
  }

  async saveRuleReplay(principal: SessionPrincipal, input: { positionId: string; baselineVersionId: string; candidateVersionId: string; sampleSize: number; changedCount: number; summary: unknown }): Promise<unknown> {
    await this.assertPosition(principal, input.positionId);
    const id = randomUUID();
    const rows = await this.sql`
      INSERT INTO rule_replay_runs (id, position_id, baseline_rule_version_id, candidate_rule_version_id,
        status, sample_size, changed_count, summary, created_by, finished_at)
      VALUES (${id}, ${input.positionId}, ${input.baselineVersionId}, ${input.candidateVersionId},
        'completed', ${input.sampleSize}, ${input.changedCount}, ${this.sql.json(input.summary as JsonValue)}, ${principal.userId}, now())
      RETURNING id, status, sample_size AS "sampleSize", changed_count AS "changedCount", summary
    `;
    await this.audit(principal, "rule.replay.completed", "rule_replay", id, input.summary);
    return rows[0];
  }

  async semanticWorkspace(principal: SessionPrincipal): Promise<unknown> {
    const ids = await this.positionIds(principal);
    const [catalogs, sets, runs, positions] = await Promise.all([
      this.sql`
        SELECT sc.id, sc.name, sc.active_version_id AS "activeVersionId",
          COALESCE(jsonb_agg(jsonb_build_object('id', scv.id, 'version', scv.version, 'status', scv.status,
            'promptTemplate', scv.prompt_template, 'modelName', scv.model_name, 'entries', scv.entries)
            ORDER BY scv.version DESC) FILTER (WHERE scv.id IS NOT NULL), '[]'::jsonb) AS versions
        FROM semantic_catalogs sc LEFT JOIN semantic_catalog_versions scv ON scv.catalog_id = sc.id
        WHERE sc.department_id = ${principal.departmentId} GROUP BY sc.id ORDER BY sc.name
      `,
      this.sql`
        SELECT s.id, s.name, s.description, count(c.id)::int AS "caseCount"
        FROM semantic_evaluation_sets s LEFT JOIN semantic_evaluation_cases c ON c.evaluation_set_id = s.id
        WHERE s.department_id = ${principal.departmentId} GROUP BY s.id ORDER BY s.name
      `,
      this.sql`
        SELECT r.id, r.catalog_version_id AS "catalogVersionId", s.name AS "setName",
          r.status, r.model_version AS "modelVersion", r.metrics,
          r.created_at AS "createdAt" FROM semantic_evaluation_runs r
        JOIN semantic_evaluation_sets s ON s.id = r.evaluation_set_id
        WHERE s.department_id = ${principal.departmentId} ORDER BY r.created_at DESC LIMIT 100
      `,
      ids.length === 0 ? [] : this.sql`
        SELECT id, name, semantic_mode AS "semanticMode", semantic_active_catalog_version_id AS "activeCatalogVersionId"
        FROM positions WHERE id = ANY(${ids}::uuid[]) ORDER BY name
      `
    ]);
    return {
      catalogs,
      sets,
      runs,
      positions,
      activeCapabilityAvailable: SEMANTIC_ACTIVE_DECISIONS_AVAILABLE
    };
  }

  async createSemanticCatalog(principal: SessionPrincipal, input: { name: string; promptTemplate: string; modelName?: string | null; entries: unknown }): Promise<unknown> {
    if (!canManage(principal.role)) throw new AuthorizationError("Manager role required.");
    const catalogId = randomUUID();
    const versionId = randomUUID();
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO semantic_catalogs (id, department_id, name, created_by)
        VALUES (${catalogId}, ${principal.departmentId}, ${input.name}, ${principal.userId})
      `;
      await tx`
        INSERT INTO semantic_catalog_versions (id, catalog_id, version, status, prompt_template, model_name, entries, created_by)
        VALUES (${versionId}, ${catalogId}, 1, 'draft', ${input.promptTemplate}, ${input.modelName ?? null}, ${tx.json(input.entries as JsonValue)}, ${principal.userId})
      `;
    });
    await this.audit(principal, "semantic.catalog.created", "semantic_catalog", catalogId);
    return { id: catalogId, versionId };
  }

  async publishSemanticVersion(principal: SessionPrincipal, versionId: string): Promise<void> {
    if (!canManage(principal.role)) throw new AuthorizationError("Manager role required.");
    const row = (await this.sql<Array<{ catalog_id: string; department_id: string }>>`
      SELECT scv.catalog_id, sc.department_id FROM semantic_catalog_versions scv
      JOIN semantic_catalogs sc ON sc.id = scv.catalog_id WHERE scv.id = ${versionId}
    `)[0];
    if (!row || row.department_id !== principal.departmentId) throw new Error("Semantic catalog version was not found.");
    await this.sql.begin(async (tx) => {
      await tx`UPDATE semantic_catalog_versions SET status = 'retired' WHERE catalog_id = ${row.catalog_id} AND status = 'published'`;
      await tx`UPDATE semantic_catalog_versions SET status = 'published', approved_by = ${principal.userId} WHERE id = ${versionId}`;
      await tx`UPDATE semantic_catalogs SET active_version_id = ${versionId} WHERE id = ${row.catalog_id}`;
    });
    await this.audit(principal, "semantic.catalog.published", "semantic_catalog_version", versionId);
  }

  async createEvaluationSet(principal: SessionPrincipal, input: { name: string; description: string }): Promise<unknown> {
    if (!canManage(principal.role)) throw new AuthorizationError("Manager role required.");
    const id = randomUUID();
    const rows = await this.sql`
      INSERT INTO semantic_evaluation_sets (id, department_id, name, description, created_by)
      VALUES (${id}, ${principal.departmentId}, ${input.name}, ${input.description}, ${principal.userId})
      RETURNING id, name
    `;
    return rows[0];
  }

  async addEvaluationCase(principal: SessionPrincipal, input: { setId: string; criterionId: string; sourceText: string; expectedResult: string; expectedValue?: unknown }): Promise<unknown> {
    if (!canManage(principal.role)) throw new AuthorizationError("Manager role required.");
    if (!(await this.sql`SELECT id FROM semantic_evaluation_sets WHERE id = ${input.setId} AND department_id = ${principal.departmentId}`)[0]) throw new Error("Evaluation set was not found.");
    const id = randomUUID();
    const rows = await this.sql`
      INSERT INTO semantic_evaluation_cases (id, evaluation_set_id, criterion_id, source_text, expected_result, expected_value)
      VALUES (${id}, ${input.setId}, ${input.criterionId}, ${input.sourceText}, ${input.expectedResult}, ${this.sql.json((input.expectedValue ?? null) as JsonValue)})
      RETURNING id
    `;
    return rows[0];
  }

  async runSemanticEvaluation(principal: SessionPrincipal, input: { setId: string; catalogVersionId: string }): Promise<unknown> {
    if (!canManage(principal.role)) throw new AuthorizationError("Manager role required.");
    const catalog = (await this.sql<Array<{ entries: unknown; department_id: string; model_name: string | null }>>`
      SELECT scv.entries, sc.department_id, scv.model_name FROM semantic_catalog_versions scv
      JOIN semantic_catalogs sc ON sc.id = scv.catalog_id WHERE scv.id = ${input.catalogVersionId}
    `)[0];
    if (!catalog || catalog.department_id !== principal.departmentId) throw new Error("Semantic catalog version was not found.");
    if (!(await this.sql`
      SELECT id FROM semantic_evaluation_sets
      WHERE id = ${input.setId} AND department_id = ${principal.departmentId}
    `)[0]) {
      throw new Error("Evaluation set was not found.");
    }
    const cases = await this.sql<Array<{ expected_result: string; source_text: string }>>`
      SELECT expected_result, source_text FROM semantic_evaluation_cases
      WHERE evaluation_set_id = ${input.setId}
    `;
    const entries = Array.isArray(catalog.entries) ? catalog.entries : [];
    const aliases = entries.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const values = (entry as { aliases?: unknown }).aliases;
      return Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [];
    }).map((value) => value.toLowerCase());
    let correct = 0; let predictedPositive = 0; let actualPositive = 0; let truePositive = 0;
    for (const item of cases) {
      const matched = aliases.some((alias) => item.source_text.toLowerCase().includes(alias));
      const predicted = matched ? "matched" : "not_matched";
      if (predicted === item.expected_result) correct += 1;
      if (matched) predictedPositive += 1;
      if (item.expected_result === "matched") actualPositive += 1;
      if (matched && item.expected_result === "matched") truePositive += 1;
    }
    const metrics = {
      sampleSize: cases.length,
      accuracy: cases.length ? correct / cases.length : 0,
      precision: predictedPositive ? truePositive / predictedPositive : 0,
      recall: actualPositive ? truePositive / actualPositive : 0,
      unknownRate: 0,
      correctionRate: cases.length ? (cases.length - correct) / cases.length : 0,
      estimatedCost: 0
    };
    const id = randomUUID();
    const rows = await this.sql`
      INSERT INTO semantic_evaluation_runs (id, evaluation_set_id, catalog_version_id, model_version,
        status, metrics, created_by, finished_at)
      VALUES (${id}, ${input.setId}, ${input.catalogVersionId}, ${catalog.model_name ?? "deterministic-alias"},
        'completed', ${this.sql.json(metrics)}, ${principal.userId}, now()) RETURNING id, status, metrics
    `;
    await this.audit(principal, "semantic.evaluation.completed", "semantic_evaluation_run", id, metrics);
    return rows[0];
  }

  async setSemanticMode(principal: SessionPrincipal, input: { positionId: string; mode: "off" | "shadow" | "active"; catalogVersionId?: string | null }): Promise<void> {
    if (!canManage(principal.role)) throw new AuthorizationError("Manager role required.");
    await this.assertPosition(principal, input.positionId);
    if (input.catalogVersionId && !(await this.sql`
      SELECT scv.id FROM semantic_catalog_versions scv
      JOIN semantic_catalogs sc ON sc.id = scv.catalog_id
      WHERE scv.id = ${input.catalogVersionId} AND sc.department_id = ${principal.departmentId}
    `)[0]) {
      throw new Error("Semantic catalog version was not found.");
    }
    if (input.mode === "active") {
      if (!SEMANTIC_ACTIVE_DECISIONS_AVAILABLE) {
        throw new Error(
          "正式语义决策尚未通过产品验收；当前只允许试运行，结果不会改变候选人结论。"
        );
      }
      const gate = (await this.sql<Array<{ status: string; accuracy: number }>>`
        SELECT scv.status, COALESCE((r.metrics->>'accuracy')::double precision, 0) AS accuracy
        FROM semantic_catalog_versions scv JOIN semantic_catalogs sc ON sc.id = scv.catalog_id
        LEFT JOIN LATERAL (
          SELECT metrics FROM semantic_evaluation_runs WHERE catalog_version_id = scv.id AND status = 'completed'
          ORDER BY created_at DESC LIMIT 1
        ) r ON true WHERE scv.id = ${input.catalogVersionId ?? null}
          AND sc.department_id = ${principal.departmentId}
      `)[0];
      if (!gate || gate.status !== "published" || gate.accuracy < 0.9) throw new Error("Active semantic mode requires a published catalog with evaluation accuracy at least 90%.");
    }
    await this.sql`
      UPDATE positions SET semantic_mode = ${input.mode}, semantic_active_catalog_version_id = ${input.catalogVersionId ?? null}, updated_at = now()
      WHERE id = ${input.positionId}
    `;
    await this.audit(principal, "semantic.mode.changed", "position", input.positionId, input);
  }

  async operationsWorkspace(principal: SessionPrincipal): Promise<unknown> {
    const ids = await this.positionIds(principal);
    const [messages, tags, taggedCandidates, health, alerts, exports, retention, quality, overdue] = await Promise.all([
      ids.length === 0 ? [] : this.sql`
        SELECT m.id, m.candidate_position_state_id AS "stateId", c.display_name AS "candidateName",
          p.name AS "positionName", m.direction, m.body, m.sent_at AS "sentAt"
        FROM inbound_messages m JOIN candidate_position_states cps ON cps.id = m.candidate_position_state_id
        JOIN candidates c ON c.id = cps.candidate_id JOIN positions p ON p.id = cps.position_id
        WHERE cps.position_id = ANY(${ids}::uuid[]) ORDER BY m.sent_at DESC LIMIT 200
      `,
      this.sql`SELECT id, name, color FROM talent_tags WHERE department_id = ${principal.departmentId} ORDER BY name`,
      ids.length === 0 ? [] : this.sql`
        SELECT c.id AS "candidateId", c.display_name AS "candidateName",
          COALESCE(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'color', t.color))
            FILTER (WHERE t.id IS NOT NULL), '[]'::jsonb) AS tags,
          count(DISTINCT cps.position_id)::int AS applications,
          count(DISTINCT ci.id) FILTER (WHERE ci.status IN ('sent', 'simulated'))::int AS "contactCount"
        FROM candidates c JOIN candidate_position_states cps ON cps.candidate_id = c.id
        LEFT JOIN candidate_talent_tags ctt ON ctt.candidate_id = c.id LEFT JOIN talent_tags t ON t.id = ctt.tag_id
        LEFT JOIN contact_intents ci ON ci.candidate_position_state_id = cps.id
        WHERE cps.is_current AND cps.position_id = ANY(${ids}::uuid[])
        GROUP BY c.id ORDER BY c.display_name LIMIT 300
      `,
      ids.length === 0 ? [] : this.sql`
        SELECT ah.boss_account_id AS "bossAccountId", ah.status, ah.authoritative, ah.reason,
          ah.checked_at AS "checkedAt" FROM account_health ah
        WHERE ah.boss_account_id IN (SELECT boss_account_id FROM positions WHERE id = ANY(${ids}::uuid[]))
        ORDER BY ah.checked_at DESC
      `,
      this.sql`
        SELECT id, severity, alert_type AS "alertType", message, resource_type AS "resourceType",
          resource_id AS "resourceId", status, created_at AS "createdAt"
        FROM operational_alerts WHERE department_id = ${principal.departmentId} OR department_id IS NULL
        ORDER BY status, created_at DESC LIMIT 200
      `,
      this.sql`
        SELECT id, format, status, row_count AS "rowCount", created_at AS "createdAt"
        FROM data_export_jobs WHERE department_id = ${principal.departmentId} ORDER BY created_at DESC LIMIT 50
      `,
      this.sql`
        SELECT retention_days AS "retentionDays", updated_at AS "updatedAt"
        FROM data_retention_policies WHERE department_id = ${principal.departmentId}
      `,
      ids.length === 0 ? [] : this.sql`
        SELECT
          count(*)::int AS "candidateCount",
          count(*) FILTER (WHERE cps.resume_screening_status = 'failed')::int AS "ocrFailures",
          count(*) FILTER (WHERE cps.resume_screening_status = 'no_text')::int AS "ocrNoText",
          count(*) FILTER (WHERE r.correction_code IS NOT NULL)::int AS corrections,
          count(*) FILTER (WHERE cps.rule_decision = 'ambiguous' OR cps.rule_decision = 'insufficient')::int AS unknowns
        FROM candidate_position_states cps LEFT JOIN reviews r ON r.candidate_position_state_id = cps.id
        WHERE cps.is_current AND cps.position_id = ANY(${ids}::uuid[])
      `,
      this.sql`
        SELECT count(*)::int AS count FROM work_items WHERE department_id = ${principal.departmentId}
        AND status = 'open' AND due_at < now()
      `
    ]);
    return { messages, tags, taggedCandidates, health, alerts, exports, retention: retention[0] ?? { retentionDays: 730 }, quality: quality[0] ?? {}, overdue: overdue[0]?.count ?? 0 };
  }

  async syncInboundMessage(principal: SessionPrincipal, input: { stateId: string; externalMessageId: string; direction: "inbound" | "outbound"; body: string; sentAt: string }): Promise<unknown> {
    await this.assertState(principal, input.stateId);
    const id = randomUUID();
    const rows = await this.sql`
      INSERT INTO inbound_messages (id, candidate_position_state_id, external_message_id, direction, body, sent_at)
      VALUES (${id}, ${input.stateId}, ${input.externalMessageId}, ${input.direction}, ${input.body}, ${input.sentAt})
      ON CONFLICT (external_message_id) DO UPDATE SET synced_at = now()
      RETURNING id, direction, sent_at AS "sentAt"
    `;
    await this.audit(principal, "boss.message.synced", "candidate_position_state", input.stateId, { direction: input.direction });
    return rows[0];
  }

  async createTalentTag(principal: SessionPrincipal, input: { name: string; color: string }): Promise<unknown> {
    const rows = await this.sql`
      INSERT INTO talent_tags (id, department_id, name, color)
      VALUES (${randomUUID()}, ${principal.departmentId}, ${input.name}, ${input.color})
      ON CONFLICT (department_id, name) DO UPDATE SET color = EXCLUDED.color
      RETURNING id, name, color
    `;
    return rows[0];
  }

  async tagCandidate(principal: SessionPrincipal, candidateId: string, tagId: string): Promise<void> {
    const allowed = await this.positionIds(principal);
    const state = (await this.sql<Array<{ position_id: string }>>`
      SELECT position_id FROM candidate_position_states
      WHERE candidate_id = ${candidateId} AND position_id = ANY(${allowed}::uuid[]) LIMIT 1
    `)[0];
    if (!state) throw new AuthorizationError("Candidate access denied.");
    if (!(await this.sql`SELECT id FROM talent_tags WHERE id = ${tagId} AND department_id = ${principal.departmentId}`)[0]) throw new Error("Talent tag was not found.");
    await this.sql`
      INSERT INTO candidate_talent_tags (candidate_id, tag_id, added_by)
      VALUES (${candidateId}, ${tagId}, ${principal.userId}) ON CONFLICT DO NOTHING
    `;
    await this.audit(principal, "talent.tag.assigned", "candidate", candidateId, { tagId });
  }

  async updateAccountHealth(principal: SessionPrincipal, input: { bossAccountId: string; status: string; authoritative: boolean; reason?: string | null; checkedAt: string }): Promise<void> {
    if (!canManage(principal.role)) throw new AuthorizationError("Manager role required.");
    if (!(await this.sql`
      SELECT id FROM positions WHERE boss_account_id = ${input.bossAccountId} AND department_id = ${principal.departmentId}
    `)[0]) throw new Error("BOSS account was not found in this department.");
    await this.sql`
      INSERT INTO account_health (boss_account_id, status, authoritative, reason, checked_at)
      VALUES (${input.bossAccountId}, ${input.status}, false,
        ${input.reason ? `人工记录（非权威）：${input.reason}` : "人工记录（非权威）"},
        ${new Date().toISOString()})
      ON CONFLICT (boss_account_id) DO UPDATE SET status = EXCLUDED.status, authoritative = EXCLUDED.authoritative,
        reason = EXCLUDED.reason, checked_at = EXCLUDED.checked_at, updated_at = now()
    `;
    await this.audit(principal, "account.health.manual_observation", "boss_account", input.bossAccountId, {
      status: input.status,
      authoritative: false,
      reason: input.reason ?? null
    });
  }

  async acknowledgeAlert(principal: SessionPrincipal, alertId: string): Promise<void> {
    await this.sql`
      UPDATE operational_alerts SET status = 'acknowledged', acknowledged_by = ${principal.userId}
      WHERE id = ${alertId} AND (department_id = ${principal.departmentId} OR department_id IS NULL)
    `;
    await this.audit(principal, "alert.acknowledged", "operational_alert", alertId);
  }

  async exportDepartment(principal: SessionPrincipal, format: "json" | "csv"): Promise<unknown> {
    if (!canManage(principal.role)) throw new AuthorizationError("Manager role required.");
    const ids = await this.positionIds(principal);
    const rows = ids.length === 0 ? [] : await this.sql`
      SELECT c.display_name AS "candidateName", p.name AS "positionName", cps.stage_key AS stage,
        cps.review_status AS "reviewStatus", cps.rule_decision AS "ruleDecision", cps.contact_status AS "contactStatus"
      FROM candidate_position_states cps JOIN candidates c ON c.id = cps.candidate_id
      JOIN positions p ON p.id = cps.position_id
      WHERE cps.is_current AND cps.position_id = ANY(${ids}::uuid[])
      ORDER BY p.name, c.display_name
    `;
    const id = randomUUID();
    const payload = { generatedAt: new Date().toISOString(), rows };
    await this.sql`
      INSERT INTO data_export_jobs (id, department_id, requested_by, format, status, row_count, payload, finished_at)
      VALUES (${id}, ${principal.departmentId}, ${principal.userId}, ${format}, 'completed', ${rows.length}, ${this.sql.json(payload)}, now())
    `;
    await this.audit(principal, "data.export.completed", "data_export", id, { format, rowCount: rows.length });
    return { id, format, rowCount: rows.length, payload };
  }

  async setRetention(principal: SessionPrincipal, retentionDays: number): Promise<void> {
    if (!canManage(principal.role)) throw new AuthorizationError("Manager role required.");
    await this.sql`
      INSERT INTO data_retention_policies (department_id, retention_days, updated_by)
      VALUES (${principal.departmentId}, ${retentionDays}, ${principal.userId})
      ON CONFLICT (department_id) DO UPDATE SET retention_days = EXCLUDED.retention_days,
        updated_by = EXCLUDED.updated_by, updated_at = now()
    `;
    await this.audit(principal, "data.retention.updated", "department", principal.departmentId, { retentionDays });
  }

  async automationWorkspace(principal: SessionPrincipal): Promise<unknown> {
    const ids = await this.positionIds(principal);
    const [controls, approvals, accounts] = await Promise.all([
      this.sql`
        SELECT id, scope_type AS "scopeType", scope_id AS "scopeId", enabled,
          approval_required AS "approvalRequired", approved_by AS "approvedBy",
          approved_at AS "approvedAt", policy, emergency_stop AS "emergencyStop",
          version, updated_at AS "updatedAt" FROM contact_controls
        WHERE (scope_type = 'global' AND scope_id = 'global')
          OR (scope_type = 'department' AND scope_id = ${principal.departmentId})
          OR (scope_type = 'position' AND scope_id = ANY(${ids}::text[]))
          OR (scope_type = 'task' AND scope_id IN (SELECT id::text FROM tasks WHERE position_id = ANY(${ids}::uuid[])))
        ORDER BY scope_type, scope_id
      `,
      this.sql`
        SELECT id, scope_type AS "scopeType", scope_id AS "scopeId", status, justification,
          decision_note AS "decisionNote", created_at AS "createdAt", decided_at AS "decidedAt"
        FROM contact_approval_requests WHERE
          (scope_type = 'department' AND scope_id = ${principal.departmentId})
          OR (scope_type = 'position' AND scope_id = ANY(${ids}::text[]))
          OR (scope_type = 'task' AND scope_id IN (SELECT id::text FROM tasks WHERE position_id = ANY(${ids}::uuid[])))
        ORDER BY created_at DESC LIMIT 100
      `,
      ids.length === 0 ? [] : this.sql`
        SELECT boss_account_id AS "bossAccountId", status, authoritative, reason, checked_at AS "checkedAt"
        FROM account_health WHERE boss_account_id IN
          (SELECT boss_account_id FROM positions WHERE id = ANY(${ids}::uuid[]))
      `
    ]);
    return {
      controls,
      approvals,
      accounts,
      realContactTransportAvailable: REAL_CONTACT_TRANSPORT_AVAILABLE,
      contactDispatchMode: contactDispatchModeFromEnvironment(process.env),
      sideEffectsMode: contactSideEffectsModeFromEnvironment(process.env)
    };
  }

  async setContactControl(principal: SessionPrincipal, input: { scopeType: "global" | "department" | "position" | "task"; scopeId: string; enabled: boolean; approvalRequired: boolean; policy: unknown; emergencyStop: boolean }): Promise<void> {
    if (!canManage(principal.role)) throw new AuthorizationError("Manager role required.");
    if (input.enabled && !contactAuthorizationMutationAllowed()) {
      throw new Error("当前版本未提供真实联系能力，只能保持关闭并使用模拟联系。");
    }
    if (input.scopeType === "global" && principal.role !== "admin") throw new AuthorizationError("Administrator role required for global control.");
    if (input.scopeType === "global" && input.scopeId !== "global") {
      throw new AuthorizationError("Global control scope must use the global identifier.");
    }
    if (input.scopeType === "department" && input.scopeId !== principal.departmentId) throw new AuthorizationError("Department access denied.");
    if (input.scopeType === "position") await this.assertPosition(principal, input.scopeId);
    if (input.scopeType === "task") {
      const task = (await this.sql<Array<{ position_id: string }>>`SELECT position_id FROM tasks WHERE id = ${input.scopeId}`)[0];
      if (!task) throw new Error("Task was not found.");
      await this.assertPosition(principal, task.position_id);
    }
    const contactWindow = input.scopeType === 'global' ? contactWindowFromPolicy(input.policy) : null;
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO contact_controls (id, scope_type, scope_id, enabled, approval_required, policy,
          emergency_stop, updated_by, approved_by, approved_at)
        VALUES (${randomUUID()}, ${input.scopeType}, ${input.scopeId}, ${input.enabled}, ${input.approvalRequired},
          ${tx.json(input.policy as JsonValue)}, ${input.emergencyStop}, ${principal.userId},
          ${input.approvalRequired ? null : principal.userId}, ${input.approvalRequired ? null : new Date().toISOString()})
        ON CONFLICT (scope_type, scope_id) DO UPDATE SET enabled = EXCLUDED.enabled,
          approval_required = EXCLUDED.approval_required, policy = EXCLUDED.policy,
          emergency_stop = EXCLUDED.emergency_stop, updated_by = EXCLUDED.updated_by,
          approved_by = CASE WHEN EXCLUDED.approval_required THEN NULL ELSE EXCLUDED.approved_by END,
          approved_at = CASE WHEN EXCLUDED.approval_required THEN NULL ELSE EXCLUDED.approved_at END,
          version = contact_controls.version + 1, updated_at = now()
      `;
      if (input.scopeType === "global") {
        await tx`
          UPDATE contact_settings
          SET emergency_stop = ${input.emergencyStop}, updated_by = ${principal.userId},
            allowed_start_minute = COALESCE(${contactWindow?.startMinute ?? null}, allowed_start_minute),
            allowed_end_minute = COALESCE(${contactWindow?.endMinute ?? null}, allowed_end_minute),
            version = version + 1, updated_at = now()
          WHERE id = 'global'
        `;
      }
      if (input.scopeType === 'position') {
        // Only fill missing task settings. An explicit task override remains authoritative.
        await tx`
          INSERT INTO contact_controls (id, scope_type, scope_id, enabled, approval_required, policy,
            emergency_stop, updated_by, approved_by, approved_at)
          SELECT gen_random_uuid(), 'task', task.id::text, parent.enabled, parent.approval_required, parent.policy,
            parent.emergency_stop, parent.updated_by, parent.approved_by, parent.approved_at
          FROM tasks task JOIN contact_controls parent ON parent.scope_type = 'position' AND parent.scope_id = task.position_id::text
          WHERE task.position_id = ${input.scopeId}::uuid
          ON CONFLICT (scope_type, scope_id) DO NOTHING
        `;
      }
    });
    await this.audit(principal, input.emergencyStop ? "contact.emergency_stop" : "contact.control.updated", input.scopeType, input.scopeId, input);
  }

  async requestContactApproval(principal: SessionPrincipal, input: { scopeType: "department" | "position" | "task"; scopeId: string; justification: string }): Promise<unknown> {
    if (principal.role === "interviewer") {
      throw new AuthorizationError("Interviewers cannot request contact authorization.");
    }
    if (!contactAuthorizationMutationAllowed()) {
      throw new Error("当前版本未提供真实联系能力，不能创建开启授权。");
    }
    if (input.scopeType === "department" && input.scopeId !== principal.departmentId) throw new AuthorizationError("Department access denied.");
    if (input.scopeType === "position") await this.assertPosition(principal, input.scopeId);
    if (input.scopeType === "task") {
      const row = (await this.sql<Array<{ position_id: string }>>`SELECT position_id FROM tasks WHERE id = ${input.scopeId}`)[0];
      if (!row) throw new Error("Task was not found.");
      await this.assertPosition(principal, row.position_id);
    }
    const id = randomUUID();
    const rows = await this.sql`
      INSERT INTO contact_approval_requests (id, scope_type, scope_id, requested_by, justification)
      VALUES (${id}, ${input.scopeType}, ${input.scopeId}, ${principal.userId}, ${input.justification})
      RETURNING id, status
    `;
    await this.audit(principal, "contact.approval.requested", input.scopeType, input.scopeId, { requestId: id });
    return rows[0];
  }

  async decideContactApproval(principal: SessionPrincipal, input: { requestId: string; decision: "approved" | "rejected"; note: string }): Promise<void> {
    if (!canManage(principal.role)) throw new AuthorizationError("Manager role required.");
    if (input.decision === "approved" && !contactAuthorizationMutationAllowed()) {
      throw new Error("当前版本未提供真实联系能力，不能批准开启授权。");
    }
    const row = (await this.sql<Array<{
      scope_type: string;
      scope_id: string;
      status: string;
      created_at: Date;
    }>>`
      SELECT scope_type, scope_id, status, created_at
      FROM contact_approval_requests WHERE id = ${input.requestId}
    `)[0];
    if (!row || row.status !== "pending") throw new Error("Pending approval request was not found.");
    if (row.scope_type === "department" && row.scope_id !== principal.departmentId) throw new AuthorizationError("Department access denied.");
    if (row.scope_type === "position") await this.assertPosition(principal, row.scope_id);
    if (row.scope_type === "task") {
      const task = (await this.sql<Array<{ position_id: string }>>`
        SELECT position_id FROM tasks WHERE id = ${row.scope_id}
      `)[0];
      if (!task) throw new Error("Task was not found.");
      await this.assertPosition(principal, task.position_id);
    }
    await this.sql.begin(async (tx) => {
      const decided = await tx<Array<{ id: string }>>`
        UPDATE contact_approval_requests SET status = ${input.decision}, decided_by = ${principal.userId},
          decision_note = ${input.note}, decided_at = now()
        WHERE id = ${input.requestId} AND status = 'pending'
        RETURNING id
      `;
      if (!decided[0]) throw new Error("Pending approval request was already decided.");
      if (input.decision === "approved") {
        const approved = await tx<Array<{ id: string }>>`
          UPDATE contact_controls SET approved_by = ${principal.userId}, approved_at = now(),
            updated_by = ${principal.userId}, version = version + 1, updated_at = now()
          WHERE scope_type = ${row.scope_type} AND scope_id = ${row.scope_id}
            AND updated_at <= ${row.created_at}
          RETURNING id
        `;
        if (!approved[0]) {
          throw new Error(
            "Contact control changed after this approval request; submit a new request."
          );
        }
      }
    });
    await this.audit(principal, `contact.approval.${input.decision}`, row.scope_type, row.scope_id, { requestId: input.requestId });
  }

  async contactReadiness(principal: SessionPrincipal, input: { positionId: string; taskId?: string | null; candidateId?: string | null }): Promise<unknown> {
    await this.assertPosition(principal, input.positionId);
    const realDispatchEnabled =
      contactSideEffectsModeFromEnvironment(process.env) === "real_greet_enabled";
    const position = (await this.sql<Array<{ boss_account_id: string; department_id: string }>>`
      SELECT boss_account_id, department_id FROM positions WHERE id = ${input.positionId}
    `)[0]!;
    if (input.taskId) {
      const task = (await this.sql<Array<{ position_id: string }>>`
        SELECT position_id FROM tasks WHERE id = ${input.taskId}
      `)[0];
      if (!task || task.position_id !== input.positionId) {
        throw new AuthorizationError("Task does not belong to the requested position.");
      }
    }
    if (input.candidateId) {
      const candidate = (await this.sql<
        Array<{ source_locator: unknown }>
      >`
        SELECT snapshot.source_locator
        FROM candidate_position_states cps
        JOIN candidate_snapshots snapshot ON snapshot.id = cps.latest_snapshot_id
        WHERE cps.candidate_id = ${input.candidateId}
          AND cps.position_id = ${input.positionId}
          AND (
            ${input.taskId ?? null}::uuid IS NULL
            OR cps.latest_task_id = ${input.taskId ?? null}::uuid
          )
        ORDER BY cps.is_current DESC, cps.updated_at DESC
        LIMIT 1
      `)[0];
      if (!candidate) {
        throw new AuthorizationError(
          input.taskId
            ? "Candidate does not belong to the requested task and position."
            : "Candidate does not belong to the requested position."
        );
      }
      if (
        realDispatchEnabled &&
        !candidate.source_locator
      ) {
        throw new Error("Contact policy blocked: stable candidate locator is missing.");
      }
    }
    const scopes = [{ type: "global", id: "global" }, { type: "department", id: position.department_id }, { type: "position", id: input.positionId }];
    if (input.taskId) scopes.push({ type: "task", id: input.taskId });
    const controls = await this.sql<Array<{ scope_type: string; scope_id: string; enabled: boolean; approval_required: boolean; approved_at: Date | null; emergency_stop: boolean; policy: unknown }>>`
      SELECT scope_type, scope_id, enabled, approval_required, approved_at, emergency_stop, policy
      FROM contact_controls WHERE
        (scope_type = 'global' AND scope_id = 'global')
        OR (scope_type = 'department' AND scope_id = ${position.department_id})
        OR (scope_type = 'position' AND scope_id = ${input.positionId})
        OR (${input.taskId ?? null}::text IS NOT NULL AND scope_type = 'task' AND scope_id = ${input.taskId ?? null})
    `;
    const health = (await this.sql<Array<{ status: string; authoritative: boolean; checked_at: Date }>>`
      SELECT status, authoritative, checked_at
      FROM account_health WHERE boss_account_id = ${position.boss_account_id}
    `)[0];
    const dnc = input.candidateId ? Boolean((await this.sql`
      SELECT candidate_id FROM do_not_contact WHERE candidate_id = ${input.candidateId} AND active = true
    `)[0]) : false;
    const reasons: string[] = [];
    const legacyEmergencyStop = Boolean((await this.sql`
      SELECT id FROM contact_settings WHERE id = 'global' AND emergency_stop = true
    `)[0]);
    if (legacyEmergencyStop) reasons.push("global emergency stop");
    for (const scope of scopes) {
      const control = controls.find((item) => item.scope_type === scope.type && item.scope_id === scope.id);
      if (!control) reasons.push(`${scope.type} control missing`);
      else {
        if (!control.enabled) reasons.push(`${scope.type} disabled`);
        if (control.emergency_stop) reasons.push(`${scope.type} emergency stop`);
        if (control.approval_required && !control.approved_at) reasons.push(`${scope.type} approval missing`);
      }
    }
    if (
      realDispatchEnabled &&
      (!health?.authoritative || health.status !== "healthy")
    ) {
      reasons.push("authoritative BOSS account health is not healthy");
    } else if (realDispatchEnabled && health) {
      const configuredHealthMaxAgeMs = Number(
        process.env.BOSS_FORGE_ACCOUNT_HEALTH_MAX_AGE_MS ?? "1800000"
      );
      const healthMaxAgeMs =
        Number.isFinite(configuredHealthMaxAgeMs) && configuredHealthMaxAgeMs >= 60_000
          ? configuredHealthMaxAgeMs
          : 1_800_000;
      if (Date.now() - health.checked_at.getTime() > healthMaxAgeMs) {
        reasons.push("authoritative BOSS account health is stale");
      }
    }
    if (dnc) reasons.push("candidate is Do-Not-Contact");
    return {
      ready: reasons.length === 0,
      reasons,
      controls,
      accountHealth: health ?? { status: "unknown", authoritative: false },
      contactDispatchMode: contactDispatchModeFromEnvironment(process.env),
      sideEffectsMode: contactSideEffectsModeFromEnvironment(process.env)
    };
  }

  async analytics(principal: SessionPrincipal): Promise<unknown> {
    const ids = await this.positionIds(principal);
    if (ids.length === 0) return { funnel: [], sources: [], reviews: {} };
    const [funnel, sources, reviews] = await Promise.all([
      this.sql`
        SELECT stage_key AS stage, count(*)::int AS count FROM candidate_position_states
        WHERE position_id = ANY(${ids}::uuid[]) GROUP BY stage_key
      `,
      this.sql`
        SELECT cs.source, count(*)::int AS count FROM candidate_snapshots cs
        JOIN tasks t ON t.id = cs.task_id WHERE t.position_id = ANY(${ids}::uuid[])
        GROUP BY cs.source
      `,
      this.sql`
        SELECT count(*) FILTER (WHERE review_status = 'approved')::int AS approved,
          count(*) FILTER (WHERE review_status = 'rejected')::int AS rejected,
          count(*) FILTER (WHERE review_status = 'pending')::int AS pending
        FROM candidate_position_states WHERE position_id = ANY(${ids}::uuid[])
      `
    ]);
    return { funnel, sources, reviews: reviews[0] ?? {} };
  }
}
