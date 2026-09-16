import { screeningCandidateLimit } from "@boss-forge/contracts";
import { assertRuleScreeningSource } from "./rule-config.js";
import { randomUUID } from "node:crypto";
import { evaluateContactPolicy } from "@boss-forge/contact-policy";
import {
  ContactPreviewApprovalConfigurationError,
  ContactQueueApprovalExpiredError,
  issueContactQueueApproval,
  verifyContactDispatchApproval,
  contactDispatchModeFromEnvironment,
  contactMessageSha256,
  contactPreviewApprovalSigningKeyFromEnvironment,
  contactSideEffectsModeFromEnvironment,
  contactSourceLocatorSha256,
  isContactPreviewApproval,
  sameContactPreviewApproval,
  verifyContactPreviewApproval,
  type ContactActionKind,
  type ContactPreviewApproval,
  type IssuedContactPreviewApproval
} from "@boss-forge/contracts";
import type { Database } from "./client.js";
import { evaluateExactContactReadiness } from "./contact-readiness.js";
import { enqueueIntegrationEvent } from "./integration-events.js";
import { OptimisticLockError } from "./repository.js";
import type {
  AuditLog,
  ContactDispatchResult,
  ContactDispatchJob,
  ContactIntent,
  ContactIntentStatus,
  MessagePreview,
  Schedule,
  ScheduleFrequency
} from "./types.js";

function iso(value: Date): string {
  return value.toISOString();
}

function assertContactActionKind(value: string): asserts value is ContactActionKind {
  if (value !== "greet" && value !== "message") {
    throw new Error("Contact action kind must be greet or message.");
  }
}

