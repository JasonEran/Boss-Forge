import { randomUUID } from "node:crypto";
import { evaluateContactPolicy } from "@boss-forge/contact-policy";
import type { Database } from "./client.js";
import { enqueueIntegrationEvent } from "./integration-events.js";
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
  "dispatch_context_changed",
  "quota_reservation_consumed",
  "quota_reservation_released"
]);

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
  if (reasons.some((reason) => PERMANENT_CONTACT_BLOCKS.has(reason))) {
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
  }): Promise<Schedule> {
    const nextRunAt = new Date(input.nextRunAt);
    if (!Number.isFinite(nextRunAt.getTime())) throw new Error("nextRunAt must be a valid date.");
    return this.sql.begin(async (transaction) => {
      const ruleRows = await transaction<{ active_version_id: string | null }[]>`
        SELECT active_version_id FROM rule_sets WHERE position_id = ${input.positionId}
      `;
      const ruleVersionId = ruleRows[0]?.active_version_id;
      if (!ruleVersionId) throw new Error("Position has no active rule version.");
      await transaction`
        INSERT INTO schedules (
          id, idempotency_key, position_id, rule_version_id, source,
          search_keyword, frequency, timezone, next_run_at, created_by
        ) VALUES (
          ${randomUUID()}, ${input.idempotencyKey}, ${input.positionId}, ${ruleVersionId},
          ${input.source}, ${input.searchKeyword ?? null}, ${input.frequency},
          ${input.timezone}, ${nextRunAt}, ${input.createdBy}
        ) ON CONFLICT (idempotency_key) DO NOTHING
      `;
      const rows = await transaction<ScheduleRow[]>`
        SELECT s.id, s.position_id, p.name AS position_name, s.source,
          s.search_keyword, s.frequency, s.timezone, s.next_run_at, s.enabled,
          s.created_by, s.version, s.created_at
        FROM schedules s JOIN positions p ON p.id = s.position_id
        WHERE s.idempotency_key = ${input.idempotencyKey}
      `;
      const schedule = mapSchedule(rows[0]!);
      await transaction`
        INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
        VALUES (
          ${randomUUID()}, ${input.createdBy}, 'schedule.created', 'schedule',
          ${schedule.id}, ${transaction.json({ frequency: input.frequency, nextRunAt: input.nextRunAt })}
        )
      `;
      return schedule;
    });
  }

  async listSchedules(): Promise<Schedule[]> {
    const rows = await this.sql<ScheduleRow[]>`
      SELECT s.id, s.position_id, p.name AS position_name, s.source,
        s.search_keyword, s.frequency, s.timezone, s.next_run_at, s.enabled,
        s.created_by, s.version, s.created_at
      FROM schedules s JOIN positions p ON p.id = s.position_id
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
        source, search_keyword, frequency, timezone, next_run_at, enabled,
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
          frequency: ScheduleFrequency;
          next_run_at: Date;
          created_by: string;
        }>
      >`
        SELECT id, position_id, rule_version_id, source, search_keyword,
          frequency, next_run_at, created_by
        FROM schedules
        WHERE enabled = true AND next_run_at <= ${now}
        ORDER BY next_run_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 20
      `;
      for (const schedule of due) {
        const idempotencyKey = `schedule:${schedule.id}:${schedule.next_run_at.toISOString()}`;
        await transaction`
          INSERT INTO tasks (
            id, idempotency_key, position_id, rule_version_id, execution_mode,
            source, search_keyword, status, created_by, schedule_id, scheduled_for
          ) VALUES (
            ${randomUUID()}, ${idempotencyKey}, ${schedule.position_id},
            ${schedule.rule_version_id}, 'scheduled', ${schedule.source},
            ${schedule.search_keyword}, 'queued', ${schedule.created_by},
            ${schedule.id}, ${schedule.next_run_at}
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

  async previewMessage(stateId: string): Promise<MessagePreview> {
    const rows = await this.sql<
      Array<{
        template_version_id: string;
        template_version: number;
        body: string;
        candidate_name: string;
        position_name: string;
      }>
    >`
      SELECT tv.id AS template_version_id, tv.version AS template_version, tv.body,
        c.display_name AS candidate_name, p.name AS position_name
      FROM candidate_position_states cps
      JOIN candidates c ON c.id = cps.candidate_id
      JOIN positions p ON p.id = cps.position_id
      JOIN LATERAL (
        SELECT mt.active_version_id
        FROM message_templates mt
        WHERE mt.position_id = p.id OR mt.position_id IS NULL
        ORDER BY (mt.position_id = p.id) DESC, mt.created_at ASC
        LIMIT 1
      ) selected ON true
      JOIN template_versions tv ON tv.id = selected.active_version_id
      WHERE cps.id = ${stateId} AND cps.review_status = 'approved'
    `;
    const row = rows[0];
    if (!row) throw new Error("Approved candidate or active message template not found.");
    const rendered = row.body
      .replaceAll("{{candidate_name}}", row.candidate_name)
      .replaceAll("{{position_name}}", row.position_name)
      .replaceAll("{{hr_name}}", "HR");
    return {
      templateVersionId: row.template_version_id,
      templateVersion: row.template_version,
      body: row.body,
      renderedMessage: rendered
    };
  }

  async createManualContactIntent(input: {
    stateId: string;
    idempotencyKey: string;
    templateVersionId: string;
    renderedMessage: string;
    createdBy: string;
    localMinuteOfDay: number;
    now: string;
  }): Promise<ContactIntent> {
    return this.sql.begin(async (transaction) => {
      const replay = await transaction<
        Array<{
          id: string;
          candidate_position_state_id: string;
          candidate_name: string;
          position_name: string;
          rendered_message: string;
          transport_mode: "fake" | "real";
          status: ContactIntentStatus;
          created_by: string;
          created_at: Date;
          last_error: string | null;
        }>
      >`
        SELECT ci.id, ci.candidate_position_state_id, c.display_name AS candidate_name,
          p.name AS position_name, ci.rendered_message, ci.transport_mode,
          ci.status, ci.created_by,
          ci.created_at, ci.last_error
        FROM contact_intents ci
        JOIN candidate_position_states cps ON cps.id = ci.candidate_position_state_id
        JOIN candidates c ON c.id = cps.candidate_id
        JOIN positions p ON p.id = cps.position_id
        WHERE ci.idempotency_key = ${input.idempotencyKey}
      `;
      if (replay[0]) return this.mapContactIntent(replay[0]);
      const contextRows = await transaction<
        Array<{
          candidate_name: string;
          position_name: string;
          position_id: string;
          boss_account_id: string;
          task_id: string;
          review_status: "pending" | "approved" | "rejected" | "not_required";
          rule_decision: "matched" | "not_matched" | "ambiguous" | "insufficient";
          rule_confidence: number;
          contact_status: string;
          last_cross_position_contact_at: Date | null;
          emergency_stop: boolean;
          allowed_start_minute: number;
          allowed_end_minute: number;
          account_daily_limit: number;
          position_daily_limit: number;
          task_limit: number;
          cross_position_cooldown_hours: number;
          account_used: number;
          position_used: number;
          task_used: number;
        }>
      >`
        SELECT c.display_name AS candidate_name, p.name AS position_name,
          p.id AS position_id, p.boss_account_id, cps.latest_task_id AS task_id,
          cps.review_status, cps.rule_decision, cps.rule_confidence, cps.contact_status,
          (
            SELECT MAX(ci2.finished_at) FROM contact_intents ci2
            JOIN candidate_position_states cps2 ON cps2.id = ci2.candidate_position_state_id
            WHERE cps2.candidate_id = cps.candidate_id AND ci2.status = 'sent'
              AND cps2.position_id <> cps.position_id
          ) AS last_cross_position_contact_at,
          settings.emergency_stop, settings.allowed_start_minute,
          settings.allowed_end_minute, settings.account_daily_limit,
          settings.position_daily_limit, settings.task_limit,
          settings.cross_position_cooldown_hours,
          COALESCE(account_quota.used, 0)::int AS account_used,
          COALESCE(position_quota.used, 0)::int AS position_used,
          COALESCE(task_quota.used, 0)::int AS task_used
        FROM candidate_position_states cps
        JOIN candidates c ON c.id = cps.candidate_id
        JOIN positions p ON p.id = cps.position_id
        JOIN contact_settings settings ON settings.id = 'global'
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
            context.contact_status === "queued" || context.contact_status === "sent",
          lastCrossPositionContactAt: context.last_cross_position_contact_at?.toISOString() ?? null,
          previousSendState: context.contact_status === "uncertain" ? "uncertain" : "none"
        },
        limits: {
          account: { used: context.account_used, limit: context.account_daily_limit },
          position: { used: context.position_used, limit: context.position_daily_limit },
          task: { used: context.task_used, limit: context.task_limit }
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
      const intentId = randomUUID();
      const policySnapshot = { mode: "manual", evaluatedAt: input.now, reasons: decision.reasons };
      const rows = await transaction<
        Array<{
          id: string;
          candidate_position_state_id: string;
          rendered_message: string;
          transport_mode: "fake" | "real";
          status: ContactIntentStatus;
          created_by: string;
          created_at: Date;
          last_error: string | null;
        }>
      >`
        INSERT INTO contact_intents (
          id, idempotency_key, candidate_position_state_id, task_id,
          template_version_id, rendered_message, status, policy_snapshot, created_by,
          transport_mode
        ) VALUES (
          ${intentId}, ${input.idempotencyKey}, ${input.stateId}, ${context.task_id},
          ${input.templateVersionId}, ${input.renderedMessage}, 'ready',
          ${transaction.json(policySnapshot)}, ${input.createdBy}, 'fake'
        ) RETURNING id, candidate_position_state_id, rendered_message, transport_mode,
          status, created_by, created_at, last_error
      `;
      await transaction`
        INSERT INTO outbox_events (
          id, aggregate_type, aggregate_id, event_type, payload
        ) VALUES (
          ${randomUUID()}, 'contact_intent', ${intentId}, 'contact.requested',
          ${transaction.json({ contactIntentId: intentId })}
        )
      `;
      await transaction`
        UPDATE candidate_position_states SET contact_status = 'queued', updated_at = now()
        WHERE id = ${input.stateId}
      `;
      await transaction`
        INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
        VALUES (${randomUUID()}, ${input.createdBy}, 'contact.intent.created',
          'contact_intent', ${intentId}, ${transaction.json(policySnapshot)})
      `;
      return this.mapContactIntent({
        ...rows[0]!,
        candidate_name: context.candidate_name,
        position_name: context.position_name
      });
    });
  }

  async listContactIntents(): Promise<ContactIntent[]> {
    const rows = await this.sql<
      Array<{
        id: string;
        candidate_position_state_id: string;
        candidate_name: string;
        position_name: string;
        rendered_message: string;
        transport_mode: "fake" | "real";
        status: ContactIntentStatus;
        created_by: string;
        created_at: Date;
        last_error: string | null;
      }>
    >`
      SELECT ci.id, ci.candidate_position_state_id, c.display_name AS candidate_name,
        p.name AS position_name, ci.rendered_message, ci.transport_mode,
        ci.status, ci.created_by,
        ci.created_at, ci.last_error
      FROM contact_intents ci
      JOIN candidate_position_states cps ON cps.id = ci.candidate_position_state_id
      JOIN candidates c ON c.id = cps.candidate_id
      JOIN positions p ON p.id = cps.position_id
      ORDER BY ci.created_at DESC LIMIT 50
    `;
    return rows.map((row) => this.mapContactIntent(row));
  }

  private mapContactIntent(row: {
    id: string;
    candidate_position_state_id: string;
    candidate_name: string;
    position_name: string;
    rendered_message: string;
    transport_mode: "fake" | "real";
    status: ContactIntentStatus;
    created_by: string;
    created_at: Date;
    last_error: string | null;
  }): ContactIntent {
    return {
      id: row.id,
      candidateStateId: row.candidate_position_state_id,
      candidateName: row.candidate_name,
      positionName: row.position_name,
      renderedMessage: row.rendered_message,
      transportMode: row.transport_mode,
      status: row.status,
      createdBy: row.created_by,
      createdAt: iso(row.created_at),
      lastError: row.last_error
    };
  }

  async claimContactDispatch(
    workerId: string,
    transportMode: "fake" | "real",
    bossAccountId: string
  ): Promise<ContactDispatchJob | null> {
    return this.sql.begin(async (transaction) => {
      const rows = await transaction<
        Array<{
          outbox_event_id: string;
          intent_id: string;
          state_id: string;
          task_id: string;
          candidate_name: string;
          candidate_fingerprint: string;
          source_reference: string;
          source: "recommend" | "search";
          search_keyword: string | null;
          raw_fields: Record<string, string>;
          source_evidence: string[];
          raw_text: string;
          position_name: string;
          boss_account_id: string;
          boss_job_keyword: string | null;
          rendered_message: string;
          transport_mode: "fake" | "real";
          created_by: string;
          created_at: Date;
          authorization_id: string | null;
          contact_policy_version_id: string | null;
          odoo_database_uuid: string | null;
          odoo_job_id: number | null;
          odoo_applicant_id: number | null;
          attempt_no: number;
        }>
      >`
        SELECT oe.id AS outbox_event_id, ci.id AS intent_id,
          ci.candidate_position_state_id AS state_id, ci.task_id,
          c.display_name AS candidate_name, c.fingerprint AS candidate_fingerprint,
          snapshot.source_reference, t.source, t.search_keyword,
          snapshot.raw_fields, snapshot.source_evidence, snapshot.raw_text,
          p.name AS position_name,
          p.boss_account_id, p.boss_job_keyword, ci.rendered_message, ci.transport_mode,
          ci.created_by, ci.created_at, ca.id AS authorization_id,
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
        ORDER BY oe.created_at ASC
        FOR UPDATE OF oe, ci SKIP LOCKED
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
        outboxEventId: row.outbox_event_id,
        candidateStateId: row.state_id,
        candidateName: row.candidate_name,
        candidateTarget: row.candidate_name,
        candidateFingerprint: row.candidate_fingerprint,
        candidateSnapshot: {
          index: Number.isInteger(sourceIndex) && sourceIndex > 0 ? sourceIndex : 1,
          name: row.candidate_name,
          source: row.source,
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
        authorizationId: row.authorization_id,
        contactPolicyVersionId: row.contact_policy_version_id,
        odooDatabaseUuid: row.odoo_database_uuid,
        odooJobId: row.odoo_job_id === null ? null : Number(row.odoo_job_id),
        odooApplicantId: row.odoo_applicant_id === null ? null : Number(row.odoo_applicant_id),
        taskId: row.task_id,
        renderedMessage: row.rendered_message,
        transportMode: row.transport_mode,
        status: "processing",
        createdBy: row.created_by,
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
          authorization_id: string | null;
          intent_policy_snapshot_id: string | null;
          rendered_message: string;
          transport_mode: "fake" | "real";
          task_id: string;
          task_status: string;
          state_id: string;
          position_id: string;
          position_status: "active" | "paused" | "closed";
          position_auto_contact: boolean;
          boss_account_id: string;
          review_status: "pending" | "approved" | "rejected" | "not_required";
          rule_version_external_id: string | null;
          same_position_sent: boolean;
          last_cross_position_contact_at: Date | null;
          account_has_uncertain: boolean;
          emergency_stop: boolean;
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
        }>
      >`
        SELECT ci.id AS intent_id, ci.authorization_id,
          ci.contact_policy_snapshot_id AS intent_policy_snapshot_id,
          ci.rendered_message, ci.transport_mode, ci.task_id, t.status AS task_status,
          cps.id AS state_id, p.id AS position_id, p.status AS position_status,
          p.auto_contact_after_review AS position_auto_contact,
          p.boss_account_id, cps.review_status,
          rv.external_version_id AS rule_version_external_id,
          EXISTS (
            SELECT 1 FROM contact_intents same_ci
            JOIN candidate_position_states same_cps
              ON same_cps.id = same_ci.candidate_position_state_id
            WHERE same_cps.candidate_id = cps.candidate_id
              AND same_cps.position_id = cps.position_id
              AND same_ci.id <> ci.id AND same_ci.status = 'sent'
          ) AS same_position_sent,
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
          settings.emergency_stop, settings.account_daily_limit,
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
          policy.stop_on_uncertain AS policy_stop_on_uncertain
        FROM contact_intents ci
        JOIN candidate_position_states cps ON cps.id = ci.candidate_position_state_id
        JOIN positions p ON p.id = cps.position_id
        JOIN tasks t ON t.id = ci.task_id
        JOIN rule_versions rv ON rv.id = cps.rule_version_id
        JOIN contact_settings settings ON settings.id = 'global'
        LEFT JOIN contact_policy_snapshots policy
          ON policy.id = ci.contact_policy_snapshot_id
        WHERE ci.id = ${input.job.id} AND ci.status = 'processing'
          AND ci.candidate_position_state_id = ${input.job.candidateStateId}
          AND ci.task_id = ${input.job.taskId}
          AND ci.transport_mode = ${input.job.transportMode}
          AND p.boss_account_id = ${input.job.bossAccountId}
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
      if (context.emergency_stop) reasons.push("emergency_stop");
      if (context.position_status === "paused") reasons.push("job_paused");
      if (context.position_status === "closed") reasons.push("job_closed");
      if (["failed", "cancelled"].includes(context.task_status)) reasons.push("task_not_active");
      if (context.review_status !== "approved") reasons.push("manual_review_required");
      if (context.same_position_sent) reasons.push("same_position_already_contacted");
      if (context.authorization_id !== input.job.authorizationId) {
        reasons.push("dispatch_context_changed");
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
      if (!alreadyReserved) {
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
        if (process.env.BOSS_FORGE_REAL_GREET_ENABLED !== "1") {
          reasons.push("real_contact_circuit_open");
        }
        // No authoritative account-health table exists yet. Real sends remain fail-closed.
        reasons.push("authoritative_boss_account_health_unavailable");
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
        WHERE id = ${input.job.id}
      `;
      await transaction`
        UPDATE outbox_events SET status = 'pending', available_at = ${availableAt},
          locked_by = NULL, last_error = ${input.reason}, finished_at = NULL
        WHERE id = ${input.job.outboxEventId}
      `;
      await transaction`
        UPDATE candidate_position_states SET contact_status = 'queued', updated_at = now()
        WHERE id = ${input.job.candidateStateId}
      `;
      await transaction`
        INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
        VALUES (${randomUUID()}, ${input.job.createdBy}, 'contact.deferred',
          'contact_intent', ${input.job.id},
          ${transaction.json({
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
        SELECT id FROM contact_intents WHERE id = ${input.job.id} FOR UPDATE
      `;
      if (!lockedIntents[0]) throw new Error("Contact intent was not found during completion.");
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
      if (input.result === "sent") {
        if (input.job.transportMode !== "real") {
          throw new Error("Only a real contact dispatch can consume sent quota.");
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
      await transaction`
        UPDATE contact_attempts SET result = ${input.result},
          external_message = ${input.externalMessage ?? null},
          error_message = ${input.errorMessage ?? null}, finished_at = now()
        WHERE contact_intent_id = ${input.job.id} AND attempt_no = ${input.job.attemptNo}
      `;
      const updatedIntents = await transaction<Array<{ version: number }>>`
        UPDATE contact_intents SET status = ${input.result},
          last_error = ${input.errorMessage ?? null}, finished_at = now(),
          deferred_until = NULL, deferred_reason = NULL, version = version + 1
        WHERE id = ${input.job.id}
        RETURNING version
      `;
      const intentVersion = updatedIntents[0]?.version ?? input.job.attemptNo;
      await transaction`
        UPDATE candidate_position_states SET contact_status = ${input.result}, updated_at = now()
        WHERE id = ${input.job.candidateStateId}
      `;
      await transaction`
        UPDATE outbox_events SET status = ${input.result === "failed" ? "failed" : "completed"},
          last_error = ${input.errorMessage ?? null}, finished_at = now()
        WHERE id = ${input.job.outboxEventId}
      `;
      await transaction`
        INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
        VALUES (${randomUUID()}, ${input.job.createdBy}, ${`contact.${input.result}`},
          'contact_intent', ${input.job.id},
          ${transaction.json({ attemptNo: input.job.attemptNo, error: input.errorMessage ?? null })})
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
            candidate_position_state_id: string;
            authorization_id: string | null;
            transport_mode: "fake" | "real";
            version: number;
            created_by: string;
            attempt_no: number | null;
          }>
        >`
          SELECT ci.id, ci.candidate_position_state_id, ci.authorization_id,
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
            const releasedCounters = await transaction<{ id: string }[]>`
              UPDATE quota_counters SET reserved = reserved - 1, updated_at = now()
              WHERE scope_type = ${scopeType} AND scope_id = ${scopeId}
                AND quota_day = ${reservation.quota_day}::date AND reserved > 0
              RETURNING id
            `;
            if (!releasedCounters[0]) {
              throw new Error(`Stale quota reservation counter is missing for ${scopeType}.`);
            }
          }
          await transaction`
            UPDATE contact_quota_reservations
            SET status = 'released', finished_at = now()
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
          await transaction`
            UPDATE candidate_position_states SET contact_status = 'queued', updated_at = now()
            WHERE id = ${row.candidate_position_state_id}
          `;
          await transaction`
            INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
            VALUES (${randomUUID()}, ${row.created_by}, 'contact.fake_stale_requeued',
              'contact_intent', ${row.id},
              ${transaction.json({ bossAccountId, transportMode: row.transport_mode })})
          `;
          return true;
        }

        const uncertainMessage =
          "Recovered stale real dispatch; manual verification required before another send.";
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
        await transaction`
          UPDATE candidate_position_states SET contact_status = 'uncertain', updated_at = now()
          WHERE id = ${row.candidate_position_state_id}
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

  async listAuditLogs(): Promise<AuditLog[]> {
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
      SELECT id, actor_id, action, resource_type, resource_id, created_at
      FROM audit_logs ORDER BY created_at DESC LIMIT 100
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
