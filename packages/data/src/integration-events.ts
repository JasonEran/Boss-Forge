import { randomUUID } from "node:crypto";
import type { BossForgeOutboundEvent } from "@boss-forge/contracts";
import type postgres from "postgres";
import type { Database } from "./client.js";

function jsonValue(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

export type TaskIntegrationContext = {
  correlationId: string;
  odooDatabaseUuid: string;
  odooRunId: string;
  odooJobId: number;
};

export async function loadTaskIntegrationContext(
  sql: Database,
  taskId: string
): Promise<TaskIntegrationContext | null> {
  const rows = await sql<
    Array<{
      correlation_id: string | null;
      odoo_database_uuid: string | null;
      odoo_run_id: string | null;
      odoo_job_id: number | null;
    }>
  >`
    SELECT t.integration_correlation_id AS correlation_id,
      t.odoo_database_uuid, t.odoo_run_id, p.odoo_job_id
    FROM tasks t
    JOIN positions p ON p.id = t.position_id
    WHERE t.id = ${taskId}
  `;
  const row = rows[0];
  if (
    !row?.correlation_id ||
    !row.odoo_database_uuid ||
    !row.odoo_run_id ||
    row.odoo_job_id === null
  ) {
    return null;
  }
  return {
    correlationId: row.correlation_id,
    odooDatabaseUuid: row.odoo_database_uuid,
    odooRunId: row.odoo_run_id,
    odooJobId: Number(row.odoo_job_id)
  };
}

export async function enqueueIntegrationEvent(
  sql: Database,
  input: {
    deduplicationKey: string;
    correlationId: string;
    eventType: BossForgeOutboundEvent["eventType"];
    aggregateType: string;
    aggregateId: string;
    aggregateVersion: number;
    payload: Record<string, unknown>;
  }
): Promise<void> {
  await sql`
    INSERT INTO integration_outbox_events (
      event_id, deduplication_key, correlation_id, event_type, aggregate_type,
      aggregate_id, aggregate_version, payload
    ) VALUES (
      ${randomUUID()}, ${input.deduplicationKey}, ${input.correlationId},
      ${input.eventType}, ${input.aggregateType}, ${input.aggregateId},
      ${Math.max(1, input.aggregateVersion)}, ${sql.json(jsonValue(input.payload))}
    ) ON CONFLICT DO NOTHING
  `;
}

export async function enqueueTaskCompletionIfReady(
  sql: Database,
  taskOrStateId: string
): Promise<boolean> {
  const taskRows = await sql<Array<{ id: string }>>`
    SELECT id FROM tasks WHERE id = ${taskOrStateId}
    UNION ALL
    SELECT latest_task_id AS id FROM candidate_position_states
    WHERE id = ${taskOrStateId}
    LIMIT 1
  `;
  const taskId = taskRows[0]?.id;
  if (!taskId) return false;
  const rows = await sql<
    Array<{
      candidate_count: number;
      pending_count: number;
      matched_count: number;
      failed_count: number;
      review_count: number;
      task_status: string;
      state_version: number;
    }>
  >`
    SELECT t.candidate_count, t.status AS task_status,
      COUNT(*) FILTER (
        WHERE cps.resume_screening_status IN ('queued', 'processing')
      )::int AS pending_count,
      COUNT(*) FILTER (WHERE cps.rule_decision = 'matched')::int AS matched_count,
      COUNT(*) FILTER (
        WHERE cps.resume_screening_status IN ('no_text', 'failed')
      )::int AS failed_count,
      COUNT(*) FILTER (WHERE cps.review_status = 'pending')::int AS review_count,
      COALESCE(MAX(cps.version), 1)::int AS state_version
    FROM tasks t
    LEFT JOIN candidate_position_states cps ON cps.latest_task_id = t.id
    WHERE t.id = ${taskId}
    GROUP BY t.id, t.candidate_count, t.status
  `;
  const metrics = rows[0];
  if (
    !metrics ||
    !["waiting_review", "completed"].includes(metrics.task_status) ||
    Number(metrics.pending_count) > 0
  ) {
    return false;
  }
  if (Number(metrics.review_count) === 0) {
    await sql`
      UPDATE tasks SET status = 'completed', finished_at = COALESCE(finished_at, now()),
        claimed_by = NULL, claim_token = NULL, claimed_at = NULL
      WHERE id = ${taskId} AND status = 'waiting_review'
    `;
  }
  const context = await loadTaskIntegrationContext(sql, taskId);
  if (!context) return true;
  await enqueueIntegrationEvent(sql, {
    deduplicationKey: `task:${taskId}:screening-completed:${metrics.state_version}`,
    correlationId: context.correlationId,
    eventType: "screening.run.completed.v1",
    aggregateType: "screening_run",
    aggregateId: context.odooRunId,
    aggregateVersion: Math.max(1, Number(metrics.state_version)),
    payload: {
      taskId,
      screeningRunId: context.odooRunId,
      odooDatabaseUuid: context.odooDatabaseUuid,
      odooJobId: context.odooJobId,
      status: "completed",
      collectedCount: Number(metrics.candidate_count),
      matchedCount: Number(metrics.matched_count),
      failedCount: Number(metrics.failed_count),
      pendingReviewCount: Number(metrics.review_count)
    }
  });
  return true;
}