function isWithinAllowedWindow(minute: number, start: number, end: number): boolean {
  if (!Number.isInteger(minute) || start === end) return false;
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

function isInsideCooldown(now: string, lastContactAt: Date | null, cooldownHours: number): boolean {
  if (!lastContactAt || cooldownHours <= 0) return false;
  const nowMs = Date.parse(now);
  return !Number.isFinite(nowMs) || nowMs - lastContactAt.getTime() < cooldownHours * 3_600_000;
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;
const DEFAULT_DEFER_MS = 15 * 60 * 1_000;

function shanghaiDayStartUtc(valueMs: number): number {
  const shifted = new Date(valueMs + SHANGHAI_OFFSET_MS);
  return (
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) -
    SHANGHAI_OFFSET_MS
  );
}

function shanghaiMinuteOfDay(valueMs: number): number {
  const shifted = new Date(valueMs + SHANGHAI_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

function alignToAllowedWindow(valueMs: number, start: number, end: number): number {
  const minute = shanghaiMinuteOfDay(valueMs);
  if (isWithinAllowedWindow(minute, start, end)) return valueMs;
  const dayStart = shanghaiDayStartUtc(valueMs);
  if (start < end) {
    return minute < start ? dayStart + start * 60_000 : dayStart + 86_400_000 + start * 60_000;
  }
  return dayStart + start * 60_000;
}

function nextShanghaiDayWindowStart(valueMs: number, start: number): number {
  return shanghaiDayStartUtc(valueMs) + 86_400_000 + start * 60_000;
}

const PERMANENT_CONTACT_BLOCKS = new Set([
  "job_closed",
  "task_not_active",
  "manual_review_required",
  "same_position_already_contacted",
  "same_position_contact_already_active",
  "authorization_missing",
  "authorization_revoked",
  "authorization_expired",
  "do_not_contact",
  "transport_mode_changed",
  "boss_account_changed",
  "rule_version_changed",
  "rendered_message_changed",
  "contact_policy_snapshot_changed",
  "contact_policy_snapshot_missing",
  "policy_auto_contact_disabled",
  "intent_creator_not_authorized",
  "intent_creator_department_changed",
  "intent_creator_position_access_revoked",
  "current_candidate_state",
  "contact_dispatch_disabled",
  "contact_dispatch_mode_mismatch",
  "real_contact_circuit_open",
  "contact_preview_approval_missing",
  "contact_preview_approval_expired",
  "contact_queue_approval_expired",
  "contact_preview_approval_binding_changed",
  "contact_preview_approval_signature_invalid",
  "contact_preview_approval_signing_key_unavailable",
  "stable_candidate_locator_missing",
  "stable_candidate_locator_changed",
  "dispatch_context_changed",
  "quota_reservation_consumed",
  "quota_reservation_released"
]);

function isPermanentContactBlock(reason: string): boolean {
  return (
    PERMANENT_CONTACT_BLOCKS.has(reason) ||
    /^contact_control_(global|department|position|task)_(missing|disabled|approval_missing|approval_invalid)$/u.test(
      reason
    )
  );
}

export class ContactDispatchPolicyError extends Error {
  readonly disposition: "deferred" | "failed";
  readonly reasons: readonly string[];
  readonly availableAt: string | null;

  constructor(input: {
    disposition: "deferred" | "failed";
    reasons: readonly string[];
    availableAt?: string | null;
  }) {
    const uniqueReasons = [...new Set(input.reasons)];
    super(`Contact dispatch preflight blocked: ${uniqueReasons.join(",")}`);
    this.name = "ContactDispatchPolicyError";
    this.disposition = input.disposition;
    this.reasons = uniqueReasons;
    this.availableAt = input.availableAt ?? null;
  }
}

function contactBlockError(input: {
  reasons: readonly string[];
  now: string;
  allowedStartMinute: number;
  allowedEndMinute: number;
  lastCrossPositionContactAt: Date | null;
  crossPositionCooldownHours: number;
}): ContactDispatchPolicyError {
  const reasons = [...new Set(input.reasons)];
  if (reasons.some(isPermanentContactBlock)) {
    return new ContactDispatchPolicyError({ disposition: "failed", reasons });
  }
  const nowMs = Date.parse(input.now);
  let availableMs = nowMs + DEFAULT_DEFER_MS;
  if (reasons.includes("outside_allowed_hours")) {
    availableMs = Math.max(
      availableMs,
      alignToAllowedWindow(nowMs, input.allowedStartMinute, input.allowedEndMinute)
    );
  }
  if (
    reasons.some((reason) =>
      ["account_daily_limit", "position_daily_limit", "task_limit"].includes(reason)
    )
  ) {
    availableMs = Math.max(
      availableMs,
      nextShanghaiDayWindowStart(nowMs, input.allowedStartMinute)
    );
  }
  if (reasons.includes("cross_position_cooldown") && input.lastCrossPositionContactAt) {
    availableMs = Math.max(
      availableMs,
      input.lastCrossPositionContactAt.getTime() +
        input.crossPositionCooldownHours * 3_600_000
    );
  }
  availableMs = alignToAllowedWindow(
    availableMs,
    input.allowedStartMinute,
    input.allowedEndMinute
  );
  return new ContactDispatchPolicyError({
    disposition: "deferred",
    reasons,
    availableAt: new Date(availableMs).toISOString()
  });
}

function nextScheduleAt(current: Date, frequency: ScheduleFrequency): Date | null {
  if (frequency === "once") return null;
  const next = new Date(current);
  const increment = frequency === "weekly" ? 7 : 1;
  next.setUTCDate(next.getUTCDate() + increment);
  if (frequency === "weekdays") {
    const shanghaiWeekday = (value: Date): number =>
      new Date(value.getTime() + 8 * 60 * 60 * 1000).getUTCDay();
    while (shanghaiWeekday(next) === 0 || shanghaiWeekday(next) === 6) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
  }
  return next;
}

type ScheduleRow = {
  id: string;
  position_id: string;
  position_name: string;
  source: Schedule["source"];
  candidate_limit: number;
  auto_greet: boolean;
  search_keyword: string | null;
  frequency: ScheduleFrequency;
  timezone: string;
  next_run_at: Date;
  enabled: boolean;
  created_by: string;
  version: number;
  created_at: Date;
};

function mapSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    positionId: row.position_id,
    positionName: row.position_name,
    source: row.source,
    candidateLimit: row.candidate_limit,
    autoGreet: row.auto_greet,
    searchKeyword: row.search_keyword,
    frequency: row.frequency,
    timezone: row.timezone,
    nextRunAt: iso(row.next_run_at),
    enabled: row.enabled,
    createdBy: row.created_by,
    version: row.version,
    createdAt: iso(row.created_at)
  };
}

export class M2Repository {
  constructor(private readonly sql: Database) {}

  async createSchedule(input: {
    idempotencyKey: string;
    positionId: string;
    source: "recommend" | "search";
    searchKeyword?: string | null;
    frequency: ScheduleFrequency;
    timezone: string;
    nextRunAt: string;
    createdBy: string;
    candidateLimit?: number;
    autoGreet?: boolean;
  }): Promise<Schedule> {
    const candidateLimit = screeningCandidateLimit(input.candidateLimit);
    const autoGreet = input.autoGreet === true;
    const nextRunAt = new Date(input.nextRunAt);
    if (!Number.isFinite(nextRunAt.getTime())) throw new Error("nextRunAt must be a valid date.");
    return this.sql.begin(async (transaction) => {
      const replayRows = await transaction<ScheduleRow[]>`
        SELECT s.id, s.position_id, p.name AS position_name, s.source,
          s.search_keyword, s.candidate_limit, s.auto_greet, s.frequency, s.timezone, s.next_run_at, s.enabled,
          s.created_by, s.version, s.created_at
        FROM schedules s JOIN positions p ON p.id = s.position_id
        WHERE s.idempotency_key = ${input.idempotencyKey}
      `;
      const assertReplayMatches = (row: ScheduleRow): void => {
        if (
          row.position_id !== input.positionId ||
          row.source !== input.source ||
          row.candidate_limit !== candidateLimit ||
          row.auto_greet !== autoGreet ||
          row.search_keyword !== (input.searchKeyword ?? null) ||
          row.frequency !== input.frequency ||
          row.timezone !== input.timezone ||
          row.next_run_at.getTime() !== nextRunAt.getTime() ||
          row.created_by !== input.createdBy
        ) {
          throw new Error("Idempotency-Key is already used for a different schedule request.");
        }
      };
      if (replayRows[0]) {
        assertReplayMatches(replayRows[0]);
        return mapSchedule(replayRows[0]);
      }
      const unavailable = await transaction`SELECT p.id FROM positions p
        WHERE p.id = ${input.positionId} AND (p.status <> 'active' OR (
          ${input.source} = 'recommend' AND p.boss_job_id IS NULL AND EXISTS (
            SELECT 1 FROM positions linked WHERE linked.boss_account_id = p.boss_account_id AND linked.boss_job_id IS NOT NULL)))`;
      if (unavailable.length) throw new Error("请先关联已开放的 BOSS 岗位，再设置定时筛选。");
      const ruleRows = await transaction<{ active_version_id: string | null; config: unknown; boss_job_id: string | null }[]>`
        SELECT rs.active_version_id, rv.config, p.boss_job_id FROM rule_sets rs JOIN rule_versions rv ON rv.id = rs.active_version_id JOIN positions p ON p.id = rs.position_id WHERE rs.position_id = ${input.positionId}
      `;
      const ruleVersionId = ruleRows[0]?.active_version_id;
      if (!ruleVersionId) throw new Error("Position has no active rule version.");
      assertRuleScreeningSource(ruleRows[0]!.config, input.source, ruleRows[0]!.boss_job_id);
      const scheduleId = randomUUID();
      const inserted = await transaction<Array<{ id: string }>>`
        INSERT INTO schedules (
          id, idempotency_key, position_id, rule_version_id, source,
          search_keyword, candidate_limit, auto_greet, frequency, timezone, next_run_at, created_by
        ) VALUES (
          ${scheduleId}, ${input.idempotencyKey}, ${input.positionId}, ${ruleVersionId},
          ${input.source}, ${input.searchKeyword ?? null}, ${candidateLimit}, ${autoGreet}, ${input.frequency},
          ${input.timezone}, ${nextRunAt}, ${input.createdBy}
        ) ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id
      `;
      const rows = await transaction<ScheduleRow[]>`
        SELECT s.id, s.position_id, p.name AS position_name, s.source,
          s.search_keyword, s.candidate_limit, s.auto_greet, s.frequency, s.timezone, s.next_run_at, s.enabled,
          s.created_by, s.version, s.created_at
        FROM schedules s JOIN positions p ON p.id = s.position_id
        WHERE s.idempotency_key = ${input.idempotencyKey}
      `;
      if (!rows[0]) throw new Error("Schedule creation did not return a record.");
      assertReplayMatches(rows[0]);
      const schedule = mapSchedule(rows[0]!);
      if (inserted[0]) {
        await transaction`
          INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
          VALUES (
            ${randomUUID()}, ${input.createdBy}, 'schedule.created', 'schedule',
            ${schedule.id}, ${transaction.json({
              frequency: input.frequency,
              nextRunAt: input.nextRunAt,
              candidateLimit,
              autoGreet
            })}
          )
        `;
      }
      return schedule;
    });
  }

  async listSchedules(options?: { positionIds?: string[] }): Promise<Schedule[]> {
    const positionScope = options?.positionIds === undefined ? null : options.positionIds;
    const rows = await this.sql<ScheduleRow[]>`
      SELECT s.id, s.position_id, p.name AS position_name, s.source,
        s.search_keyword, s.candidate_limit, s.auto_greet, s.frequency, s.timezone, s.next_run_at, s.enabled,
        s.created_by, s.version, s.created_at
      FROM schedules s JOIN positions p ON p.id = s.position_id
      WHERE (${positionScope}::uuid[] IS NULL OR s.position_id = ANY(${positionScope}::uuid[]))
      ORDER BY s.created_at DESC LIMIT 50
    `;
    return rows.map(mapSchedule);
  }

  async cancelSchedule(input: {
    scheduleId: string;
    expectedVersion: number;
    actorId: string;
  }): Promise<Schedule> {
    const rows = await this.sql<ScheduleRow[]>`
      UPDATE schedules SET enabled = false, version = version + 1, updated_at = now()
      WHERE id = ${input.scheduleId} AND version = ${input.expectedVersion}
      RETURNING id, position_id,
        (SELECT name FROM positions WHERE id = position_id) AS position_name,
        source, search_keyword, candidate_limit, auto_greet, frequency, timezone, next_run_at, enabled,
        created_by, version, created_at
    `;
    if (!rows[0]) throw new Error("Schedule version conflict or schedule not found.");
    await this.sql`
      INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
      VALUES (${randomUUID()}, ${input.actorId}, 'schedule.cancelled', 'schedule',
        ${input.scheduleId}, ${this.sql.json({ expectedVersion: input.expectedVersion })})
    `;
    return mapSchedule(rows[0]);
  }

  async materializeDueSchedules(now = new Date()): Promise<number> {
    return this.sql.begin(async (transaction) => {
      const due = await transaction<
        Array<{
          id: string;
          position_id: string;
          rule_version_id: string;
          source: "recommend" | "search";
          search_keyword: string | null;
          candidate_limit: number;
          auto_greet: boolean;
          frequency: ScheduleFrequency;
          next_run_at: Date;
          created_by: string;
        }>
      >`
        SELECT id, position_id, rule_version_id, source, search_keyword, candidate_limit,
          auto_greet, frequency, next_run_at, created_by
        FROM schedules
        WHERE enabled = true AND next_run_at <= ${now}
          AND EXISTS (SELECT 1 FROM positions p WHERE p.id = schedules.position_id AND p.status = 'active'
            AND (schedules.source <> 'recommend' OR p.boss_job_id IS NOT NULL OR NOT EXISTS (
              SELECT 1 FROM positions linked WHERE linked.boss_account_id = p.boss_account_id AND linked.boss_job_id IS NOT NULL)))
        ORDER BY next_run_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 20
      `;
      for (const schedule of due) {
        const idempotencyKey = `schedule:${schedule.id}:${schedule.next_run_at.toISOString()}`;
        await transaction`
          INSERT INTO tasks (
            id, idempotency_key, position_id, rule_version_id, execution_mode,
            source, search_keyword, status, created_by, schedule_id, scheduled_for,
            candidate_limit, auto_greet
          ) VALUES (
            ${randomUUID()}, ${idempotencyKey}, ${schedule.position_id},
            ${schedule.rule_version_id}, 'scheduled', ${schedule.source},
            ${schedule.search_keyword}, 'queued', ${schedule.created_by},
            ${schedule.id}, ${schedule.next_run_at}, ${schedule.candidate_limit},
            ${schedule.auto_greet}
          ) ON CONFLICT (idempotency_key) DO NOTHING
        `;
        const next = nextScheduleAt(schedule.next_run_at, schedule.frequency);
        if (next) {
          await transaction`
            UPDATE schedules SET next_run_at = ${next}, last_materialized_at = ${now},
              version = version + 1, updated_at = now()
            WHERE id = ${schedule.id}
          `;
        } else {
          await transaction`
            UPDATE schedules SET enabled = false, last_materialized_at = ${now},
              version = version + 1, updated_at = now()
            WHERE id = ${schedule.id}
          `;
        }
      }
      return due.length;
    });
  }

  async ensureMessageTemplate(input: {
    positionId?: string | null;
    name: string;
    body: string;
    createdBy: string;
  }): Promise<string> {
    return this.sql.begin(async (transaction) => {
      const existing = await transaction<{ id: string; active_version_id: string | null }[]>`
        SELECT id, active_version_id FROM message_templates
        WHERE name = ${input.name}
          AND position_id IS NOT DISTINCT FROM ${input.positionId ?? null}
        ORDER BY created_at ASC LIMIT 1
      `;
      let templateId = existing[0]?.id;
      if (!templateId) {
        templateId = randomUUID();
        await transaction`
          INSERT INTO message_templates (id, position_id, name)
          VALUES (${templateId}, ${input.positionId ?? null}, ${input.name})
        `;
      }
      if (existing[0]?.active_version_id) return existing[0].active_version_id;
      const versionId = randomUUID();
      await transaction`
        INSERT INTO template_versions (id, template_id, version, body, created_by)
        VALUES (${versionId}, ${templateId}, 1, ${input.body}, ${input.createdBy})
      `;
      await transaction`
        UPDATE message_templates SET active_version_id = ${versionId} WHERE id = ${templateId}
      `;
      return versionId;
    });
  }

  async previewMessage(stateId: string, templateVersionId: string | null = null, hrName = "HR"): Promise<MessagePreview> {
    const rows = await this.sql<
      Array<{
        template_version_id: string;
        template_version: number;
        body: string;
        candidate_state_id: string;
        candidate_id: string;
        candidate_name: string;
        candidate_fingerprint: string;
        position_id: string;
        position_name: string;
        task_id: string;
        boss_account_id: string;
        boss_job_keyword: string | null;
        source: "recommend" | "search";
        source_reference: string;
        source_locator: import("@boss-forge/contracts").CandidateSourceLocator | null;
        review_status: MessagePreview["reviewStatus"];
        contact_status: MessagePreview["contactStatus"];
      }>
    >`
      SELECT tv.id AS template_version_id, tv.version AS template_version, tv.body,
        cps.id AS candidate_state_id, c.id AS candidate_id,
        c.display_name AS candidate_name, c.fingerprint AS candidate_fingerprint,
        p.id AS position_id, p.name AS position_name, cps.latest_task_id AS task_id,
        p.boss_account_id, p.boss_job_keyword, task.source, snapshot.source_reference,
        snapshot.source_locator, cps.review_status, cps.contact_status
      FROM candidate_position_states cps
      JOIN candidates c ON c.id = cps.candidate_id
      JOIN positions p ON p.id = cps.position_id
      JOIN tasks task ON task.id = cps.latest_task_id
      JOIN candidate_snapshots snapshot ON snapshot.id = cps.latest_snapshot_id
      JOIN LATERAL (
        SELECT mt.active_version_id
        FROM message_templates mt
        WHERE (mt.position_id = p.id OR mt.position_id IS NULL)
          AND (${templateVersionId}::uuid IS NULL OR mt.active_version_id = ${templateVersionId}::uuid)
        ORDER BY (mt.position_id = p.id) DESC NULLS LAST, mt.created_at ASC
        LIMIT 1
      ) selected ON true
      JOIN template_versions tv ON tv.id = selected.active_version_id
      WHERE cps.id = ${stateId} AND cps.review_status = 'approved'
        AND cps.is_current = true
    `;
    const row = rows[0];
    if (!row) throw new Error("Approved candidate or active message template not found.");
    const rendered = row.body
      .replace(/\{\{\s*candidate_name\s*\}\}/g, () => row.candidate_name)
      .replace(/\{\{\s*position_name\s*\}\}/g, () => row.position_name)
      .replace(/\{\{\s*hr_name\s*\}\}/g, () => hrName.trim() || "HR");
    return {
      templateVersionId: row.template_version_id,
      templateVersion: row.template_version,
      body: row.body,
      renderedMessage: rendered,
      candidateStateId: row.candidate_state_id,
      candidateId: row.candidate_id,
      candidateName: row.candidate_name,
      candidateFingerprint: row.candidate_fingerprint,
      positionId: row.position_id,
      positionName: row.position_name,
      taskId: row.task_id,
      bossAccountId: row.boss_account_id,
      bossJobKeyword: row.boss_job_keyword,
      source: row.source,
      sourceReference: row.source_reference,
      sourceLocator: row.source_locator,
      reviewStatus: row.review_status,
      contactStatus: row.contact_status
    };
  }

  /** Stable, read-only context shared by independent greeting and message previews. */
  async previewContactTarget(stateId: string): Promise<{
    candidateStateId: string;
    candidateId: string;
    candidateName: string;
    candidateFingerprint: string;
    positionId: string;
    positionName: string;
    taskId: string;
    bossAccountId: string;
    bossJobKeyword: string | null;
    source: "recommend" | "search";
    sourceReference: string;
    sourceLocator: import("@boss-forge/contracts").CandidateSourceLocator | null;
    reviewStatus: MessagePreview["reviewStatus"];
    contactStatus: MessagePreview["contactStatus"];
  }> {
    const rows = await this.sql<
      Array<{
        candidate_state_id: string;
        candidate_id: string;
        candidate_name: string;
        candidate_fingerprint: string;
        position_id: string;
        position_name: string;
        task_id: string;
        boss_account_id: string;
        boss_job_keyword: string | null;
        source: "recommend" | "search";
        source_reference: string;
        source_locator: import("@boss-forge/contracts").CandidateSourceLocator | null;
        review_status: MessagePreview["reviewStatus"];
        contact_status: MessagePreview["contactStatus"];
      }>
    >`
      SELECT cps.id AS candidate_state_id, c.id AS candidate_id,
        c.display_name AS candidate_name, c.fingerprint AS candidate_fingerprint,
        p.id AS position_id, p.name AS position_name, cps.latest_task_id AS task_id,
        p.boss_account_id, p.boss_job_keyword, task.source,
        snapshot.source_reference, snapshot.source_locator,
        cps.review_status, cps.contact_status
      FROM candidate_position_states cps
      JOIN candidates c ON c.id = cps.candidate_id
      JOIN positions p ON p.id = cps.position_id
      JOIN tasks task ON task.id = cps.latest_task_id
      JOIN candidate_snapshots snapshot ON snapshot.id = cps.latest_snapshot_id
      WHERE cps.id = ${stateId} AND cps.review_status = 'approved'
        AND cps.is_current = true
    `;
    const row = rows[0];
    if (!row) throw new Error("Approved current candidate was not found.");
    return {
      candidateStateId: row.candidate_state_id,
      candidateId: row.candidate_id,
      candidateName: row.candidate_name,
      candidateFingerprint: row.candidate_fingerprint,
      positionId: row.position_id,
      positionName: row.position_name,
      taskId: row.task_id,
      bossAccountId: row.boss_account_id,
      bossJobKeyword: row.boss_job_keyword,
      source: row.source,
      sourceReference: row.source_reference,
      sourceLocator: row.source_locator,
      reviewStatus: row.review_status,
      contactStatus: row.contact_status
    };
  }

  async previewContactReadiness(input: {
    stateId: string;
    actionKind: ContactActionKind;
    now: string;
    localMinuteOfDay: number;
  }): Promise<{
    ready: boolean;
    reasons: string[];
    checks: ReturnType<typeof evaluateExactContactReadiness>["checks"];
    checkedAt: string;
    internalQuotasEnabled: boolean;
    candidate: {
      stateId: string;
      candidateId: string;
      name: string;
      reviewStatus: MessagePreview["reviewStatus"];
      resumeScreeningStatus:
        | "not_requested"
        | "queued"
        | "processing"
        | "screened"
        | "no_text"
        | "failed";
      contactStatus: MessagePreview["contactStatus"];
      doNotContact: boolean;
      samePositionAlreadyContacted: boolean;
      activeIntentStatus: string | null;
      isCurrent: boolean;
    };
    position: {
      id: string;
      name: string;
      bossAccountId: string;
      status: "active" | "paused" | "closed";
    };
    task: { id: string; status: string };
    source: {
      type: "recommend" | "search";
      stableLocatorPresent: boolean;
    };
    schedule: {
      withinAllowedHours: boolean;
      allowedStartMinute: number;
      allowedEndMinute: number;
    };
    quotas: Array<{
      scopeType: "account" | "position" | "task";
      label: string;
      used: number;
      reserved: number;
      limit: number;
    }>;
    accountHealth: {
      status: "healthy" | "degraded" | "blocked" | "unknown";
      authoritative: boolean;
      checkedAt: string | null;
      fresh: boolean;
    };
  }> {
    assertContactActionKind(input.actionKind);
    if (!Number.isFinite(Date.parse(input.now))) {
      throw new Error("Contact preview readiness time is invalid.");
    }
    if (
      !Number.isInteger(input.localMinuteOfDay) ||
      input.localMinuteOfDay < 0 ||
      input.localMinuteOfDay > 1_439
    ) {
      throw new Error("Contact preview readiness localMinuteOfDay must be between 0 and 1439.");
    }
    const contextRows = await this.sql<
      Array<{
        state_id: string;
        candidate_id: string;
        candidate_name: string;
        position_id: string;
        position_name: string;
        position_status: "active" | "paused" | "closed";
        department_id: string;
        boss_account_id: string;
        task_id: string;
        task_status: string;
        source: "recommend" | "search";
        source_locator: import("@boss-forge/contracts").CandidateSourceLocator | null;
        review_status: MessagePreview["reviewStatus"];
        resume_screening_status:
          | "not_requested"
          | "queued"
          | "processing"
          | "screened"
          | "no_text"
          | "failed";
        contact_status: MessagePreview["contactStatus"];
        is_current: boolean;
        do_not_contact: boolean;
        same_position_sent: boolean;
        active_intent_status: string | null;
        account_has_uncertain: boolean;
        last_cross_position_contact_at: Date | null;
        legacy_emergency_stop: boolean;
        allowed_start_minute: number;
        allowed_end_minute: number;
        internal_quotas_enabled: boolean;
        account_daily_limit: number;
        position_daily_limit: number;
        task_limit: number;
        cross_position_cooldown_hours: number;
        account_health_status: "healthy" | "degraded" | "blocked" | "unknown" | null;
        account_health_authoritative: boolean | null;
        account_health_checked_at: Date | null;
      }>
    >`
      SELECT cps.id AS state_id, cps.candidate_id, c.display_name AS candidate_name,
        p.id AS position_id, p.name AS position_name, p.status AS position_status,
        p.department_id, p.boss_account_id, task.id AS task_id,
        task.status AS task_status, task.source, snapshot.source_locator,
        cps.review_status, cps.resume_screening_status, cps.contact_status,
        cps.is_current,
        EXISTS (
          SELECT 1 FROM do_not_contact dnc
          WHERE dnc.candidate_id = cps.candidate_id AND dnc.active = true
        ) AS do_not_contact,
        EXISTS (
          SELECT 1 FROM contact_intents prior
          JOIN candidate_position_states prior_state
            ON prior_state.id = prior.candidate_position_state_id
          WHERE prior_state.candidate_id = cps.candidate_id
            AND prior_state.position_id = cps.position_id
            AND prior.action_kind = ${input.actionKind}
            AND prior.status = 'sent'
        ) AS same_position_sent,
        (
          SELECT active.status FROM contact_intents active
          JOIN candidate_position_states active_state
            ON active_state.id = active.candidate_position_state_id
          WHERE active_state.candidate_id = cps.candidate_id
            AND active_state.position_id = cps.position_id
            AND active.action_kind = ${input.actionKind}
            AND active.status IN ('ready', 'processing', 'sent', 'uncertain')
          ORDER BY active.created_at DESC LIMIT 1
        ) AS active_intent_status,
        EXISTS (
          SELECT 1 FROM contact_intents uncertain
          JOIN candidate_position_states uncertain_state
            ON uncertain_state.id = uncertain.candidate_position_state_id
          JOIN positions uncertain_position
            ON uncertain_position.id = uncertain_state.position_id
          WHERE uncertain_position.boss_account_id = p.boss_account_id
            AND uncertain.status = 'uncertain'
            AND uncertain.transport_mode = 'real'
        ) AS account_has_uncertain,
        (
          SELECT MAX(cross_intent.finished_at) FROM contact_intents cross_intent
          JOIN candidate_position_states cross_state
            ON cross_state.id = cross_intent.candidate_position_state_id
          WHERE cross_state.candidate_id = cps.candidate_id
            AND cross_state.position_id <> cps.position_id
            AND cross_intent.status = 'sent'
        ) AS last_cross_position_contact_at,
        settings.emergency_stop AS legacy_emergency_stop,
        settings.allowed_start_minute, settings.allowed_end_minute,
        settings.internal_quotas_enabled, settings.account_daily_limit, settings.position_daily_limit,
        settings.task_limit, settings.cross_position_cooldown_hours,
        health.status AS account_health_status,
        health.authoritative AS account_health_authoritative,
        health.checked_at AS account_health_checked_at
      FROM candidate_position_states cps
      JOIN candidates c ON c.id = cps.candidate_id
      JOIN positions p ON p.id = cps.position_id
      JOIN tasks task ON task.id = cps.latest_task_id
      JOIN candidate_snapshots snapshot ON snapshot.id = cps.latest_snapshot_id
      JOIN contact_settings settings ON settings.id = 'global'
      LEFT JOIN account_health health ON health.boss_account_id = p.boss_account_id
      WHERE cps.id = ${input.stateId}
    `;
    const context = contextRows[0];
    if (!context) throw new Error("Candidate state not found.");

    const requiredScopes = [
      ["global", "global", "全局"],
      ["department", context.department_id, "当前部门"],
      ["position", context.position_id, "当前岗位"],
      ["task", context.task_id, "当前任务"]
    ] as const;
    const controls = await this.sql<
      Array<{
        scope_type: "global" | "department" | "position" | "task";
        scope_id: string;
        enabled: boolean;
        approval_required: boolean;
        approved_at: Date | null;
        emergency_stop: boolean;
        approver_status: "active" | "disabled" | null;
        approver_role: "admin" | "recruiting_lead" | "recruiter" | "interviewer" | null;
        approver_department_id: string | null;
      }>
    >`
      SELECT control.scope_type, control.scope_id, control.enabled,
        control.approval_required, control.approved_at, control.emergency_stop,
        approver.status AS approver_status, approver.role AS approver_role,
        approver.department_id AS approver_department_id
      FROM contact_controls control
      LEFT JOIN users approver ON approver.id = control.approved_by
      WHERE (control.scope_type = 'global' AND control.scope_id = 'global')
        OR (control.scope_type = 'department' AND control.scope_id = ${context.department_id})
        OR (control.scope_type = 'position' AND control.scope_id = ${context.position_id})
        OR (control.scope_type = 'task' AND control.scope_id = ${context.task_id})
    `;
    const controlFacts = requiredScopes.map(([scopeType, scopeId, label]) => {
      const control = controls.find(
        (item) => item.scope_type === scopeType && item.scope_id === scopeId
      );
      const approvalValid = Boolean(
        control?.approved_at &&
          control.approver_status === "active" &&
          ["admin", "recruiting_lead"].includes(control.approver_role ?? "") &&
          control.approver_department_id === context.department_id
      );
      return {
        scopeType,
        label,
        exists: Boolean(control),
        enabled: control?.enabled ?? false,
        emergencyStop: control?.emergency_stop ?? false,
        approvalRequired: control?.approval_required ?? true,
        approvalValid
      };
    });

    const quotaRows = await this.sql<
      Array<{
        scope_type: "account" | "position" | "task";
        used: number;
        reserved: number;
      }>
    >`
      SELECT scope_type, used, reserved
      FROM quota_counters
      WHERE quota_day = ((${input.now}::timestamptz AT TIME ZONE 'Asia/Shanghai')::date)
        AND (
          (scope_type = 'account' AND scope_id = ${context.boss_account_id}) OR
          (scope_type = 'position' AND scope_id = ${context.position_id}) OR
          (scope_type = 'task' AND scope_id = ${context.task_id})
        )
    `;
    const quotaValue = (scopeType: "account" | "position" | "task") =>
      quotaRows.find((item) => item.scope_type === scopeType) ?? {
        scope_type: scopeType,
        used: 0,
        reserved: 0
      };
    const accountQuota = quotaValue("account");
    const positionQuota = quotaValue("position");
    const taskQuota = quotaValue("task");
    const quotas = [
      {
        scopeType: "account" as const,
        label: "BOSS 账号",
        used: Number(accountQuota.used),
        reserved: Number(accountQuota.reserved),
        limit: context.account_daily_limit
      },
      {
        scopeType: "position" as const,
        label: "岗位",
        used: Number(positionQuota.used),
        reserved: Number(positionQuota.reserved),
        limit: context.position_daily_limit
      },
      {
        scopeType: "task" as const,
        label: "任务",
        used: Number(taskQuota.used),
        reserved: Number(taskQuota.reserved),
        limit: context.task_limit
      }
    ];

    const configuredHealthMaxAgeMs = Number(
      process.env.BOSS_FORGE_ACCOUNT_HEALTH_MAX_AGE_MS ?? "1800000"
    );
    const healthMaxAgeMs =
      Number.isFinite(configuredHealthMaxAgeMs) && configuredHealthMaxAgeMs >= 60_000
        ? configuredHealthMaxAgeMs
        : 1_800_000;
    const healthFresh = Boolean(
      context.account_health_checked_at &&
        Date.parse(input.now) - context.account_health_checked_at.getTime() <= healthMaxAgeMs
    );
    const realContact =
      contactSideEffectsModeFromEnvironment(process.env) === "real_greet_enabled";
    const evaluated = evaluateExactContactReadiness({
      realContact,
      internalQuotasEnabled: context.internal_quotas_enabled,
      isCurrent: context.is_current,
      resumeScreeningStatus: context.resume_screening_status,
      reviewStatus: context.review_status,
      contactStatus:
        input.actionKind === "message" ? context.contact_status : "not_contacted",
      doNotContact: context.do_not_contact,
      samePositionAlreadyContacted: context.same_position_sent,
      activeIntentStatus: context.active_intent_status,
      accountHasUncertain: context.account_has_uncertain,
      positionStatus: context.position_status,
      taskStatus: context.task_status,
      source: context.source,
      stableLocatorPresent: Boolean(context.source_locator?.value.trim()),
      legacyEmergencyStop: context.legacy_emergency_stop,
      withinAllowedHours: isWithinAllowedWindow(
        input.localMinuteOfDay,
        context.allowed_start_minute,
        context.allowed_end_minute
      ),
      crossPositionCooldownActive: isInsideCooldown(
        input.now,
        context.last_cross_position_contact_at,
        context.cross_position_cooldown_hours
      ),
      accountHealthReady: Boolean(
        context.account_health_authoritative &&
          context.account_health_status === "healthy" &&
          healthFresh
      ),
      controls: controlFacts,
      quotas
    });

    return {
      ...evaluated,
      checkedAt: input.now,
      internalQuotasEnabled: context.internal_quotas_enabled,
      candidate: {
        stateId: context.state_id,
        candidateId: context.candidate_id,
        name: context.candidate_name,
        reviewStatus: context.review_status,
        resumeScreeningStatus: context.resume_screening_status,
        contactStatus:
          input.actionKind === "message" ? context.contact_status : "not_contacted",
        doNotContact: context.do_not_contact,
        samePositionAlreadyContacted: context.same_position_sent,
        activeIntentStatus: context.active_intent_status,
        isCurrent: context.is_current
      },
      position: {
        id: context.position_id,
        name: context.position_name,
        bossAccountId: context.boss_account_id,
        status: context.position_status
      },
      task: { id: context.task_id, status: context.task_status },
      source: {
        type: context.source,
        stableLocatorPresent: Boolean(context.source_locator?.value.trim())
      },
      schedule: {
        withinAllowedHours: isWithinAllowedWindow(
          input.localMinuteOfDay,
          context.allowed_start_minute,
          context.allowed_end_minute
        ),
        allowedStartMinute: context.allowed_start_minute,
        allowedEndMinute: context.allowed_end_minute
      },
      quotas,
      accountHealth: {
        status: context.account_health_status ?? "unknown",
        authoritative: context.account_health_authoritative ?? false,
        checkedAt: context.account_health_checked_at?.toISOString() ?? null,
        fresh: healthFresh
      }
    };
  }

  async createManualContactIntent(input: {
    stateId: string;
    actionKind: ContactActionKind;
    idempotencyKey: string;
    templateVersionId: string | null;
    providerJobId: string | null;
    providerGreetingId: string | null;
    renderedMessage: string;
    createdBy: string;
    localMinuteOfDay: number;
    now: string;
    transportMode?: "fake" | "real";
    realApproval?: IssuedContactPreviewApproval;
    intervalSeconds?: number;
  }): Promise<ContactIntent> {
    assertContactActionKind(input.actionKind);
    const intervalSeconds = input.intervalSeconds ?? 10;
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 10 || intervalSeconds > 600) throw new Error("联系启动间隔必须为 10–600 秒。");
    const providerJobId = input.providerJobId?.trim() ?? null;
    const providerGreetingId = input.providerGreetingId?.trim() ?? null;
    if (
      (input.actionKind === "message" &&
        (!input.templateVersionId?.trim() ||
          providerJobId !== null ||
          providerGreetingId !== null)) ||
      (input.actionKind === "greet" &&
        (input.templateVersionId !== null ||
          providerJobId === null ||
          providerGreetingId === null))
    ) {
      throw new Error(
        "Greeting intents require providerJobId/providerGreetingId; message intents require templateVersionId."
      );
    }
    const transportMode = input.transportMode ?? "fake";
    return this.sql.begin(async (transaction) => {
      const replay = await transaction<
        Array<{
          id: string;
          action_kind: ContactActionKind;
          candidate_position_state_id: string;
          candidate_id: string;
          task_id: string;
          candidate_name: string;
          position_name: string;
          boss_account_id: string;
          source_locator: import("@boss-forge/contracts").CandidateSourceLocator | null;
          template_version_id: string | null;
          provider_job_id: string | null;
          provider_greeting_id: string | null;
          rendered_message: string;
          transport_mode: "fake" | "real";
          status: ContactIntentStatus;
          created_by: string;
          version: number;
          created_at: Date;
          last_error: string | null;
        }>
      >`
        SELECT ci.id, ci.action_kind, ci.candidate_position_state_id,
          c.id AS candidate_id, ci.task_id, c.display_name AS candidate_name,
          p.name AS position_name, p.boss_account_id, snapshot.source_locator,
          ci.template_version_id, ci.provider_job_id, ci.provider_greeting_id,
          ci.rendered_message,
          ci.transport_mode,
          ci.status, ci.created_by, ci.version,
          ci.created_at, ci.last_error
        FROM contact_intents ci
        JOIN candidate_position_states cps ON cps.id = ci.candidate_position_state_id
        JOIN candidates c ON c.id = cps.candidate_id
        JOIN positions p ON p.id = cps.position_id
        JOIN candidate_snapshots snapshot ON snapshot.id = cps.latest_snapshot_id
        WHERE ci.idempotency_key = ${input.idempotencyKey}
      `;
      if (replay[0]) {
        const existing = replay[0];
        if (
          existing.candidate_position_state_id !== input.stateId ||
          existing.action_kind !== input.actionKind ||
          existing.template_version_id !== input.templateVersionId ||
          existing.provider_job_id !== providerJobId ||
          existing.provider_greeting_id !== providerGreetingId ||
          existing.rendered_message !== input.renderedMessage ||
          existing.created_by !== input.createdBy ||
          existing.transport_mode !== transportMode
        ) {
          throw new Error("Idempotency-Key is already used for a different contact request.");
        }
        return this.mapContactIntent(existing);
      }
      const contextRows = await transaction<
        Array<{
          candidate_name: string;
          candidate_id: string;
          position_name: string;
          position_id: string;
          department_id: string;
          boss_account_id: string;
          task_id: string;
          source: "recommend" | "search";
          review_status: "pending" | "approved" | "rejected" | "not_required";
          resume_screening_status:
            | "not_requested"
            | "queued"
            | "processing"
            | "screened"
            | "no_text"
            | "failed";
          rule_decision: "matched" | "not_matched" | "ambiguous" | "insufficient";
          rule_confidence: number;
          contact_status: string;
          is_current: boolean;
          last_cross_position_contact_at: Date | null;
          emergency_stop: boolean;
          allowed_start_minute: number;
          allowed_end_minute: number;
          internal_quotas_enabled: boolean;
          account_daily_limit: number;
          position_daily_limit: number;
          task_limit: number;
          cross_position_cooldown_hours: number;
          account_used: number;
          position_used: number;
          task_used: number;
          source_locator: import("@boss-forge/contracts").CandidateSourceLocator | null;
          creator_status: "active" | "disabled" | null;
          creator_role: "admin" | "recruiting_lead" | "recruiter" | "interviewer" | null;
          creator_department_id: string | null;
          creator_has_position_access: boolean;
        }>
      >`
        SELECT c.display_name AS candidate_name, c.id AS candidate_id,
          p.name AS position_name, p.id AS position_id, p.department_id,
          p.boss_account_id, cps.latest_task_id AS task_id, task.source,
          cps.review_status, cps.resume_screening_status, cps.rule_decision,
          cps.rule_confidence, cps.contact_status, cps.is_current,
          (
            SELECT MAX(ci2.finished_at) FROM contact_intents ci2
            JOIN candidate_position_states cps2 ON cps2.id = ci2.candidate_position_state_id
            WHERE cps2.candidate_id = cps.candidate_id AND ci2.status = 'sent'
              AND cps2.position_id <> cps.position_id
          ) AS last_cross_position_contact_at,
          settings.emergency_stop, settings.allowed_start_minute,
          settings.allowed_end_minute, settings.internal_quotas_enabled, settings.account_daily_limit,
          settings.position_daily_limit, settings.task_limit,
          settings.cross_position_cooldown_hours,
          COALESCE(account_quota.used, 0)::int AS account_used,
          COALESCE(position_quota.used, 0)::int AS position_used,
          COALESCE(task_quota.used, 0)::int AS task_used,
          snapshot.source_locator,
          creator.status AS creator_status, creator.role AS creator_role,
          creator.department_id AS creator_department_id,
          EXISTS (
            SELECT 1 FROM position_members membership
            WHERE membership.position_id = p.id AND membership.user_id = creator.id
          ) AS creator_has_position_access
        FROM candidate_position_states cps
        JOIN candidates c ON c.id = cps.candidate_id
        JOIN positions p ON p.id = cps.position_id
        JOIN tasks task ON task.id = cps.latest_task_id
        JOIN candidate_snapshots snapshot ON snapshot.id = cps.latest_snapshot_id
        JOIN contact_settings settings ON settings.id = 'global'
        LEFT JOIN users creator ON creator.id::text = ${input.createdBy}
        LEFT JOIN quota_counters account_quota ON account_quota.scope_type = 'account'
          AND account_quota.scope_id = p.boss_account_id AND account_quota.quota_day = CURRENT_DATE
        LEFT JOIN quota_counters position_quota ON position_quota.scope_type = 'position'
          AND position_quota.scope_id = p.id::text AND position_quota.quota_day = CURRENT_DATE
        LEFT JOIN quota_counters task_quota ON task_quota.scope_type = 'task'
          AND task_quota.scope_id = cps.latest_task_id::text AND task_quota.quota_day = CURRENT_DATE
        WHERE cps.id = ${input.stateId}
        FOR UPDATE OF cps
      `;
      const context = contextRows[0];
      if (!context) throw new Error("Candidate state not found.");
      await transaction`
        SELECT pg_advisory_xact_lock(hashtextextended(${context.candidate_id}::text, 0))
      `;
      const contactHistoryRows = await transaction<
        Array<{
          same_position_action_sent: boolean;
          active_position_action_intent_status: "ready" | "processing" | "uncertain" | null;
        }>
      >`
        SELECT EXISTS (
          SELECT 1
          FROM contact_intents prior
          JOIN candidate_position_states prior_state
            ON prior_state.id = prior.candidate_position_state_id
          WHERE prior_state.candidate_id = ${context.candidate_id}
            AND prior_state.position_id = ${context.position_id}
            AND prior.action_kind = ${input.actionKind}
            AND prior.status = 'sent'
        ) AS same_position_action_sent,
        (
          SELECT active.status
          FROM contact_intents active
          JOIN candidate_position_states active_state
            ON active_state.id = active.candidate_position_state_id
          WHERE active_state.candidate_id = ${context.candidate_id}
            AND active_state.position_id = ${context.position_id}
            AND active.action_kind = ${input.actionKind}
            AND active.status IN ('ready', 'processing', 'uncertain')
          ORDER BY active.created_at DESC
          LIMIT 1
        ) AS active_position_action_intent_status
      `;
      const contactHistory = contactHistoryRows[0];
      if (!contactHistory) {
        throw new Error("Could not verify existing contact history.");
      }

      const intentId = randomUUID();
      let contactQueueApprovalToken: string | null = null;
      const requestBlocks: string[] = [];
      let verifiedRealApproval: ContactPreviewApproval | null = null;
      if (transportMode === "real") {
        if (!input.realApproval) {
          requestBlocks.push("contact_preview_approval_missing");
        } else if (!context.source_locator) {
          requestBlocks.push("stable_candidate_locator_missing");
        } else {
          try {
            const approvalInput = {
              token: input.realApproval.token,
              signingKey: contactPreviewApprovalSigningKeyFromEnvironment(process.env),
              expected: {
                actionKind: input.actionKind,
                approvedBy: input.createdBy,
                candidateStateId: input.stateId,
                candidateId: context.candidate_id,
                candidateName: context.candidate_name,
                positionId: context.position_id,
                positionName: context.position_name,
                taskId: context.task_id,
                bossAccountId: context.boss_account_id,
                source: context.source,
                sourceLocator: context.source_locator,
                templateVersionId: input.templateVersionId,
                providerJobId,
                providerGreetingId,
                renderedMessage: input.renderedMessage
              },
              now: new Date(input.now)
            };
            verifiedRealApproval = verifyContactPreviewApproval(approvalInput);
            contactQueueApprovalToken = issueContactQueueApproval({ ...approvalInput, intentId });
          } catch (error: unknown) {
            requestBlocks.push(
              error instanceof ContactPreviewApprovalConfigurationError
                ? "contact_preview_approval_signing_key_unavailable"
                : "contact_preview_approval_signature_invalid"
            );
          }
        }
      } else if (input.realApproval) {
        requestBlocks.push("contact_preview_approval_binding_changed");
      }
      if (
        context.creator_status !== "active" ||
        !context.creator_role ||
        !["admin", "recruiting_lead", "recruiter"].includes(context.creator_role)
      ) {
        requestBlocks.push("intent_creator_not_authorized");
      } else if (context.creator_department_id !== context.department_id) {
        requestBlocks.push("intent_creator_department_changed");
      } else if (
        context.creator_role === "recruiter" &&
        !context.creator_has_position_access
      ) {
        requestBlocks.push("intent_creator_position_access_revoked");
      }
      if (!context.is_current) requestBlocks.push("current_candidate_state");
      if (["not_requested", "queued", "processing"].includes(context.resume_screening_status)) {
        requestBlocks.push("resume_screening_incomplete");
      }
      if (contactHistory.same_position_action_sent) {
        requestBlocks.push("same_position_already_contacted");
      }
      if (contactHistory.active_position_action_intent_status) {
        requestBlocks.push("same_position_contact_already_active");
      }
      const configuredDispatchMode = contactDispatchModeFromEnvironment(process.env);
      if (configuredDispatchMode === "disabled") {
        requestBlocks.push("contact_dispatch_disabled");
      } else if (transportMode !== configuredDispatchMode) {
        requestBlocks.push("contact_dispatch_mode_mismatch");
      }
      if (
        transportMode === "real" &&
        contactSideEffectsModeFromEnvironment(process.env) !== "real_greet_enabled"
      ) {
        requestBlocks.push("real_contact_circuit_open");
      }
      if (transportMode === "real" && !context.source_locator) {
        requestBlocks.push("stable_candidate_locator_missing");
      }
      if (Boolean((await transaction`
        SELECT candidate_id FROM do_not_contact
        WHERE candidate_id = ${context.candidate_id} AND active = true
      `)[0])) {
        requestBlocks.push("do_not_contact");
      }

      const requiredControlScopes = [
        ["global", "global"],
        ["department", context.department_id],
        ["position", context.position_id],
        ["task", context.task_id]
      ] as const;
      const controls = await transaction<
        Array<{
          scope_type: "global" | "department" | "position" | "task";
          scope_id: string;
          enabled: boolean;
          approval_required: boolean;
          approved_at: Date | null;
          emergency_stop: boolean;
          approver_status: "active" | "disabled" | null;
          approver_role: "admin" | "recruiting_lead" | "recruiter" | "interviewer" | null;
          approver_department_id: string | null;
        }>
      >`
        SELECT scope_type, scope_id, enabled, approval_required, approved_at,
          emergency_stop, approver.status AS approver_status,
          approver.role AS approver_role,
          approver.department_id AS approver_department_id
        FROM contact_controls control
        LEFT JOIN users approver ON approver.id = control.approved_by
        WHERE (scope_type = 'global' AND scope_id = 'global')
          OR (scope_type = 'department' AND scope_id = ${context.department_id})
          OR (scope_type = 'position' AND scope_id = ${context.position_id})
          OR (scope_type = 'task' AND scope_id = ${context.task_id})
        FOR UPDATE OF control
      `;
      for (const [scopeType, scopeId] of requiredControlScopes) {
        const control = controls.find(
          (item) => item.scope_type === scopeType && item.scope_id === scopeId
        );
        if (!control) {
          requestBlocks.push(`contact_control_${scopeType}_missing`);
          continue;
        }
        if (!control.enabled) requestBlocks.push(`contact_control_${scopeType}_disabled`);
        if (control.emergency_stop) {
          requestBlocks.push(`contact_control_${scopeType}_emergency_stop`);
        }
        if (control.approval_required) {
          if (!control.approved_at) {
            requestBlocks.push(`contact_control_${scopeType}_approval_missing`);
          } else if (
            control.approver_status !== "active" ||
            !["admin", "recruiting_lead"].includes(control.approver_role ?? "") ||
            control.approver_department_id !== context.department_id
          ) {
            requestBlocks.push(`contact_control_${scopeType}_approval_invalid`);
          }
        }
      }
      if (requestBlocks.length > 0) {
        throw new Error(`Contact policy blocked: ${[...new Set(requestBlocks)].join(",")}`);
      }
      const decision = evaluateContactPolicy({
        mode: "manual",
        switches: {
          emergencyStop: context.emergency_stop,
          globalAutomatic: false,
          positionAutomatic: false,
          taskAutomatic: false
        },
        runtime: { healthy: true, circuitOpen: false },
        candidate: {
          reviewStatus: context.review_status,
          ruleDecision: context.rule_decision,
          ruleConfidence: context.rule_confidence,
          samePositionAlreadyContacted:
            contactHistory.same_position_action_sent ||
            (input.actionKind === "message" &&
              (context.contact_status === "queued" || context.contact_status === "sent")),
          lastCrossPositionContactAt: context.last_cross_position_contact_at?.toISOString() ?? null,
          previousSendState: context.contact_status === "uncertain" ? "uncertain" : "none"
        },
        limits: {
          account: { used: context.account_used, limit: context.internal_quotas_enabled === false ? Number.MAX_SAFE_INTEGER : context.account_daily_limit },
          position: { used: context.position_used, limit: context.internal_quotas_enabled === false ? Number.MAX_SAFE_INTEGER : context.position_daily_limit },
          task: { used: context.task_used, limit: context.internal_quotas_enabled === false ? Number.MAX_SAFE_INTEGER : context.task_limit }
        },
        schedule: {
          now: input.now,
          localMinuteOfDay: input.localMinuteOfDay,
          allowedStartMinute: context.allowed_start_minute,
          allowedEndMinute: context.allowed_end_minute,
          crossPositionCooldownHours: context.cross_position_cooldown_hours
        },
        minimumAutomaticConfidence: 1
      });
      if (!decision.allowed) {
        throw new Error(`Contact policy blocked: ${decision.reasons.join(",")}`);
      }
      const policySnapshot = {
        mode: "manual",
        actionKind: input.actionKind,
        transportMode,
        evaluatedAt: input.now,
        reasons: decision.reasons,
        contactPreviewApproval: verifiedRealApproval
      };
      const storedPolicySnapshot = {
        ...policySnapshot,
        contactPreviewApprovalToken: input.realApproval?.token ?? null,
        contactQueueApprovalToken
      };
      const rows = await transaction<
        Array<{
          id: string;
          action_kind: ContactActionKind;
          candidate_position_state_id: string;
          task_id: string;
          template_version_id: string | null;
          provider_job_id: string | null;
          provider_greeting_id: string | null;
          rendered_message: string;
          transport_mode: "fake" | "real";
          status: ContactIntentStatus;
          created_by: string;
          version: number;
          created_at: Date;
          last_error: string | null;
        }>
      >`
        INSERT INTO contact_intents (
          id, idempotency_key, action_kind, candidate_position_state_id, task_id,
          template_version_id, provider_job_id, provider_greeting_id,
          rendered_message, status, policy_snapshot, created_by, transport_mode, interval_seconds
        ) VALUES (
          ${intentId}, ${input.idempotencyKey}, ${input.actionKind}, ${input.stateId},
          ${context.task_id},
          ${input.templateVersionId}, ${providerJobId}, ${providerGreetingId},
          ${input.renderedMessage}, 'ready',
          ${transaction.json(storedPolicySnapshot)}, ${input.createdBy}, ${transportMode}, ${intervalSeconds}
        ) RETURNING id, action_kind, candidate_position_state_id, task_id,
          template_version_id, provider_job_id, provider_greeting_id, rendered_message,
          transport_mode, status, created_by, version, created_at, last_error
      `;
      await transaction`
        INSERT INTO outbox_events (
          id, aggregate_type, aggregate_id, event_type, payload
        ) VALUES (
          ${randomUUID()}, 'contact_intent', ${intentId}, 'contact.requested',
          ${transaction.json({ contactIntentId: intentId, actionKind: input.actionKind })}
        )
      `;
      if (input.actionKind === "message") {
        await transaction`
          UPDATE candidate_position_states SET contact_status = 'queued', updated_at = now()
          WHERE id = ${input.stateId}
        `;
      }
      await transaction`
        INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
        VALUES (${randomUUID()}, ${input.createdBy}, 'contact.intent.created',
          'contact_intent', ${intentId}, ${transaction.json(policySnapshot)})
      `;
      return this.mapContactIntent({
        ...rows[0]!,
        candidate_id: context.candidate_id,
        candidate_name: context.candidate_name,
        position_name: context.position_name,
        boss_account_id: context.boss_account_id,
        source_locator: context.source_locator
      });
    });
  }

  async contactDispatchControl(positionId: string) {
    const rows = await this.sql<Array<{
      positionId: string; paused: boolean; queued: number; processing: number; internalQuotasEnabled: boolean;
    }>>`
      SELECT p.id AS "positionId", p.contact_dispatch_paused AS paused,
        settings.internal_quotas_enabled AS "internalQuotasEnabled",
        (SELECT count(*)::int FROM contact_intents ci JOIN tasks t ON t.id=ci.task_id
          WHERE t.position_id=p.id AND ci.status='ready') AS queued,
        (SELECT count(*)::int FROM contact_intents ci JOIN tasks t ON t.id=ci.task_id
          WHERE t.position_id=p.id AND ci.status='processing') AS processing
      FROM positions p CROSS JOIN contact_settings settings
      WHERE p.id=${positionId} AND settings.id='global'
    `;
    if (!rows[0]) throw new Error("Position not found.");
    return rows[0];
  }

  async setContactDispatchPaused(positionId: string, paused: boolean, actorId: string): Promise<void> {
    // Admission control only: do not acquire the send fence or interrupt a send
    // already in progress. Claims briefly lock the position too, so a pause
    // acknowledgement cannot race ahead of a claim admitted before the pause.
    await this.sql.begin(async tx => {
      const rows = await tx<Array<{ id: string }>>`
        UPDATE positions SET contact_dispatch_paused=${paused}, updated_at=now(), version=version+1
        WHERE id=${positionId} AND contact_dispatch_paused<>${paused} RETURNING id
      `;
      if (rows[0]) await tx`
        INSERT INTO audit_logs(id,actor_id,action,resource_type,resource_id,payload)
        VALUES(${randomUUID()},${actorId},${paused ? 'contact.dispatch.paused' : 'contact.dispatch.resumed'},
          'position',${positionId},${tx.json({paused})})
      `;
    });
  }

  async cancelReadyContact(intentId: string, actorId: string): Promise<void> {
    await this.sql.begin(async tx => {
      const rows = await tx<Array<{ state_id: string; action_kind: string; outbox_id: string }>>`
        SELECT ci.candidate_position_state_id AS state_id, ci.action_kind, oe.id AS outbox_id
        FROM outbox_events oe JOIN contact_intents ci ON ci.id = oe.aggregate_id
        WHERE ci.id = ${intentId} AND ci.status = 'ready' AND oe.status = 'pending'
          AND oe.event_type = 'contact.requested'
        FOR UPDATE OF oe, ci SKIP LOCKED
      `;
      const row = rows[0];
      if (!row) throw new Error('任务已开始或结束，无法取消，请刷新执行记录。');
      const reservation = await tx`SELECT contact_intent_id FROM contact_quota_reservations WHERE contact_intent_id = ${intentId} AND status = 'reserved'`;
      if (reservation[0]) throw new Error('任务正在执行检查，请稍后刷新。');
      await tx`UPDATE contact_intents SET status = 'cancelled', finished_at = now(), last_error = '用户取消待发送任务', version = version + 1 WHERE id = ${intentId}`;
      await tx`UPDATE outbox_events SET status = 'completed', finished_at = now(), last_error = '用户取消待发送任务' WHERE id = ${row.outbox_id}`;
      if (row.action_kind === 'message') await tx`UPDATE candidate_position_states SET contact_status = 'not_contacted', updated_at = now() WHERE id = ${row.state_id} AND contact_status = 'queued'`;
      await tx`INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload) VALUES (${randomUUID()}, ${actorId}, 'contact.cancelled', 'contact_intent', ${intentId}, '{}'::jsonb)`;
    });
  }

  async listContactIntents(options?: { positionIds?: string[] }): Promise<ContactIntent[]> {
    const positionScope = options?.positionIds === undefined ? null : options.positionIds;
    const rows = await this.sql<
      Array<{
        id: string;
        action_kind: ContactActionKind;
        candidate_position_state_id: string;
        candidate_id: string;
        task_id: string;
        candidate_name: string;
        position_name: string;
        boss_account_id: string;
        source_locator: import("@boss-forge/contracts").CandidateSourceLocator | null;
        template_version_id: string | null;
        provider_job_id: string | null;
        provider_greeting_id: string | null;
        rendered_message: string;
        transport_mode: "fake" | "real";
        status: ContactIntentStatus;
        created_by: string;
        version: number;
        created_at: Date;
        last_error: string | null;
      }>
    >`
      SELECT ci.id, ci.action_kind, ci.candidate_position_state_id,
        c.id AS candidate_id, ci.task_id, c.display_name AS candidate_name,
        p.name AS position_name, p.boss_account_id, snapshot.source_locator,
        ci.template_version_id, ci.provider_job_id, ci.provider_greeting_id,
        ci.rendered_message, ci.transport_mode, ci.status, ci.created_by, ci.version,
        ci.created_at, ci.last_error
      FROM contact_intents ci
      JOIN candidate_position_states cps ON cps.id = ci.candidate_position_state_id
      JOIN candidates c ON c.id = cps.candidate_id
      JOIN positions p ON p.id = cps.position_id
      JOIN candidate_snapshots snapshot ON snapshot.id = cps.latest_snapshot_id
      WHERE (${positionScope}::uuid[] IS NULL OR cps.position_id = ANY(${positionScope}::uuid[]))
      ORDER BY ci.created_at DESC LIMIT 50
    `;
    return rows.map((row) => this.mapContactIntent(row));
  }

  private mapContactIntent(row: {
    id: string;
    action_kind: ContactActionKind;
    candidate_position_state_id: string;
    candidate_id: string;
    task_id: string;
    candidate_name: string;
    position_name: string;
    boss_account_id: string;
    source_locator: import("@boss-forge/contracts").CandidateSourceLocator | null;
    template_version_id: string | null;
    provider_job_id: string | null;
    provider_greeting_id: string | null;
    rendered_message: string;
    transport_mode: "fake" | "real";
    status: ContactIntentStatus;
    created_by: string;
    version: number;
    created_at: Date;
    last_error: string | null;
  }): ContactIntent {
    return {
      id: row.id,
      actionKind: row.action_kind,
      candidateStateId: row.candidate_position_state_id,
      candidateId: row.candidate_id,
      taskId: row.task_id,
      candidateName: row.candidate_name,
      positionName: row.position_name,
      bossAccountId: row.boss_account_id,
      templateVersionId: row.template_version_id,
      providerJobId: row.provider_job_id,
      providerGreetingId: row.provider_greeting_id,
      renderedMessage: row.rendered_message,
      renderedMessageSha256: contactMessageSha256(row.rendered_message),
      sourceLocatorSha256: row.source_locator
        ? contactSourceLocatorSha256(row.source_locator)
        : null,
      transportMode: row.transport_mode,
      status: row.status,
      createdBy: row.created_by,
      version: row.version,
      createdAt: iso(row.created_at),
      lastError: row.last_error
    };
  }

  async resolveUncertainContactAsNotSent(input: {
    intentId: string;
    actorId: string;
    expectedVersion: number;
    actionKind: ContactActionKind;
    candidateStateId: string;
    candidateId: string;
    candidateName: string;
    taskId: string;
    bossAccountId: string;
    templateVersionId: string | null;
    providerJobId: string | null;
    providerGreetingId: string | null;
    renderedMessageSha256: string;
    sourceLocatorSha256: string;
  }): Promise<ContactIntent> {
    assertContactActionKind(input.actionKind);
    return this.sql.begin(async (transaction) => {
      const rows = await transaction<
        Array<{
          id: string;
          action_kind: ContactActionKind;
          candidate_position_state_id: string;
          candidate_id: string;
          task_id: string;
          candidate_name: string;
          position_name: string;
          boss_account_id: string;
          source_locator: import("@boss-forge/contracts").CandidateSourceLocator | null;
          template_version_id: string | null;
          provider_job_id: string | null;
          provider_greeting_id: string | null;
          rendered_message: string;
          transport_mode: "fake" | "real";
          status: ContactIntentStatus;
          created_by: string;
          version: number;
          created_at: Date;
          last_error: string | null;
        }>
      >`
        SELECT ci.id, ci.action_kind, ci.candidate_position_state_id,
          c.id AS candidate_id, ci.task_id, c.display_name AS candidate_name,
          p.name AS position_name, p.boss_account_id, snapshot.source_locator,
          ci.template_version_id, ci.provider_job_id, ci.provider_greeting_id,
          ci.rendered_message, ci.transport_mode, ci.status, ci.created_by,
          ci.version, ci.created_at, ci.last_error
        FROM contact_intents ci
        JOIN candidate_position_states cps ON cps.id = ci.candidate_position_state_id
        JOIN candidates c ON c.id = cps.candidate_id
        JOIN positions p ON p.id = cps.position_id
        JOIN candidate_snapshots snapshot ON snapshot.id = cps.latest_snapshot_id
        WHERE ci.id = ${input.intentId}
        FOR UPDATE OF ci
      `;
      const row = rows[0];
      if (!row) throw new Error("Contact intent was not found.");
      if (row.version !== input.expectedVersion) {
        throw new OptimisticLockError(input.expectedVersion, row.version);
      }
      if (row.transport_mode !== "real" || row.status !== "uncertain") {
        throw new Error("Only an uncertain real contact can be verified as not sent.");
      }
      const sourceLocatorSha256 = row.source_locator
        ? contactSourceLocatorSha256(row.source_locator)
        : null;
      if (
        row.action_kind !== input.actionKind ||
        row.candidate_position_state_id !== input.candidateStateId ||
        row.candidate_id !== input.candidateId ||
        row.candidate_name !== input.candidateName ||
        row.task_id !== input.taskId ||
        row.boss_account_id !== input.bossAccountId ||
        row.template_version_id !== input.templateVersionId ||
        row.provider_job_id !== input.providerJobId ||
        row.provider_greeting_id !== input.providerGreetingId ||
        contactMessageSha256(row.rendered_message) !== input.renderedMessageSha256 ||
        sourceLocatorSha256 !== input.sourceLocatorSha256
      ) {
        throw new Error(
          "Uncertain-contact verification attestation no longer matches the stored intent."
        );
      }

      const resolutionMessage =
        "已人工核验：BOSS 中未发现发送记录，可以重新预览并创建联系任务。";
      const reservationRows = await transaction<
        Array<{
          quota_day: string;
          account_scope_id: string;
          position_scope_id: string;
          task_scope_id: string;
          status: "reserved" | "consumed" | "released";
        }>
      >`
        SELECT quota_day::text AS quota_day, account_scope_id, position_scope_id,
          task_scope_id, status
        FROM contact_quota_reservations
        WHERE contact_intent_id = ${row.id}
        FOR UPDATE
      `;
      const reservation = reservationRows[0];
      if (reservation && reservation.status !== "released") {
        const counterColumn = reservation.status === "consumed" ? "used" : "reserved";
        const scopes = [
          ["account", reservation.account_scope_id],
          ["position", reservation.position_scope_id],
          ["task", reservation.task_scope_id]
        ] as const;
        for (const [scopeType, scopeId] of scopes) {
          const releasedCounters =
            counterColumn === "used"
              ? await transaction<{ id: string }[]>`
                  UPDATE quota_counters SET used = used - 1, updated_at = now()
                  WHERE scope_type = ${scopeType} AND scope_id = ${scopeId}
                    AND quota_day = ${reservation.quota_day}::date AND used > 0
                  RETURNING id
                `
              : await transaction<{ id: string }[]>`
                  UPDATE quota_counters SET reserved = reserved - 1, updated_at = now()
                  WHERE scope_type = ${scopeType} AND scope_id = ${scopeId}
                    AND quota_day = ${reservation.quota_day}::date AND reserved > 0
                  RETURNING id
                `;
          if (!releasedCounters[0]) {
            throw new Error(`Verified-not-sent quota counter is missing for ${scopeType}.`);
          }
        }
        await transaction`
          UPDATE contact_quota_reservations
          SET status = 'released', finished_at = now()
          WHERE contact_intent_id = ${row.id} AND status = ${reservation.status}
        `;
      }
      const updatedIntents = await transaction<Array<{ version: number }>>`
        UPDATE contact_intents
        SET status = 'failed', last_error = ${resolutionMessage}, finished_at = now(),
          version = version + 1
        WHERE id = ${row.id} AND status = 'uncertain' AND version = ${input.expectedVersion}
        RETURNING version
      `;
      const resolvedVersion = updatedIntents[0]?.version;
      if (resolvedVersion === undefined) {
        throw new OptimisticLockError(input.expectedVersion, row.version);
      }
      if (row.action_kind === "message") {
        await transaction`
          UPDATE candidate_position_states SET contact_status = 'failed', updated_at = now()
          WHERE id = ${row.candidate_position_state_id}
        `;
      }
      await transaction`
        INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
        VALUES (
          ${randomUUID()}, ${input.actorId}, 'contact.uncertain.resolved_not_sent',
          'contact_intent', ${row.id},
          ${transaction.json({
            candidateStateId: row.candidate_position_state_id,
            candidateId: row.candidate_id,
            candidateName: row.candidate_name,
            taskId: row.task_id,
            bossAccountId: row.boss_account_id,
            actionKind: row.action_kind,
            templateVersionId: row.template_version_id,
            providerJobId: row.provider_job_id,
            providerGreetingId: row.provider_greeting_id,
            renderedMessageSha256: input.renderedMessageSha256,
            sourceLocatorSha256: input.sourceLocatorSha256,
            priorAttemptResultPreserved: "uncertain",
            quotaReservationReleased: Boolean(
              reservation && reservation.status !== "released"
            )
          })}
        )
      `;
      return this.mapContactIntent({
        ...row,
        status: "failed",
        version: resolvedVersion,
        last_error: resolutionMessage
      });
    });
  }

  /** Called only after a fresh, read-only CDP inspection proved an authenticated BOSS page. */
  async recordVerifiedBossAccountHealth(
    bossAccountId: string,
    checkedAt: string
  ): Promise<void> {
    await this.sql`
      INSERT INTO account_health (
        boss_account_id, status, authoritative, reason, checked_at
      ) VALUES (
        ${bossAccountId}, 'healthy', true,
        '发送前已通过 Chromium CDP 实时验证 BOSS 登录', ${checkedAt}
      )
      ON CONFLICT (boss_account_id) DO UPDATE SET
        status = EXCLUDED.status,
        checked_at = EXCLUDED.checked_at,
        authoritative = true,
        reason = EXCLUDED.reason,
        updated_at = now()
      WHERE account_health.authoritative = false
         OR account_health.status = 'healthy'
         OR account_health.status = 'unknown'
    `;
  }

  async claimContactDispatch(
    workerId: string,
    transportMode: "fake" | "real",
    bossAccountId: string
  ): Promise<ContactDispatchJob | null> {
    return this.sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${'contact-pacing:' + bossAccountId}::text, 0))`;
      const busy = await transaction`
        SELECT ci.id FROM contact_intents ci JOIN tasks t ON t.id = ci.task_id JOIN positions p ON p.id = t.position_id
        WHERE p.boss_account_id = ${bossAccountId} AND ci.transport_mode = ${transportMode}
          AND ci.status IN ('processing', 'uncertain') LIMIT 1
      `;
      if (busy[0]) return null;
      const rows = await transaction<
        Array<{
          outbox_event_id: string;
          intent_id: string;
          action_kind: ContactActionKind;
          state_id: string;
          candidate_id: string;
          task_id: string;
          candidate_name: string;
          candidate_fingerprint: string;
          source_reference: string;
          source_locator: import("@boss-forge/contracts").CandidateSourceLocator | null;
          source: "recommend" | "search";
          search_keyword: string | null;
          raw_fields: Record<string, string>;
          source_evidence: string[];
          raw_text: string;
          position_name: string;
          boss_account_id: string;
          boss_job_keyword: string | null;
          boss_job_id: string | null;
          boss_job_name_unique: boolean;
          source_boss_filters: import("@boss-forge/contracts").BossRecommendationFilterPlan | null;
          template_version_id: string | null;
          provider_job_id: string | null;
          provider_greeting_id: string | null;
          rendered_message: string;
          transport_mode: "fake" | "real";
          created_by: string;
          version: number;
          created_at: Date;
          authorization_id: string | null;
          contact_policy_version_id: string | null;
          odoo_database_uuid: string | null;
          odoo_job_id: number | null;
          odoo_applicant_id: number | null;
          attempt_no: number;
        }>
      >`
        SELECT oe.id AS outbox_event_id, ci.id AS intent_id, ci.action_kind,
          ci.candidate_position_state_id AS state_id, c.id AS candidate_id, ci.task_id,
          c.display_name AS candidate_name, c.fingerprint AS candidate_fingerprint,
          snapshot.source_reference, snapshot.source_locator, t.source, t.search_keyword,
          snapshot.raw_fields, snapshot.source_evidence, snapshot.raw_text,
          p.name AS position_name,
          p.boss_account_id,
          CASE WHEN t.source_job_id = p.boss_job_id THEN p.boss_job_keyword
            ELSE COALESCE(t.source_job_name, p.boss_job_keyword) END AS boss_job_keyword,
          t.source_job_id AS boss_job_id,
          CASE WHEN t.source_job_id = p.boss_job_id THEN p.boss_job_name_unique ELSE false END AS boss_job_name_unique,
          t.source_boss_filters, ci.template_version_id,
          ci.provider_job_id, ci.provider_greeting_id, ci.rendered_message,
          ci.transport_mode,
          ci.created_by, ci.version, ci.created_at, ca.id AS authorization_id,
          policy.external_version_id AS contact_policy_version_id,
          ca.odoo_database_uuid, ca.odoo_job_id, ca.odoo_applicant_id,
          oe.attempts + 1 AS attempt_no
        FROM outbox_events oe
        JOIN contact_intents ci ON ci.id = oe.aggregate_id
        JOIN candidate_position_states cps ON cps.id = ci.candidate_position_state_id
        JOIN candidates c ON c.id = cps.candidate_id
        JOIN candidate_snapshots snapshot ON snapshot.id = cps.latest_snapshot_id
        JOIN positions p ON p.id = cps.position_id
        JOIN tasks t ON t.id = ci.task_id
        LEFT JOIN contact_authorizations ca ON ca.id = ci.authorization_id
        LEFT JOIN contact_policy_snapshots policy ON policy.id = ca.contact_policy_snapshot_id
        WHERE oe.status = 'pending' AND oe.event_type = 'contact.requested'
          AND oe.available_at <= now() AND ci.status = 'ready'
          AND ci.transport_mode = ${transportMode}
          AND p.boss_account_id = ${bossAccountId}
          AND p.contact_dispatch_paused = false
          AND NOT EXISTS (
            SELECT 1 FROM contact_intents prior JOIN tasks pt ON pt.id = prior.task_id JOIN positions pp ON pp.id = pt.position_id
            WHERE pp.boss_account_id = ${bossAccountId} AND prior.transport_mode = ${transportMode}
              AND prior.started_at IS NOT NULL AND prior.finished_at IS NOT NULL
              AND prior.started_at + make_interval(secs => greatest(prior.interval_seconds, ci.interval_seconds)) > now()
          )
        ORDER BY oe.created_at ASC
        FOR UPDATE OF oe, ci, p SKIP LOCKED
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) return null;
      const sourceIndex = Number(row.source_reference.split(":")[1]);
      await transaction`
        UPDATE outbox_events SET status = 'processing', attempts = ${row.attempt_no},
          locked_by = ${workerId} WHERE id = ${row.outbox_event_id}
      `;
      await transaction`
        UPDATE contact_intents SET status = 'processing', started_at = now(),
          finished_at = NULL, last_error = NULL, deferred_until = NULL,
          deferred_reason = NULL, version = version + 1
        WHERE id = ${row.intent_id}
      `;
      await transaction`
        INSERT INTO contact_attempts (
          id, contact_intent_id, attempt_no, result, transport
        ) VALUES (
          ${randomUUID()}, ${row.intent_id}, ${row.attempt_no}, 'processing',
          ${row.transport_mode === "fake" ? "fake" : "boss-cli"}
        )
      `;
      return {
        id: row.intent_id,
        actionKind: row.action_kind,
        outboxEventId: row.outbox_event_id,
        candidateStateId: row.state_id,
        candidateId: row.candidate_id,
        candidateName: row.candidate_name,
        candidateTarget: row.candidate_name,
        candidateFingerprint: row.candidate_fingerprint,
        candidateSnapshot: {
          index: Number.isInteger(sourceIndex) && sourceIndex > 0 ? sourceIndex : 1,
          name: row.candidate_name,
          source: row.source,
          ...(row.source_locator ? { sourceLocator: row.source_locator } : {}),
          fields: row.raw_fields,
          evidence: row.source_evidence,
          raw: row.raw_text
        },
        sourceReference: row.source_reference,
        source: row.source,
        searchKeyword: row.search_keyword,
        positionName: row.position_name,
        bossAccountId: row.boss_account_id,
        bossJobKeyword: row.boss_job_keyword,
        bossJobId: row.boss_job_id,
        bossJobNameUnique: row.boss_job_name_unique,
        sourceBossFilters: row.source_boss_filters,
        templateVersionId: row.template_version_id,
        providerJobId: row.provider_job_id,
        providerGreetingId: row.provider_greeting_id,
        authorizationId: row.authorization_id,
        contactPolicyVersionId: row.contact_policy_version_id,
        odooDatabaseUuid: row.odoo_database_uuid,
        odooJobId: row.odoo_job_id === null ? null : Number(row.odoo_job_id),
        odooApplicantId: row.odoo_applicant_id === null ? null : Number(row.odoo_applicant_id),
        taskId: row.task_id,
        renderedMessage: row.rendered_message,
        renderedMessageSha256: contactMessageSha256(row.rendered_message),
        sourceLocatorSha256: row.source_locator
          ? contactSourceLocatorSha256(row.source_locator)
          : null,
        transportMode: row.transport_mode,
        status: "processing",
        createdBy: row.created_by,
        version: row.version + 1,
        createdAt: iso(row.created_at),
        lastError: null,
        attemptNo: row.attempt_no
      };
    });
  }

  async assertContactDispatchAllowed(input: {
    job: ContactDispatchJob;
    now: string;
    localMinuteOfDay: number;
  }): Promise<void> {
    if (!Number.isFinite(Date.parse(input.now))) throw new Error("Contact preflight now is invalid.");
    if (
      !Number.isInteger(input.localMinuteOfDay) ||
      input.localMinuteOfDay < 0 ||
      input.localMinuteOfDay > 1_439
    ) {
      throw new Error("Contact preflight localMinuteOfDay must be between 0 and 1439.");
    }
    await this.sql.begin(async (transaction) => {
      const rows = await transaction<
        Array<{
          intent_id: string;
          action_kind: ContactActionKind;
          authorization_id: string | null;
          intent_policy_snapshot_id: string | null;
          manual_policy_snapshot: unknown;
          template_version_id: string | null;
          provider_job_id: string | null;
          provider_greeting_id: string | null;
          rendered_message: string;
          transport_mode: "fake" | "real";
          task_id: string;
          task_status: string;
          source: "recommend" | "search";
          state_id: string;
          candidate_id: string;
          candidate_name: string;
          position_id: string;
          position_name: string;
          department_id: string;
          position_status: "active" | "paused" | "closed";
          position_auto_contact: boolean;
          boss_account_id: string;
          review_status: "pending" | "approved" | "rejected" | "not_required";
          resume_screening_status:
            | "not_requested"
            | "queued"
            | "processing"
            | "screened"
            | "no_text"
            | "failed";
          is_current: boolean;
          rule_version_external_id: string | null;
          same_position_sent: boolean;
          same_position_active: boolean;
          last_cross_position_contact_at: Date | null;
          account_has_uncertain: boolean;
          legacy_emergency_stop: boolean;
          internal_quotas_enabled: boolean;
          account_daily_limit: number;
          default_position_daily_limit: number;
          default_task_limit: number;
          default_allowed_start_minute: number;
          default_allowed_end_minute: number;
          default_cross_position_cooldown_hours: number;
          policy_auto_contact: boolean | null;
          policy_daily_limit: number | null;
          policy_allowed_start_minute: number | null;
          policy_allowed_end_minute: number | null;
          policy_cross_position_cooldown_hours: number | null;
          policy_stop_on_uncertain: boolean | null;
          account_health_status: "healthy" | "degraded" | "blocked" | "unknown" | null;
          account_health_authoritative: boolean | null;
          account_health_checked_at: Date | null;
          source_locator: import("@boss-forge/contracts").CandidateSourceLocator | null;
          creator_status: "active" | "disabled" | null;
          creator_role: "admin" | "recruiting_lead" | "recruiter" | "interviewer" | null;
          creator_department_id: string | null;
          creator_has_position_access: boolean;
        }>
      >`
        SELECT ci.id AS intent_id, ci.action_kind, ci.authorization_id,
          ci.contact_policy_snapshot_id AS intent_policy_snapshot_id,
          ci.policy_snapshot AS manual_policy_snapshot, ci.template_version_id,
          ci.provider_job_id, ci.provider_greeting_id,
          ci.rendered_message, ci.transport_mode, ci.task_id, t.status AS task_status,
          t.source,
          cps.id AS state_id, cps.candidate_id, c.display_name AS candidate_name,
          p.id AS position_id, p.name AS position_name,
          p.department_id, p.status AS position_status,
          p.auto_contact_after_review AS position_auto_contact,
          p.boss_account_id, cps.review_status, cps.resume_screening_status,
          cps.is_current,
          rv.external_version_id AS rule_version_external_id,
          EXISTS (
            SELECT 1 FROM contact_intents same_ci
            JOIN candidate_position_states same_cps
              ON same_cps.id = same_ci.candidate_position_state_id
            WHERE same_cps.candidate_id = cps.candidate_id
              AND same_cps.position_id = cps.position_id
              AND same_ci.action_kind = ci.action_kind
              AND same_ci.id <> ci.id AND same_ci.status = 'sent'
          ) AS same_position_sent,
          EXISTS (
            SELECT 1 FROM contact_intents active_ci
            JOIN candidate_position_states active_cps
              ON active_cps.id = active_ci.candidate_position_state_id
            WHERE active_cps.candidate_id = cps.candidate_id
              AND active_cps.position_id = cps.position_id
              AND active_ci.action_kind = ci.action_kind
              AND active_ci.id <> ci.id
              AND active_ci.status IN ('ready', 'processing', 'uncertain')
          ) AS same_position_active,
          (
            SELECT MAX(cross_ci.finished_at) FROM contact_intents cross_ci
            JOIN candidate_position_states cross_cps
              ON cross_cps.id = cross_ci.candidate_position_state_id
            WHERE cross_cps.candidate_id = cps.candidate_id
              AND cross_cps.position_id <> cps.position_id
              AND cross_ci.status = 'sent'
          ) AS last_cross_position_contact_at,
          EXISTS (
            SELECT 1 FROM contact_intents uncertain_ci
            JOIN candidate_position_states uncertain_cps
              ON uncertain_cps.id = uncertain_ci.candidate_position_state_id
            JOIN positions uncertain_position ON uncertain_position.id = uncertain_cps.position_id
            WHERE uncertain_position.boss_account_id = p.boss_account_id
              AND uncertain_ci.id <> ci.id AND uncertain_ci.status = 'uncertain'
              AND uncertain_ci.transport_mode = 'real'
          ) AS account_has_uncertain,
          settings.emergency_stop AS legacy_emergency_stop, settings.internal_quotas_enabled, settings.account_daily_limit,
          settings.position_daily_limit AS default_position_daily_limit,
          settings.task_limit AS default_task_limit,
          settings.allowed_start_minute AS default_allowed_start_minute,
          settings.allowed_end_minute AS default_allowed_end_minute,
          settings.cross_position_cooldown_hours AS default_cross_position_cooldown_hours,
          policy.auto_contact_after_review AS policy_auto_contact,
          policy.daily_limit AS policy_daily_limit,
          policy.allowed_start_minute AS policy_allowed_start_minute,
          policy.allowed_end_minute AS policy_allowed_end_minute,
          policy.cross_position_cooldown_hours AS policy_cross_position_cooldown_hours,
          policy.stop_on_uncertain AS policy_stop_on_uncertain,
          health.status AS account_health_status,
          health.authoritative AS account_health_authoritative,
          health.checked_at AS account_health_checked_at,
          snapshot.source_locator,
          creator.status AS creator_status, creator.role AS creator_role,
          creator.department_id AS creator_department_id,
          EXISTS (
            SELECT 1 FROM position_members membership
            WHERE membership.position_id = p.id AND membership.user_id = creator.id
          ) AS creator_has_position_access
        FROM contact_intents ci
        JOIN candidate_position_states cps ON cps.id = ci.candidate_position_state_id
        JOIN candidates c ON c.id = cps.candidate_id
        JOIN candidate_snapshots snapshot ON snapshot.id = cps.latest_snapshot_id
        JOIN positions p ON p.id = cps.position_id
        JOIN tasks t ON t.id = ci.task_id
        JOIN rule_versions rv ON rv.id = cps.rule_version_id
        JOIN contact_settings settings ON settings.id = 'global'
        LEFT JOIN contact_policy_snapshots policy
          ON policy.id = ci.contact_policy_snapshot_id
        LEFT JOIN account_health health ON health.boss_account_id = p.boss_account_id
        LEFT JOIN users creator ON creator.id::text = ci.created_by
        WHERE ci.id = ${input.job.id} AND ci.status = 'processing'
          AND ci.action_kind = ${input.job.actionKind}
          AND ci.candidate_position_state_id = ${input.job.candidateStateId}
          AND cps.candidate_id = ${input.job.candidateId}
          AND ci.task_id = ${input.job.taskId}
          AND ci.transport_mode = ${input.job.transportMode}
          AND ci.template_version_id IS NOT DISTINCT FROM ${input.job.templateVersionId}
          AND ci.provider_job_id IS NOT DISTINCT FROM ${input.job.providerJobId}
          AND ci.provider_greeting_id IS NOT DISTINCT FROM ${input.job.providerGreetingId}
          AND ci.rendered_message = ${input.job.renderedMessage}
          AND t.source = ${input.job.source}
          AND p.boss_account_id = ${input.job.bossAccountId}
          AND ci.version = ${input.job.version}
        FOR UPDATE OF ci, cps, p
      `;
      const context = rows[0];
      if (!context) {
        throw new ContactDispatchPolicyError({
          disposition: "failed",
          reasons: ["dispatch_context_changed"]
        });
      }

      const reasons: string[] = [];
      if (context.legacy_emergency_stop) reasons.push("legacy_emergency_stop");
      if (
        context.creator_status !== "active" ||
        !context.creator_role ||
        !["admin", "recruiting_lead", "recruiter"].includes(context.creator_role)
      ) {
        reasons.push("intent_creator_not_authorized");
      } else if (context.creator_department_id !== context.department_id) {
        reasons.push("intent_creator_department_changed");
      } else if (
        context.creator_role === "recruiter" &&
        !context.creator_has_position_access
      ) {
        reasons.push("intent_creator_position_access_revoked");
      }

      await transaction`
        SELECT pg_advisory_xact_lock(hashtextextended(${context.candidate_id}::text, 0))
      `;

      const requiredControlScopes = [
        ["global", "global"],
        ["department", context.department_id],
        ["position", context.position_id],
        ["task", context.task_id]
      ] as const;
      const controls = await transaction<
        Array<{
          scope_type: "global" | "department" | "position" | "task";
          scope_id: string;
          enabled: boolean;
          approval_required: boolean;
          approved_at: Date | null;
          emergency_stop: boolean;
          approver_status: "active" | "disabled" | null;
          approver_role: "admin" | "recruiting_lead" | "recruiter" | "interviewer" | null;
          approver_department_id: string | null;
        }>
      >`
        SELECT scope_type, scope_id, enabled, approval_required, approved_at,
          emergency_stop, approver.status AS approver_status,
          approver.role AS approver_role,
          approver.department_id AS approver_department_id
        FROM contact_controls control
        LEFT JOIN users approver ON approver.id = control.approved_by
        WHERE (scope_type = 'global' AND scope_id = 'global')
          OR (scope_type = 'department' AND scope_id = ${context.department_id})
          OR (scope_type = 'position' AND scope_id = ${context.position_id})
          OR (scope_type = 'task' AND scope_id = ${context.task_id})
        FOR UPDATE OF control
      `;
      for (const [scopeType, scopeId] of requiredControlScopes) {
        const control = controls.find(
          (item) => item.scope_type === scopeType && item.scope_id === scopeId
        );
        if (!control) {
          reasons.push(`contact_control_${scopeType}_missing`);
          continue;
        }
        if (!control.enabled) reasons.push(`contact_control_${scopeType}_disabled`);
        if (control.emergency_stop) {
          reasons.push(`contact_control_${scopeType}_emergency_stop`);
        }
        if (control.approval_required) {
          if (!control.approved_at) {
            reasons.push(`contact_control_${scopeType}_approval_missing`);
          } else if (
            control.approver_status !== "active" ||
            !["admin", "recruiting_lead"].includes(control.approver_role ?? "") ||
            control.approver_department_id !== context.department_id
          ) {
            reasons.push(`contact_control_${scopeType}_approval_invalid`);
          }
        }
      }

      const currentDoNotContact = Boolean((await transaction`
        SELECT candidate_id
        FROM do_not_contact
        WHERE candidate_id = ${context.candidate_id} AND active = true
        FOR UPDATE
      `)[0]);
      if (currentDoNotContact) reasons.push("do_not_contact");
      if (context.position_status === "paused") reasons.push("job_paused");
      if (context.position_status === "closed") reasons.push("job_closed");
      if (["failed", "cancelled"].includes(context.task_status)) reasons.push("task_not_active");
      if (!context.is_current) reasons.push("current_candidate_state");
      if (context.review_status !== "approved") reasons.push("manual_review_required");
      if (["not_requested", "queued", "processing"].includes(context.resume_screening_status)) {
        reasons.push("resume_screening_incomplete");
      }
      if (context.same_position_sent) reasons.push("same_position_already_contacted");
      if (context.same_position_active) {
        reasons.push("same_position_contact_already_active");
      }
      if (context.transport_mode === "real") {
        const policySnapshot =
          context.manual_policy_snapshot &&
          typeof context.manual_policy_snapshot === "object" &&
          !Array.isArray(context.manual_policy_snapshot)
            ? (context.manual_policy_snapshot as Record<string, unknown>)
            : null;
        const approvalValue = policySnapshot?.contactPreviewApproval;
        const approvalToken = policySnapshot?.contactPreviewApprovalToken;
        if (
          approvalValue === null ||
          approvalValue === undefined ||
          typeof approvalToken !== "string" ||
          !approvalToken
        ) {
          reasons.push("contact_preview_approval_missing");
        } else if (!context.source_locator) {
          reasons.push("stable_candidate_locator_missing");
        } else {
          try {
            const signedApproval = verifyContactDispatchApproval({
              intentId: input.job.id,
              queueToken: policySnapshot?.contactQueueApprovalToken,
              token: approvalToken,
              signingKey: contactPreviewApprovalSigningKeyFromEnvironment(process.env),
              expected: {
                actionKind: context.action_kind,
                approvedBy: input.job.createdBy,
                candidateStateId: context.state_id,
                candidateId: context.candidate_id,
                candidateName: context.candidate_name,
                positionId: context.position_id,
                positionName: context.position_name,
                taskId: context.task_id,
                bossAccountId: context.boss_account_id,
                source: context.source,
                sourceLocator: context.source_locator,
                templateVersionId: context.template_version_id,
                providerJobId: context.provider_job_id,
                providerGreetingId: context.provider_greeting_id,
                renderedMessage: context.rendered_message
              },
              now: new Date(input.now)
            });
            if (!sameContactPreviewApproval(approvalValue, signedApproval)) {
              reasons.push("contact_preview_approval_binding_changed");
            }
          } catch (error: unknown) {
            if (error instanceof ContactPreviewApprovalConfigurationError) {
              reasons.push("contact_preview_approval_signing_key_unavailable");
            } else if (error instanceof ContactQueueApprovalExpiredError) {
              reasons.push("contact_queue_approval_expired");
            } else if (
              !policySnapshot?.contactQueueApprovalToken &&
              isContactPreviewApproval(approvalValue) &&
              Date.parse(approvalValue.expiresAt) <= Date.parse(input.now)
            ) {
              reasons.push("contact_preview_approval_expired");
            } else {
              reasons.push("contact_preview_approval_signature_invalid");
            }
          }
        }
      }
      if (context.authorization_id !== input.job.authorizationId) {
        reasons.push("dispatch_context_changed");
      }
      const expectedLocator = input.job.candidateSnapshot.sourceLocator;
      if (context.transport_mode === "real" && (!expectedLocator || !context.source_locator)) {
        reasons.push("stable_candidate_locator_missing");
      } else if (
        expectedLocator &&
        context.source_locator &&
        (expectedLocator.kind !== context.source_locator.kind ||
          expectedLocator.value !== context.source_locator.value)
      ) {
        reasons.push("stable_candidate_locator_changed");
      }

      let allowedStartMinute = context.default_allowed_start_minute;
      let allowedEndMinute = context.default_allowed_end_minute;
      let crossPositionCooldownHours = context.default_cross_position_cooldown_hours;
      let positionDailyLimit = context.default_position_daily_limit;
      let taskDailyLimit = context.default_task_limit;
      let stopOnUncertain = true;

      if (context.authorization_id) {
        const authorizationRows = await transaction<
          Array<{
            status: "authorized" | "revoked" | "consumed" | "expired";
            authorization_expires_at: Date | null;
            do_not_contact: boolean;
            transport_mode: "fake" | "real";
            boss_account_id: string;
            rule_version_external_id: string;
            rendered_message: string;
            contact_policy_snapshot_id: string | null;
            odoo_database_uuid: string;
            odoo_job_id: number;
            odoo_applicant_id: number;
            contact_policy_version_id: string | null;
          }>
        >`
          SELECT status, authorization_expires_at, do_not_contact, transport_mode,
            boss_account_id, rule_version_external_id, rendered_message,
            ca.contact_policy_snapshot_id, ca.odoo_database_uuid, ca.odoo_job_id,
            ca.odoo_applicant_id, policy.external_version_id AS contact_policy_version_id
          FROM contact_authorizations ca
          LEFT JOIN contact_policy_snapshots policy ON policy.id = ca.contact_policy_snapshot_id
          WHERE ca.id = ${context.authorization_id}
          FOR UPDATE OF ca
        `;
        const authorization = authorizationRows[0];
        if (!authorization) {
          reasons.push("authorization_missing");
        } else {
          if (!["authorized", "consumed"].includes(authorization.status)) {
            reasons.push(`authorization_${authorization.status}`);
          }
          if (
            !authorization.authorization_expires_at ||
            authorization.authorization_expires_at.getTime() <= Date.parse(input.now)
          ) {
            reasons.push("authorization_expired");
          }
          if (authorization.do_not_contact) reasons.push("do_not_contact");
          if (authorization.transport_mode !== context.transport_mode) {
            reasons.push("transport_mode_changed");
          }
          if (authorization.boss_account_id !== context.boss_account_id) {
            reasons.push("boss_account_changed");
          }
          if (authorization.rule_version_external_id !== context.rule_version_external_id) {
            reasons.push("rule_version_changed");
          }
          if (authorization.rendered_message !== context.rendered_message) {
            reasons.push("rendered_message_changed");
          }
          if (
            !authorization.contact_policy_snapshot_id ||
            authorization.contact_policy_snapshot_id !== context.intent_policy_snapshot_id
          ) {
            reasons.push("contact_policy_snapshot_changed");
          }
          if (
            input.job.odooDatabaseUuid !== authorization.odoo_database_uuid ||
            input.job.odooJobId !== Number(authorization.odoo_job_id) ||
            input.job.odooApplicantId !== Number(authorization.odoo_applicant_id) ||
            input.job.contactPolicyVersionId !== authorization.contact_policy_version_id
          ) {
            reasons.push("dispatch_context_changed");
          }
        }
        if (context.policy_daily_limit === null) reasons.push("contact_policy_snapshot_missing");
        if (!context.position_auto_contact) reasons.push("job_auto_contact_disabled");
        if (!context.policy_auto_contact) reasons.push("policy_auto_contact_disabled");
        allowedStartMinute =
          context.policy_allowed_start_minute ?? context.default_allowed_start_minute;
        allowedEndMinute = context.policy_allowed_end_minute ?? context.default_allowed_end_minute;
        crossPositionCooldownHours =
          context.policy_cross_position_cooldown_hours ??
          context.default_cross_position_cooldown_hours;
        positionDailyLimit = context.policy_daily_limit ?? context.default_position_daily_limit;
        taskDailyLimit = context.policy_daily_limit ?? context.default_task_limit;
        stopOnUncertain = context.policy_stop_on_uncertain ?? true;
      }

      if (
        isInsideCooldown(input.now, context.last_cross_position_contact_at, crossPositionCooldownHours)
      ) {
        reasons.push("cross_position_cooldown");
      }
      if (
        context.transport_mode === "real" &&
        stopOnUncertain &&
        context.account_has_uncertain
      ) {
        reasons.push("uncertain_previous_send");
      }
      if (!isWithinAllowedWindow(input.localMinuteOfDay, allowedStartMinute, allowedEndMinute)) {
        reasons.push("outside_allowed_hours");
      }

      const quotaDayRows = await transaction<Array<{ quota_day: string }>>`
        SELECT ((${input.now}::timestamptz AT TIME ZONE 'Asia/Shanghai')::date)::text AS quota_day
      `;
      const quotaDay = quotaDayRows[0]!.quota_day;
      const scopes = [
        ["account", context.boss_account_id],
        ["position", context.position_id],
        ["task", context.task_id]
      ] as const;
      for (const [scopeType, scopeId] of scopes) {
        await transaction`
          INSERT INTO quota_counters (id, scope_type, scope_id, quota_day, used, reserved)
          VALUES (${randomUUID()}, ${scopeType}, ${scopeId}, ${quotaDay}::date, 0, 0)
          ON CONFLICT (scope_type, scope_id, quota_day) DO NOTHING
        `;
      }
      const quotaRows = await transaction<
        Array<{ scope_type: "account" | "position" | "task"; used: number; reserved: number }>
      >`
        SELECT scope_type, used, reserved
        FROM quota_counters
        WHERE quota_day = ${quotaDay}::date
          AND (
            (scope_type = 'account' AND scope_id = ${context.boss_account_id}) OR
            (scope_type = 'position' AND scope_id = ${context.position_id}) OR
            (scope_type = 'task' AND scope_id = ${context.task_id})
          )
        ORDER BY scope_type
        FOR UPDATE
      `;
      const usage = new Map(
        quotaRows.map((row) => [row.scope_type, Number(row.used) + Number(row.reserved)])
      );
      const reservationRows = await transaction<Array<{ status: string }>>`
        SELECT status FROM contact_quota_reservations
        WHERE contact_intent_id = ${context.intent_id}
        FOR UPDATE
      `;
      const reservationStatus = reservationRows[0]?.status;
      const alreadyReserved = reservationStatus === "reserved";
      if (reservationStatus && !alreadyReserved) reasons.push(`quota_reservation_${reservationStatus}`);
      if (!alreadyReserved && context.internal_quotas_enabled !== false) {
        if (context.account_daily_limit <= 0 || (usage.get("account") ?? 0) >= context.account_daily_limit) {
          reasons.push("account_daily_limit");
        }
        if (positionDailyLimit <= 0 || (usage.get("position") ?? 0) >= positionDailyLimit) {
          reasons.push("position_daily_limit");
        }
        if (taskDailyLimit <= 0 || (usage.get("task") ?? 0) >= taskDailyLimit) {
          reasons.push("task_limit");
        }
      }

      if (context.transport_mode === "real") {
        const configuredDispatchMode = contactDispatchModeFromEnvironment(process.env);
        if (configuredDispatchMode !== context.transport_mode) {
          reasons.push(
            configuredDispatchMode === "disabled"
              ? "contact_dispatch_disabled"
              : "contact_dispatch_mode_mismatch"
          );
        }
        if (
          contactSideEffectsModeFromEnvironment(process.env) !== "real_greet_enabled"
        ) {
          reasons.push("real_contact_circuit_open");
        }
        const configuredHealthMaxAgeMs = Number(
          process.env.BOSS_FORGE_ACCOUNT_HEALTH_MAX_AGE_MS ?? "1800000"
        );
        const healthMaxAgeMs =
          Number.isFinite(configuredHealthMaxAgeMs) && configuredHealthMaxAgeMs >= 60_000
            ? configuredHealthMaxAgeMs
            : 1_800_000;
        if (
          !context.account_health_authoritative ||
          context.account_health_status !== "healthy"
        ) {
          reasons.push("authoritative_boss_account_health_unavailable");
        } else if (
          !context.account_health_checked_at ||
          Date.parse(input.now) - context.account_health_checked_at.getTime() > healthMaxAgeMs
        ) {
          reasons.push("authoritative_boss_account_health_stale");
        }
      } else {
        const configuredDispatchMode = contactDispatchModeFromEnvironment(process.env);
        if (configuredDispatchMode !== context.transport_mode) {
          reasons.push(
            configuredDispatchMode === "disabled"
              ? "contact_dispatch_disabled"
              : "contact_dispatch_mode_mismatch"
          );
        }
      }
      if (reasons.length > 0) {
        throw contactBlockError({
          reasons,
          now: input.now,
          allowedStartMinute,
          allowedEndMinute,
          lastCrossPositionContactAt: context.last_cross_position_contact_at,
          crossPositionCooldownHours
        });
      }

      if (context.transport_mode === "real" && !alreadyReserved) {
        await transaction`
          INSERT INTO contact_quota_reservations (
            contact_intent_id, quota_day, account_scope_id, position_scope_id, task_scope_id
          ) VALUES (
            ${context.intent_id}, ${quotaDay}::date, ${context.boss_account_id},
            ${context.position_id}, ${context.task_id}
          )
        `;
        for (const [scopeType, scopeId] of scopes) {
          await transaction`
            UPDATE quota_counters SET reserved = reserved + 1, updated_at = now()
            WHERE scope_type = ${scopeType} AND scope_id = ${scopeId}
              AND quota_day = ${quotaDay}::date
          `;
        }
      }
    });
  }

  async deferContactDispatch(input: {
    job: ContactDispatchJob;
    availableAt: string;
    reason: string;
  }): Promise<void> {
    const availableAt = new Date(input.availableAt);
    if (!Number.isFinite(availableAt.getTime())) {
      throw new Error("Deferred contact availableAt must be a valid date.");
    }
    await this.sql.begin(async (transaction) => {
      const lockedIntents = await transaction<{ id: string }[]>`
        SELECT id FROM contact_intents
        WHERE id = ${input.job.id} AND status = 'processing'
          AND action_kind = ${input.job.actionKind}
          AND version = ${input.job.version}
        FOR UPDATE
      `;
      if (!lockedIntents[0]) {
        throw new Error("Processing contact intent was not found during deferral.");
      }
      const reservationRows = await transaction<
        Array<{
          quota_day: string;
          account_scope_id: string;
          position_scope_id: string;
          task_scope_id: string;
          status: "reserved" | "consumed" | "released";
        }>
      >`
        SELECT quota_day::text AS quota_day, account_scope_id, position_scope_id,
          task_scope_id, status
        FROM contact_quota_reservations
        WHERE contact_intent_id = ${input.job.id}
        FOR UPDATE
      `;
      const reservation = reservationRows[0];
      if (reservation?.status === "reserved") {
        const scopes = [
          ["account", reservation.account_scope_id],
          ["position", reservation.position_scope_id],
          ["task", reservation.task_scope_id]
        ] as const;
        for (const [scopeType, scopeId] of scopes) {
          const releasedCounters = await transaction<{ id: string }[]>`
            UPDATE quota_counters SET reserved = reserved - 1, updated_at = now()
            WHERE scope_type = ${scopeType} AND scope_id = ${scopeId}
              AND quota_day = ${reservation.quota_day}::date AND reserved > 0
            RETURNING id
          `;
          if (!releasedCounters[0]) {
            throw new Error(`Deferred quota reservation counter is missing for ${scopeType}.`);
          }
        }
      }
      if (reservation) {
        await transaction`
          DELETE FROM contact_quota_reservations
          WHERE contact_intent_id = ${input.job.id}
        `;
      }
      await transaction`
        UPDATE contact_attempts SET result = 'deferred', error_message = ${input.reason},
          finished_at = now()
        WHERE contact_intent_id = ${input.job.id}
          AND attempt_no = ${input.job.attemptNo} AND result = 'processing'
      `;
      await transaction`
        UPDATE contact_intents SET status = 'ready', started_at = NULL, finished_at = NULL,
          last_error = ${input.reason}, deferred_until = ${availableAt},
          deferred_reason = ${input.reason}, version = version + 1
        WHERE id = ${input.job.id} AND status = 'processing'
          AND action_kind = ${input.job.actionKind}
          AND version = ${input.job.version}
      `;
      await transaction`
        UPDATE outbox_events SET status = 'pending', available_at = ${availableAt},
          locked_by = NULL, last_error = ${input.reason}, finished_at = NULL
        WHERE id = ${input.job.outboxEventId}
      `;
      if (input.job.actionKind === "message") {
        await transaction`
          UPDATE candidate_position_states SET contact_status = 'queued', updated_at = now()
          WHERE id = ${input.job.candidateStateId}
        `;
      }
      await transaction`
        INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
        VALUES (${randomUUID()}, ${input.job.createdBy}, 'contact.deferred',
          'contact_intent', ${input.job.id},
          ${transaction.json({
            actionKind: input.job.actionKind,
            attemptNo: input.job.attemptNo,
            availableAt: availableAt.toISOString(),
            reason: input.reason
          })})
      `;
    });
  }

  async finishContactDispatch(input: {
    job: ContactDispatchJob;
    result: ContactDispatchResult;
    externalMessage?: string | null;
    errorMessage?: string | null;
  }): Promise<void> {
    if (input.job.transportMode === "fake" && input.result === "sent") {
      throw new Error("Fake contact dispatch cannot be recorded as sent.");
    }
    if (input.job.transportMode === "real" && input.result === "simulated") {
      throw new Error("Real contact dispatch cannot be recorded as simulated.");
    }
    await this.sql.begin(async (transaction) => {
      const lockedIntents = await transaction<{ id: string }[]>`
        SELECT id FROM contact_intents
        WHERE id = ${input.job.id} AND status = 'processing'
          AND action_kind = ${input.job.actionKind}
          AND version = ${input.job.version}
        FOR UPDATE
      `;
      if (!lockedIntents[0]) {
        throw new Error(
          "Processing contact intent was not found during completion; a terminal result cannot be overwritten."
        );
      }
      const attemptRows = await transaction<{ id: string }[]>`
        SELECT id FROM contact_attempts
        WHERE contact_intent_id = ${input.job.id}
          AND attempt_no = ${input.job.attemptNo} AND result = 'processing'
        FOR UPDATE
      `;
      if (!attemptRows[0]) {
        throw new Error(
          "Processing contact attempt was not found during completion; a terminal result cannot be overwritten."
        );
      }
      const reservationRows = await transaction<
        Array<{
          quota_day: string;
          account_scope_id: string;
          position_scope_id: string;
          task_scope_id: string;
          status: "reserved" | "consumed" | "released";
        }>
      >`
        SELECT quota_day::text AS quota_day, account_scope_id, position_scope_id,
          task_scope_id, status
        FROM contact_quota_reservations
        WHERE contact_intent_id = ${input.job.id}
        FOR UPDATE
      `;
      const reservation = reservationRows[0];
      const consumesQuota =
        input.result === "sent" ||
        (input.job.transportMode === "real" && input.result === "uncertain");
      if (consumesQuota) {
        if (input.job.transportMode !== "real") {
          throw new Error("Only a real contact dispatch can consume delivery quota.");
        }
        if (!reservation || !["reserved", "consumed"].includes(reservation.status)) {
          throw new Error("Real contact completion has no valid atomic quota reservation.");
        }
        if (reservation.status === "reserved") {
          const scopes = [
            ["account", reservation.account_scope_id],
            ["position", reservation.position_scope_id],
            ["task", reservation.task_scope_id]
          ] as const;
          for (const [scopeType, scopeId] of scopes) {
            const updatedCounters = await transaction<{ id: string }[]>`
              UPDATE quota_counters
              SET reserved = reserved - 1, used = used + 1, updated_at = now()
              WHERE scope_type = ${scopeType} AND scope_id = ${scopeId}
                AND quota_day = ${reservation.quota_day}::date AND reserved > 0
              RETURNING id
            `;
            if (!updatedCounters[0]) {
              throw new Error(`Quota reservation counter is missing for ${scopeType}.`);
            }
          }
          await transaction`
            UPDATE contact_quota_reservations
            SET status = 'consumed', finished_at = now()
            WHERE contact_intent_id = ${input.job.id} AND status = 'reserved'
          `;
        }
      } else if (reservation?.status === "reserved") {
        const scopes = [
          ["account", reservation.account_scope_id],
          ["position", reservation.position_scope_id],
          ["task", reservation.task_scope_id]
        ] as const;
        for (const [scopeType, scopeId] of scopes) {
          const releasedCounters = await transaction<{ id: string }[]>`
            UPDATE quota_counters SET reserved = reserved - 1, updated_at = now()
            WHERE scope_type = ${scopeType} AND scope_id = ${scopeId}
              AND quota_day = ${reservation.quota_day}::date AND reserved > 0
            RETURNING id
          `;
          if (!releasedCounters[0]) {
            throw new Error(`Quota reservation counter is missing for ${scopeType}.`);
          }
        }
        await transaction`
          UPDATE contact_quota_reservations
          SET status = 'released', finished_at = now()
          WHERE contact_intent_id = ${input.job.id} AND status = 'reserved'
        `;
      }
      const updatedAttempts = await transaction<{ id: string }[]>`
        UPDATE contact_attempts SET result = ${input.result},
          external_message = ${input.externalMessage ?? null},
          error_message = ${input.errorMessage ?? null}, finished_at = now()
        WHERE contact_intent_id = ${input.job.id} AND attempt_no = ${input.job.attemptNo}
          AND result = 'processing'
        RETURNING id
      `;
      if (!updatedAttempts[0]) {
        throw new Error("Contact attempt changed before completion; terminal state was preserved.");
      }
      const updatedIntents = await transaction<Array<{ version: number }>>`
        UPDATE contact_intents SET status = ${input.result},
          last_error = ${input.errorMessage ?? null}, finished_at = now(),
          deferred_until = NULL, deferred_reason = NULL, version = version + 1
        WHERE id = ${input.job.id} AND status = 'processing'
          AND action_kind = ${input.job.actionKind}
          AND version = ${input.job.version}
        RETURNING version
      `;
      const intentVersion = updatedIntents[0]?.version;
      if (intentVersion === undefined) {
        throw new Error("Contact intent changed before completion; terminal state was preserved.");
      }
      if (input.job.actionKind === "message") {
        await transaction`
          UPDATE candidate_position_states SET contact_status = ${input.result}, updated_at = now()
          WHERE id = ${input.job.candidateStateId}
        `;
      }
      await transaction`
        UPDATE outbox_events SET status = ${input.result === "failed" ? "failed" : "completed"},
          last_error = ${input.errorMessage ?? null}, finished_at = now()
        WHERE id = ${input.job.outboxEventId}
      `;
      await transaction`
        INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
        VALUES (${randomUUID()}, ${input.job.createdBy}, ${`contact.${input.result}`},
          'contact_intent', ${input.job.id},
          ${transaction.json({
            actionKind: input.job.actionKind,
            attemptNo: input.job.attemptNo,
            error: input.errorMessage ?? null
          })})
      `;
      const authorizationRows = await transaction<
        Array<{
          authorization_id: string;
          correlation_id: string;
          odoo_applicant_id: number;
          odoo_database_uuid: string;
          odoo_job_id: number;
          boss_account_id: string;
          transport_mode: "fake" | "real";
          contact_policy_version_id: string;
        }>
      >`
        SELECT ca.id AS authorization_id, ca.correlation_id,
          ca.odoo_applicant_id, ca.odoo_database_uuid, ca.odoo_job_id,
          ca.boss_account_id, ci.transport_mode,
          policy.external_version_id AS contact_policy_version_id
        FROM contact_intents ci
        JOIN contact_authorizations ca ON ca.id = ci.authorization_id
        JOIN contact_policy_snapshots policy ON policy.id = ca.contact_policy_snapshot_id
        WHERE ci.id = ${input.job.id}
      `;
      const authorization = authorizationRows[0];
      if (authorization) {
        if (
          input.job.authorizationId !== authorization.authorization_id ||
          input.job.odooDatabaseUuid !== authorization.odoo_database_uuid ||
          input.job.odooJobId !== Number(authorization.odoo_job_id) ||
          input.job.odooApplicantId !== Number(authorization.odoo_applicant_id) ||
          input.job.bossAccountId !== authorization.boss_account_id ||
          input.job.contactPolicyVersionId !== authorization.contact_policy_version_id ||
          input.job.transportMode !== authorization.transport_mode
        ) {
          throw new Error("Contact integration context changed before completion.");
        }
        const eventType = ({
          sent: "contact.sent.v1",
          simulated: "contact.simulated.v1",
          failed: "contact.failed.v1",
          uncertain: "contact.uncertain.v1"
        } as const)[input.result];
        await enqueueIntegrationEvent(transaction, {
          deduplicationKey: `contact:${input.job.id}:${input.result}:${input.job.attemptNo}`,
          correlationId: authorization.correlation_id,
          eventType,
          aggregateType: "contact_intent",
          aggregateId: input.job.id,
          aggregateVersion: intentVersion,
          payload: {
            contactIntentId: input.job.id,
            actionKind: input.job.actionKind,
            odooDatabaseUuid: authorization.odoo_database_uuid,
            odooJobId: Number(authorization.odoo_job_id),
            authorizationId: authorization.authorization_id,
            candidateStateId: input.job.candidateStateId,
            odooApplicantId: Number(authorization.odoo_applicant_id),
            bossAccountId: authorization.boss_account_id,
            transportMode: authorization.transport_mode,
            contactPolicyVersionId: authorization.contact_policy_version_id,
            status: input.result,
            attemptNo: input.job.attemptNo,
            externalMessage: input.externalMessage ?? null,
            errorMessage: input.errorMessage ?? null
          }
        });
      }
    });
  }

  async recoverStaleContactDispatches(
    bossAccountId: string,
    transportMode: "fake" | "real"
  ): Promise<number> {
    const staleRows = await this.sql<Array<{ id: string }>>`
      SELECT ci.id
      FROM contact_intents ci
      JOIN candidate_position_states cps ON cps.id = ci.candidate_position_state_id
      JOIN positions p ON p.id = cps.position_id
      WHERE ci.status = 'processing'
        AND ci.started_at < now() - interval '10 minutes'
        AND ci.transport_mode = ${transportMode}
        AND p.boss_account_id = ${bossAccountId}
      ORDER BY ci.started_at ASC
    `;
    let recovered = 0;
    for (const stale of staleRows) {
      const didRecover = await this.sql.begin(async (transaction) => {
        const rows = await transaction<
          Array<{
            id: string;
            action_kind: ContactActionKind;
            candidate_position_state_id: string;
            authorization_id: string | null;
            transport_mode: "fake" | "real";
            version: number;
            created_by: string;
            attempt_no: number | null;
          }>
        >`
          SELECT ci.id, ci.action_kind, ci.candidate_position_state_id, ci.authorization_id,
            ci.transport_mode, ci.version, ci.created_by,
            (
              SELECT MAX(attempt_no) FROM contact_attempts
              WHERE contact_intent_id = ci.id AND result = 'processing'
            )::int AS attempt_no
          FROM contact_intents ci
          JOIN candidate_position_states cps ON cps.id = ci.candidate_position_state_id
          JOIN positions p ON p.id = cps.position_id
          WHERE ci.id = ${stale.id} AND ci.status = 'processing'
            AND ci.started_at < now() - interval '10 minutes'
            AND ci.transport_mode = ${transportMode}
            AND p.boss_account_id = ${bossAccountId}
          FOR UPDATE OF ci
        `;
        const row = rows[0];
        if (!row) return false;

        const reservationRows = await transaction<
          Array<{
            quota_day: string;
            account_scope_id: string;
            position_scope_id: string;
            task_scope_id: string;
            status: string;
          }>
        >`
          SELECT quota_day::text AS quota_day, account_scope_id, position_scope_id,
            task_scope_id, status
          FROM contact_quota_reservations
          WHERE contact_intent_id = ${row.id}
          FOR UPDATE
        `;
        const reservation = reservationRows[0];
        if (reservation?.status === "reserved") {
          const scopes = [
            ["account", reservation.account_scope_id],
            ["position", reservation.position_scope_id],
            ["task", reservation.task_scope_id]
          ] as const;
          for (const [scopeType, scopeId] of scopes) {
            const finalizedCounters =
              row.transport_mode === "real"
                ? await transaction<{ id: string }[]>`
                    UPDATE quota_counters
                    SET reserved = reserved - 1, used = used + 1, updated_at = now()
                    WHERE scope_type = ${scopeType} AND scope_id = ${scopeId}
                      AND quota_day = ${reservation.quota_day}::date AND reserved > 0
                    RETURNING id
                  `
                : await transaction<{ id: string }[]>`
                    UPDATE quota_counters SET reserved = reserved - 1, updated_at = now()
                    WHERE scope_type = ${scopeType} AND scope_id = ${scopeId}
                      AND quota_day = ${reservation.quota_day}::date AND reserved > 0
                    RETURNING id
                  `;
            if (!finalizedCounters[0]) {
              throw new Error(`Stale quota reservation counter is missing for ${scopeType}.`);
            }
          }
          await transaction`
            UPDATE contact_quota_reservations
            SET status = ${row.transport_mode === "real" ? "consumed" : "released"},
              finished_at = now()
            WHERE contact_intent_id = ${row.id} AND status = 'reserved'
          `;
        }
        if (row.transport_mode === "fake") {
          if (reservation) {
            await transaction`
              DELETE FROM contact_quota_reservations
              WHERE contact_intent_id = ${row.id}
            `;
          }
          if (row.attempt_no !== null) {
            await transaction`
              UPDATE contact_attempts SET result = 'deferred',
                error_message = 'Recovered stale fake dispatch; safely requeued without a network send.',
                finished_at = now()
              WHERE contact_intent_id = ${row.id} AND attempt_no = ${row.attempt_no}
                AND result = 'processing'
            `;
          }
          await transaction`
            UPDATE contact_intents SET status = 'ready', started_at = NULL, finished_at = NULL,
              last_error = 'Recovered stale fake dispatch; safely requeued without a network send.',
              deferred_until = now(), deferred_reason = 'fake_stale_requeued',
              version = version + 1
            WHERE id = ${row.id}
          `;
          await transaction`
            UPDATE outbox_events SET status = 'pending', available_at = now(),
              locked_by = NULL,
              last_error = 'Recovered stale fake dispatch; safely requeued without a network send.',
              finished_at = NULL
            WHERE aggregate_id = ${row.id} AND status = 'processing'
          `;
          if (row.action_kind === "message") {
            await transaction`
              UPDATE candidate_position_states SET contact_status = 'queued', updated_at = now()
              WHERE id = ${row.candidate_position_state_id}
            `;
          }
          await transaction`
            INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
            VALUES (${randomUUID()}, ${row.created_by}, 'contact.fake_stale_requeued',
              'contact_intent', ${row.id},
              ${transaction.json({
                bossAccountId,
                actionKind: row.action_kind,
                transportMode: row.transport_mode
              })})
          `;
          return true;
        }

        const uncertainMessage =
          "真实发送过程被中断，无法确认消息是否送达。请先到 BOSS 核验；确认未发送后，可在联系页解除锁定。";
        if (row.attempt_no !== null) {
          await transaction`
            UPDATE contact_attempts SET result = 'uncertain',
              error_message = ${uncertainMessage}, finished_at = now()
            WHERE contact_intent_id = ${row.id} AND attempt_no = ${row.attempt_no}
              AND result = 'processing'
          `;
        }
        const updatedRows = await transaction<Array<{ version: number }>>`
          UPDATE contact_intents SET status = 'uncertain', last_error = ${uncertainMessage},
            finished_at = now(), deferred_until = NULL, deferred_reason = NULL,
            version = version + 1
          WHERE id = ${row.id}
          RETURNING version
        `;
        await transaction`
          UPDATE outbox_events SET status = 'completed', last_error = ${uncertainMessage},
            locked_by = NULL, finished_at = now()
          WHERE aggregate_id = ${row.id} AND status = 'processing'
        `;
        if (row.action_kind === "message") {
          await transaction`
            UPDATE candidate_position_states SET contact_status = 'uncertain', updated_at = now()
            WHERE id = ${row.candidate_position_state_id}
          `;
        }
        await transaction`
          INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
          VALUES (${randomUUID()}, ${row.created_by}, 'contact.real_stale_uncertain',
            'contact_intent', ${row.id},
            ${transaction.json({
              bossAccountId,
              actionKind: row.action_kind,
              transportMode: row.transport_mode,
              attemptNo: row.attempt_no,
              quotaReservationStatus:
                reservation?.status === "reserved" ? "consumed" : reservation?.status ?? null
            })})
        `;
        if (row.authorization_id) {
          const authorizationRows = await transaction<
            Array<{
              correlation_id: string;
              odoo_applicant_id: number;
              odoo_database_uuid: string;
              odoo_job_id: number;
              boss_account_id: string;
              transport_mode: "fake" | "real";
              contact_policy_version_id: string;
            }>
          >`
            SELECT ca.correlation_id, ca.odoo_applicant_id, ca.odoo_database_uuid,
              ca.odoo_job_id, ca.boss_account_id, ca.transport_mode,
              policy.external_version_id AS contact_policy_version_id
            FROM contact_authorizations ca
            JOIN contact_policy_snapshots policy ON policy.id = ca.contact_policy_snapshot_id
            WHERE ca.id = ${row.authorization_id}
          `;
          const authorization = authorizationRows[0];
          if (authorization) {
            if (
              authorization.transport_mode !== "real" ||
              authorization.boss_account_id !== bossAccountId
            ) {
              throw new Error("Stale real dispatch integration context changed.");
            }
            await enqueueIntegrationEvent(transaction, {
              deduplicationKey: `contact:${row.id}:recovered-uncertain`,
              correlationId: authorization.correlation_id,
              eventType: "contact.uncertain.v1",
              aggregateType: "contact_intent",
              aggregateId: row.id,
              aggregateVersion: updatedRows[0]?.version ?? row.version + 1,
              payload: {
                contactIntentId: row.id,
                actionKind: row.action_kind,
                odooDatabaseUuid: authorization.odoo_database_uuid,
                odooJobId: Number(authorization.odoo_job_id),
                authorizationId: row.authorization_id,
                candidateStateId: row.candidate_position_state_id,
                odooApplicantId: Number(authorization.odoo_applicant_id),
                bossAccountId: authorization.boss_account_id,
                transportMode: row.transport_mode,
                contactPolicyVersionId: authorization.contact_policy_version_id,
                status: "uncertain",
                attemptNo: row.attempt_no,
                externalMessage: null,
                errorMessage: uncertainMessage
              }
            });
          }
        }
        return true;
      });
      if (didRecover) recovered += 1;
    }
    return recovered;
  }

  async listAuditLogs(options?: {
    positionIds?: string[];
    departmentId?: string;
    actorId?: string;
  }): Promise<AuditLog[]> {
    const positionScope = options?.positionIds === undefined ? null : options.positionIds;
    const departmentId = options?.departmentId ?? null;
    const actorId = options?.actorId ?? null;
    const rows = await this.sql<
      Array<{
        id: string;
        actor_id: string;
        action: string;
        resource_type: string;
        resource_id: string;
        created_at: Date;
      }>
    >`
      SELECT log.id, log.actor_id, log.action, log.resource_type,
        log.resource_id, log.created_at
      FROM audit_logs log
      WHERE (${actorId}::text IS NULL OR log.actor_id = ${actorId})
        AND (
          (${positionScope}::uuid[] IS NULL AND ${departmentId}::uuid IS NULL)
          OR (
            ${departmentId}::uuid IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM users actor
              WHERE actor.id::text = log.actor_id
                AND actor.department_id = ${departmentId}::uuid
            )
          )
          OR (
            ${departmentId}::uuid IS NOT NULL
            AND log.resource_type = 'department'
            AND log.resource_id = ${departmentId}::text
          )
          OR (
            ${positionScope}::uuid[] IS NOT NULL
            AND (
              (log.resource_type = 'position' AND log.resource_id = ANY(${positionScope}::text[]))
              OR EXISTS (
                SELECT 1 FROM tasks task
                WHERE log.resource_type = 'task' AND task.id::text = log.resource_id
                  AND task.position_id = ANY(${positionScope}::uuid[])
              )
              OR EXISTS (
                SELECT 1 FROM schedules schedule
                WHERE log.resource_type = 'schedule' AND schedule.id::text = log.resource_id
                  AND schedule.position_id = ANY(${positionScope}::uuid[])
              )
              OR EXISTS (
                SELECT 1 FROM candidate_position_states state
                WHERE log.resource_type = 'candidate_position_state'
                  AND state.id::text = log.resource_id
                  AND state.position_id = ANY(${positionScope}::uuid[])
              )
              OR EXISTS (
                SELECT 1 FROM contact_intents intent
                JOIN candidate_position_states state
                  ON state.id = intent.candidate_position_state_id
                WHERE log.resource_type = 'contact_intent'
                  AND intent.id::text = log.resource_id
                  AND state.position_id = ANY(${positionScope}::uuid[])
              )
              OR EXISTS (
                SELECT 1 FROM rule_versions version
                JOIN rule_sets rules ON rules.id = version.rule_set_id
                WHERE log.resource_type = 'rule_version'
                  AND version.id::text = log.resource_id
                  AND rules.position_id = ANY(${positionScope}::uuid[])
              )
              OR EXISTS (
                SELECT 1 FROM positions position
                WHERE log.resource_type = 'boss_account'
                  AND position.boss_account_id = log.resource_id
                  AND position.id = ANY(${positionScope}::uuid[])
              )
            )
          )
        )
      ORDER BY log.created_at DESC LIMIT 100
    `;
    return rows.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      createdAt: iso(row.created_at)
    }));
  }
}
