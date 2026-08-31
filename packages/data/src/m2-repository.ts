import { randomUUID } from "node:crypto";
import { evaluateContactPolicy } from "@boss-forge/contact-policy";
import type { Database } from "./client.js";
import type {
  AuditLog,
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
          status: ContactIntentStatus;
          created_by: string;
          created_at: Date;
          last_error: string | null;
        }>
      >`
        SELECT ci.id, ci.candidate_position_state_id, c.display_name AS candidate_name,
          p.name AS position_name, ci.rendered_message, ci.status, ci.created_by,
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
          status: ContactIntentStatus;
          created_by: string;
          created_at: Date;
          last_error: string | null;
        }>
      >`
        INSERT INTO contact_intents (
          id, idempotency_key, candidate_position_state_id, task_id,
          template_version_id, rendered_message, status, policy_snapshot, created_by
        ) VALUES (
          ${intentId}, ${input.idempotencyKey}, ${input.stateId}, ${context.task_id},
          ${input.templateVersionId}, ${input.renderedMessage}, 'ready',
          ${transaction.json(policySnapshot)}, ${input.createdBy}
        ) RETURNING id, candidate_position_state_id, rendered_message,
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
        status: ContactIntentStatus;
        created_by: string;
        created_at: Date;
        last_error: string | null;
      }>
    >`
      SELECT ci.id, ci.candidate_position_state_id, c.display_name AS candidate_name,
        p.name AS position_name, ci.rendered_message, ci.status, ci.created_by,
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
      status: row.status,
      createdBy: row.created_by,
      createdAt: iso(row.created_at),
      lastError: row.last_error
    };
  }

  async claimContactDispatch(workerId: string): Promise<ContactDispatchJob | null> {
    return this.sql.begin(async (transaction) => {
      const rows = await transaction<
        Array<{
          outbox_event_id: string;
          intent_id: string;
          state_id: string;
          task_id: string;
          candidate_name: string;
          position_name: string;
          boss_job_keyword: string | null;
          rendered_message: string;
          created_by: string;
          created_at: Date;
          attempt_no: number;
        }>
      >`
        SELECT oe.id AS outbox_event_id, ci.id AS intent_id,
          ci.candidate_position_state_id AS state_id, ci.task_id,
          c.display_name AS candidate_name, p.name AS position_name,
          p.boss_job_keyword, ci.rendered_message, ci.created_by, ci.created_at,
          oe.attempts + 1 AS attempt_no
        FROM outbox_events oe
        JOIN contact_intents ci ON ci.id = oe.aggregate_id
        JOIN candidate_position_states cps ON cps.id = ci.candidate_position_state_id
        JOIN candidates c ON c.id = cps.candidate_id
        JOIN positions p ON p.id = cps.position_id
        WHERE oe.status = 'pending' AND oe.event_type = 'contact.requested'
          AND oe.available_at <= now() AND ci.status = 'ready'
        ORDER BY oe.created_at ASC
        FOR UPDATE OF oe, ci SKIP LOCKED
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) return null;
      await transaction`
        UPDATE outbox_events SET status = 'processing', attempts = ${row.attempt_no},
          locked_by = ${workerId} WHERE id = ${row.outbox_event_id}
      `;
      await transaction`
        UPDATE contact_intents SET status = 'processing', started_at = now(), version = version + 1
        WHERE id = ${row.intent_id}
      `;
      await transaction`
        INSERT INTO contact_attempts (
          id, contact_intent_id, attempt_no, result, transport
        ) VALUES (${randomUUID()}, ${row.intent_id}, ${row.attempt_no}, 'processing', 'boss-cli')
      `;
      return {
        id: row.intent_id,
        outboxEventId: row.outbox_event_id,
        candidateStateId: row.state_id,
        candidateName: row.candidate_name,
        candidateTarget: row.candidate_name,
        positionName: row.position_name,
        bossJobKeyword: row.boss_job_keyword,
        taskId: row.task_id,
        renderedMessage: row.rendered_message,
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
    const rows = await this.sql<
      Array<{
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
      SELECT cps.review_status, cps.rule_decision, cps.rule_confidence, cps.contact_status,
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
      JOIN positions p ON p.id = cps.position_id
      JOIN contact_settings settings ON settings.id = 'global'
      LEFT JOIN quota_counters account_quota ON account_quota.scope_type = 'account'
        AND account_quota.scope_id = p.boss_account_id AND account_quota.quota_day = CURRENT_DATE
      LEFT JOIN quota_counters position_quota ON position_quota.scope_type = 'position'
        AND position_quota.scope_id = p.id::text AND position_quota.quota_day = CURRENT_DATE
      LEFT JOIN quota_counters task_quota ON task_quota.scope_type = 'task'
        AND task_quota.scope_id = ${input.job.taskId} AND task_quota.quota_day = CURRENT_DATE
      WHERE cps.id = ${input.job.candidateStateId}
    `;
    const context = rows[0];
    if (!context) throw new Error("Candidate state not found during contact preflight.");
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
        samePositionAlreadyContacted: context.contact_status === "sent",
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
      throw new Error(`Contact dispatch preflight blocked: ${decision.reasons.join(",")}`);
    }
  }

  async finishContactDispatch(input: {
    job: ContactDispatchJob;
    result: "sent" | "failed" | "uncertain";
    externalMessage?: string | null;
    errorMessage?: string | null;
  }): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`
        UPDATE contact_attempts SET result = ${input.result},
          external_message = ${input.externalMessage ?? null},
          error_message = ${input.errorMessage ?? null}, finished_at = now()
        WHERE contact_intent_id = ${input.job.id} AND attempt_no = ${input.job.attemptNo}
      `;
      await transaction`
        UPDATE contact_intents SET status = ${input.result},
          last_error = ${input.errorMessage ?? null}, finished_at = now(), version = version + 1
        WHERE id = ${input.job.id}
      `;
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
      if (input.result === "sent") {
        const scopes: Array<["position" | "task", string]> = [
          ["task", input.job.taskId]
        ];
        const positionRows = await transaction<{ position_id: string; boss_account_id: string }[]>`
          SELECT p.id AS position_id, p.boss_account_id
          FROM candidate_position_states cps JOIN positions p ON p.id = cps.position_id
          WHERE cps.id = ${input.job.candidateStateId}
        `;
        const position = positionRows[0]!;
        const allScopes: Array<["account" | "position" | "task", string]> = [
          ["account", position.boss_account_id],
          ["position", position.position_id],
          ...scopes
        ];
        for (const [scopeType, scopeId] of allScopes) {
          await transaction`
            INSERT INTO quota_counters (id, scope_type, scope_id, quota_day, used)
            VALUES (${randomUUID()}, ${scopeType}, ${scopeId}, CURRENT_DATE, 1)
            ON CONFLICT (scope_type, scope_id, quota_day)
            DO UPDATE SET used = quota_counters.used + 1, updated_at = now()
          `;
        }
      }
    });
  }

  async recoverStaleContactDispatches(): Promise<number> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE contact_intents SET status = 'uncertain',
        last_error = 'Recovered stale processing intent; manual verification required.',
        finished_at = now(), version = version + 1
      WHERE status = 'processing' AND started_at < now() - interval '10 minutes'
      RETURNING id
    `;
    for (const row of rows) {
      await this.sql`
        UPDATE outbox_events SET status = 'completed',
          last_error = 'Dispatch result uncertain after worker interruption.', finished_at = now()
        WHERE aggregate_id = ${row.id} AND status = 'processing'
      `;
      await this.sql`
        UPDATE candidate_position_states SET contact_status = 'uncertain', updated_at = now()
        WHERE id = (
          SELECT candidate_position_state_id FROM contact_intents WHERE id = ${row.id}
        )
      `;
    }
    return rows.length;
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
