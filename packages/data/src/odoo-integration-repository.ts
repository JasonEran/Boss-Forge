import { randomUUID } from "node:crypto";
import {
  BossForgeOutboundEventSchema,
  type BossForgeOutboundEvent,
  type OdooInboundEvent
} from "@boss-forge/contracts";
import type postgres from "postgres";
import type { Database } from "./client.js";
import {
  enqueueIntegrationEvent,
  enqueueTaskCompletionIfReady
} from "./integration-events.js";
import { parseRuleConfig } from "./rule-config.js";
import type { RuleConfig } from "./types.js";

export type InboundEventResult = {
  eventId: string;
  eventType: OdooInboundEvent["eventType"];
  replayed: boolean;
  resourceType: "position" | "task" | "candidate_state" | "contact_intent";
  resourceId: string;
};

export type OutboundEventDelivery = BossForgeOutboundEvent & {
  attempts: number;
};

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

function executionRuleConfig(config: Record<string, unknown>): RuleConfig {
  return parseRuleConfig(config);
}

function jsonValue(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

export class OdooIntegrationRepository {
  constructor(private readonly sql: Database) {}

  async handleInboundEvent(event: OdooInboundEvent): Promise<InboundEventResult> {
    try {
      return await this.sql.begin(async (transaction) => {
        const existing = await transaction<
          Array<{
            status: "processing" | "completed" | "failed";
            result: InboundEventResult | null;
            same_event: boolean;
          }>
        >`
          SELECT status, result,
            event_type = ${event.eventType}
              AND aggregate_type = ${event.aggregateType}
              AND aggregate_id = ${event.aggregateId}
              AND aggregate_version = ${event.aggregateVersion}
              AND occurred_at = ${new Date(event.occurredAt)}
              AND payload = ${transaction.json(jsonValue(event.payload))}::jsonb
              AS same_event
          FROM integration_inbox_events
          WHERE event_id = ${event.eventId}
          FOR UPDATE
        `;
        if (existing[0] && !existing[0].same_event) {
          throw new Error("Event ID was already used with a different immutable envelope.");
        }
        if (existing[0]?.status === "completed" && existing[0].result) {
          return { ...existing[0].result, replayed: true };
        }
        if (existing[0]) {
          await transaction`
            UPDATE integration_inbox_events
            SET status = 'processing', attempts = attempts + 1, last_error = NULL
            WHERE event_id = ${event.eventId}
          `;
        } else {
          await transaction`
            INSERT INTO integration_inbox_events (
              event_id, source_system, event_type, aggregate_type, aggregate_id,
              aggregate_version, occurred_at, payload
            ) VALUES (
              ${event.eventId}, 'odoo', ${event.eventType}, ${event.aggregateType},
              ${event.aggregateId}, ${event.aggregateVersion}, ${new Date(event.occurredAt)},
              ${transaction.json(jsonValue(event.payload))}
            )
          `;
        }

        let result: InboundEventResult;
        if (event.eventType === "job.config.published.v1") {
          const payload = event.payload;
          const configSnapshot = jsonValue(payload);
          const parsedRule = executionRuleConfig(payload.rule.config);
          const positionRows = await transaction<
            Array<{
              id: string;
              odoo_config_aggregate_version: number;
              same_config_snapshot: boolean | null;
            }>
          >`
            SELECT id, odoo_config_aggregate_version,
              CASE WHEN odoo_config_snapshot IS NULL THEN NULL
                ELSE odoo_config_snapshot = ${transaction.json(configSnapshot)}::jsonb
              END AS same_config_snapshot
            FROM positions
            WHERE (odoo_database_uuid = ${payload.odooDatabaseUuid}
              AND odoo_job_id = ${payload.odooJobId})
              OR (
                odoo_database_uuid IS NULL AND odoo_job_id IS NULL
                AND boss_account_id = ${payload.bossAccountId} AND name = ${payload.name}
              )
            ORDER BY (odoo_database_uuid IS NOT NULL) DESC
            LIMIT 1
            FOR UPDATE
          `;
          const positionId = positionRows[0]?.id ?? randomUUID();
          const existingPosition = positionRows[0];
          if (
            existingPosition &&
            event.aggregateVersion < Number(existingPosition.odoo_config_aggregate_version)
          ) {
            result = {
              eventId: event.eventId,
              eventType: event.eventType,
              replayed: true,
              resourceType: "position",
              resourceId: positionId
            };
            await transaction`
              UPDATE integration_inbox_events
              SET status = 'completed', result = ${transaction.json(result)},
                processed_at = now(), last_error = NULL
              WHERE event_id = ${event.eventId}
            `;
            return result;
          }
          if (
            existingPosition &&
            event.aggregateVersion === Number(existingPosition.odoo_config_aggregate_version) &&
            existingPosition.same_config_snapshot === false
          ) {
            throw new Error(
              "Odoo job aggregate version was reused with a different immutable configuration."
            );
          }
          if (
            existingPosition &&
            event.aggregateVersion === Number(existingPosition.odoo_config_aggregate_version) &&
            existingPosition.same_config_snapshot === true
          ) {
            result = {
              eventId: event.eventId,
              eventType: event.eventType,
              replayed: true,
              resourceType: "position",
              resourceId: positionId
            };
            await transaction`
              UPDATE integration_inbox_events
              SET status = 'completed', result = ${transaction.json(result)},
                processed_at = now(), last_error = NULL
              WHERE event_id = ${event.eventId}
            `;
            return result;
          }
          if (existingPosition) {
            await transaction`
              UPDATE positions SET
                odoo_database_uuid = ${payload.odooDatabaseUuid},
                odoo_job_id = ${payload.odooJobId},
                boss_account_id = ${payload.bossAccountId},
                name = ${payload.name},
                boss_job_keyword = ${payload.bossJobKeyword},
                status = ${payload.active ? "active" : "paused"},
                owner_name = ${payload.ownerId},
                collaborator_ids = ${transaction.json(payload.collaboratorIds)},
                auto_contact_after_review = ${payload.contactPolicy.autoContactAfterReview},
                contact_policy_version_id = ${payload.contactPolicy.policyVersionId},
                odoo_config_aggregate_version = ${event.aggregateVersion},
                odoo_config_snapshot = ${transaction.json(configSnapshot)},
                version = version + 1,
                updated_at = now()
              WHERE id = ${positionId}
            `;
          } else {
            await transaction`
              INSERT INTO positions (
                id, boss_account_id, name, boss_job_keyword, status, owner_name,
                odoo_database_uuid, odoo_job_id, collaborator_ids,
                auto_contact_after_review, contact_policy_version_id,
                odoo_config_aggregate_version, odoo_config_snapshot
              ) VALUES (
                ${positionId}, ${payload.bossAccountId}, ${payload.name},
                ${payload.bossJobKeyword}, ${payload.active ? "active" : "paused"},
                ${payload.ownerId}, ${payload.odooDatabaseUuid}, ${payload.odooJobId},
                ${transaction.json(payload.collaboratorIds)},
                ${payload.contactPolicy.autoContactAfterReview},
                ${payload.contactPolicy.policyVersionId}, ${event.aggregateVersion},
                ${transaction.json(configSnapshot)}
              )
            `;
          }
          const immutablePolicySnapshot = jsonValue(payload.contactPolicy);
          const existingPolicyRows = await transaction<
            Array<{ id: string; same_snapshot: boolean }>
          >`
            SELECT id,
              snapshot = ${transaction.json(immutablePolicySnapshot)}::jsonb AS same_snapshot
            FROM contact_policy_snapshots
            WHERE position_id = ${positionId}
              AND external_version_id = ${payload.contactPolicy.policyVersionId}
            FOR UPDATE
          `;
          if (existingPolicyRows[0] && !existingPolicyRows[0].same_snapshot) {
            throw new Error(
              "Contact policy version was already published with a different immutable snapshot."
            );
          }
          let contactPolicySnapshotId = existingPolicyRows[0]?.id;
          if (!contactPolicySnapshotId) {
            contactPolicySnapshotId = randomUUID();
            await transaction`
              INSERT INTO contact_policy_snapshots (
                id, position_id, external_version_id, auto_contact_after_review,
                daily_limit, allowed_start_minute, allowed_end_minute,
                cross_position_cooldown_hours, authorization_ttl_hours,
                stop_on_uncertain, snapshot, source_event_id
              ) VALUES (
                ${contactPolicySnapshotId}, ${positionId},
                ${payload.contactPolicy.policyVersionId},
                ${payload.contactPolicy.autoContactAfterReview},
                ${payload.contactPolicy.dailyLimit},
                ${payload.contactPolicy.allowedStartMinute},
                ${payload.contactPolicy.allowedEndMinute},
                ${payload.contactPolicy.crossPositionCooldownHours},
                ${payload.contactPolicy.authorizationTtlHours},
                ${payload.contactPolicy.stopOnUncertain},
                ${transaction.json(immutablePolicySnapshot)}, ${event.eventId}
              )
            `;
          }
          await transaction`
            UPDATE positions
            SET contact_policy_snapshot_id = ${contactPolicySnapshotId}
            WHERE id = ${positionId}
          `;
          const ruleSetRows = await transaction<{ id: string }[]>`
            INSERT INTO rule_sets (id, position_id, name)
            VALUES (${randomUUID()}, ${positionId}, ${`${payload.name} - Odoo rules`})
            ON CONFLICT (position_id) DO UPDATE SET name = EXCLUDED.name
            RETURNING id
          `;
          const ruleSetId = ruleSetRows[0]!.id;
          const ruleRows = await transaction<Array<{ id: string; same_rule: boolean }>>`
            SELECT id,
              config = ${transaction.json(jsonValue(parsedRule))}::jsonb
                AND dictionary_version = ${payload.rule.dictionaryVersion}
                AND schema_version = ${payload.rule.schemaVersion} AS same_rule
            FROM rule_versions
            WHERE rule_set_id = ${ruleSetId}
              AND external_version_id = ${payload.rule.versionId}
            LIMIT 1 FOR UPDATE
          `;
          if (ruleRows[0] && !ruleRows[0].same_rule) {
            throw new Error("Rule version was already published with a different immutable snapshot.");
          }
          let ruleVersionId = ruleRows[0]?.id;
          if (!ruleVersionId) {
            const versionRows = await transaction<{ next_version: number }[]>`
              SELECT COALESCE(MAX(version), 0) + 1 AS next_version
              FROM rule_versions WHERE rule_set_id = ${ruleSetId}
            `;
            ruleVersionId = randomUUID();
            await transaction`
              INSERT INTO rule_versions (
                id, rule_set_id, version, config, dictionary_version, created_by,
                external_version_id, schema_version
              ) VALUES (
                ${ruleVersionId}, ${ruleSetId}, ${Number(versionRows[0]!.next_version)},
                ${transaction.json(parsedRule)},
                ${payload.rule.dictionaryVersion}, ${payload.ownerId},
                ${payload.rule.versionId}, ${payload.rule.schemaVersion}
              )
            `;
          }
          await transaction`
            UPDATE rule_sets SET active_version_id = ${ruleVersionId} WHERE id = ${ruleSetId}
          `;
          const conflictingMap = await transaction<{ local_id: string }[]>`
            SELECT local_id FROM external_object_maps
            WHERE external_system = 'odoo'
              AND external_database_uuid = ${payload.odooDatabaseUuid}
              AND external_model = 'hr.job' AND external_id = ${String(payload.odooJobId)}
          `;
          if (conflictingMap[0] && conflictingMap[0].local_id !== positionId) {
            throw new Error("Odoo job mapping already points to another local position.");
          }
          await transaction`
            INSERT INTO external_object_maps (
              id, external_system, external_database_uuid, external_model,
              external_id, local_type, local_id
            ) VALUES (
              ${randomUUID()}, 'odoo', ${payload.odooDatabaseUuid}, 'hr.job',
              ${String(payload.odooJobId)}, 'position', ${positionId}
            ) ON CONFLICT (external_system, external_database_uuid, external_model, external_id)
            DO UPDATE SET updated_at = now()
          `;
          result = {
            eventId: event.eventId,
            eventType: event.eventType,
            replayed: false,
            resourceType: "position",
            resourceId: positionId
          };
        } else if (event.eventType === "screening.run.requested.v1") {
          const payload = event.payload;
          const requestSnapshot = jsonValue(payload);
          const parsedRule = executionRuleConfig(payload.rule.config);
          const positionRows = await transaction<
            Array<{ id: string; contact_policy_snapshot_id: string | null }>
          >`
            SELECT id, contact_policy_snapshot_id FROM positions
            WHERE odoo_database_uuid = ${payload.odooDatabaseUuid}
              AND odoo_job_id = ${payload.odooJobId} AND status = 'active'
            FOR UPDATE
          `;
          const positionId = positionRows[0]?.id;
          if (!positionId) {
            throw new Error("Active Odoo job mapping not found; publish job configuration first.");
          }
          const contactPolicySnapshotId = positionRows[0]?.contact_policy_snapshot_id;
          if (!contactPolicySnapshotId) {
            throw new Error("Odoo job has no published immutable contact-policy snapshot.");
          }
          const idempotencyKey = `odoo:${payload.odooDatabaseUuid}:screening:${payload.requestId}`;
          const existingTaskRows = await transaction<
            Array<{
              id: string;
              odoo_request_aggregate_version: number;
              same_request_snapshot: boolean | null;
            }>
          >`
            SELECT id, odoo_request_aggregate_version,
              CASE WHEN odoo_request_snapshot IS NULL THEN NULL
                ELSE odoo_request_snapshot = ${transaction.json(requestSnapshot)}::jsonb
              END AS same_request_snapshot
            FROM tasks WHERE idempotency_key = ${idempotencyKey}
            FOR UPDATE
          `;
          const existingTask = existingTaskRows[0];
          if (existingTask?.same_request_snapshot === false) {
            throw new Error(
              "Odoo screening request was replayed with a different immutable snapshot."
            );
          }
          if (existingTask?.same_request_snapshot === true) {
            result = {
              eventId: event.eventId,
              eventType: event.eventType,
              replayed: true,
              resourceType: "task",
              resourceId: existingTask.id
            };
            await transaction`
              UPDATE integration_inbox_events
              SET status = 'completed', result = ${transaction.json(result)},
                processed_at = now(), last_error = NULL
              WHERE event_id = ${event.eventId}
            `;
            return result;
          }
          const ruleSetRows = await transaction<{ id: string }[]>`
            INSERT INTO rule_sets (id, position_id, name)
            VALUES (${randomUUID()}, ${positionId}, 'Odoo published rules')
            ON CONFLICT (position_id) DO UPDATE SET name = rule_sets.name
            RETURNING id
          `;
          const ruleSetId = ruleSetRows[0]!.id;
          const ruleRows = await transaction<Array<{ id: string; same_rule: boolean }>>`
            SELECT id,
              config = ${transaction.json(jsonValue(parsedRule))}::jsonb
                AND dictionary_version = ${payload.rule.dictionaryVersion}
                AND schema_version = ${payload.rule.schemaVersion} AS same_rule
            FROM rule_versions
            WHERE rule_set_id = ${ruleSetId}
              AND external_version_id = ${payload.rule.versionId}
            FOR UPDATE
          `;
          if (ruleRows[0] && !ruleRows[0].same_rule) {
            throw new Error("Rule version was already published with a different immutable snapshot.");
          }
          let ruleVersionId = ruleRows[0]?.id;
          if (!ruleVersionId) {
            const versionRows = await transaction<{ next_version: number }[]>`
              SELECT COALESCE(MAX(version), 0) + 1 AS next_version
              FROM rule_versions WHERE rule_set_id = ${ruleSetId}
            `;
            ruleVersionId = randomUUID();
            await transaction`
              INSERT INTO rule_versions (
                id, rule_set_id, version, config, dictionary_version, created_by,
                external_version_id, schema_version
              ) VALUES (
                ${ruleVersionId}, ${ruleSetId}, ${Number(versionRows[0]!.next_version)},
                ${transaction.json(parsedRule)},
                ${payload.rule.dictionaryVersion}, ${payload.requestedById},
                ${payload.rule.versionId}, ${payload.rule.schemaVersion}
              )
            `;
          }
          const taskId = randomUUID();
          await transaction`
            INSERT INTO tasks (
              id, idempotency_key, position_id, rule_version_id, execution_mode,
              source, search_keyword, status, created_by, scheduled_for,
              integration_correlation_id, odoo_database_uuid, odoo_run_id,
              contact_policy_snapshot_id, odoo_request_aggregate_version,
              odoo_request_snapshot
            ) VALUES (
              ${taskId}, ${idempotencyKey}, ${positionId}, ${ruleVersionId},
              ${payload.execution.mode}, ${payload.execution.source},
              ${payload.execution.searchKeyword}, 'queued', ${payload.requestedById},
              ${payload.execution.scheduledFor ? new Date(payload.execution.scheduledFor) : null},
              ${event.eventId}, ${payload.odooDatabaseUuid}, ${payload.requestId},
              ${contactPolicySnapshotId}, ${event.aggregateVersion},
              ${transaction.json(requestSnapshot)}
            ) ON CONFLICT (idempotency_key) DO NOTHING
          `;
          const savedTask = await transaction<{ id: string }[]>`
            SELECT id FROM tasks WHERE idempotency_key = ${idempotencyKey}
          `;
          const savedTaskId = savedTask[0]!.id;
          await transaction`
            INSERT INTO external_object_maps (
              id, external_system, external_database_uuid, external_model,
              external_id, local_type, local_id
            ) VALUES (
              ${randomUUID()}, 'odoo', ${payload.odooDatabaseUuid}, 'boss.forge.screening.run',
              ${payload.requestId}, 'task', ${savedTaskId}
            ) ON CONFLICT (external_system, external_database_uuid, external_model, external_id)
            DO UPDATE SET updated_at = now()
          `;
          result = {
            eventId: event.eventId,
            eventType: event.eventType,
            replayed: false,
            resourceType: "task",
            resourceId: savedTaskId
          };
        } else if (event.eventType === "screening.run.cancelled.v1") {
          const payload = event.payload;
          const taskRows = await transaction<
            Array<{ id: string; status: string; candidate_count: number }>
          >`
            SELECT t.id, t.status, t.candidate_count
            FROM tasks t
            JOIN positions p ON p.id = t.position_id
            WHERE t.odoo_database_uuid = ${payload.odooDatabaseUuid}
              AND t.odoo_run_id = ${payload.requestId}
              AND p.odoo_job_id = ${payload.odooJobId}
            FOR UPDATE OF t
          `;
          const task = taskRows[0];
          if (!task) throw new Error("Odoo screening run mapping was not found.");
          if (!["queued", "running", "screening", "cancelled"].includes(task.status)) {
            throw new Error("A finished screening run cannot be cancelled.");
          }
          await transaction`
            UPDATE tasks SET status = 'cancelled',
              error_message = 'Cancelled from Odoo.', finished_at = now(),
              claimed_by = NULL, claim_token = NULL, claimed_at = NULL
            WHERE id = ${task.id}
          `;
          await transaction`
            UPDATE candidate_position_states
            SET resume_screening_status = 'failed',
              resume_screening_error = 'Screening run cancelled from Odoo.',
              resume_screening_claimed_by = NULL,
              resume_screening_claimed_at = NULL,
              version = version + 1,
              updated_at = now()
            WHERE latest_task_id = ${task.id}
              AND resume_screening_status IN ('queued', 'processing')
          `;
          await enqueueIntegrationEvent(transaction, {
            deduplicationKey: `task:${task.id}:cancelled`,
            correlationId: event.eventId,
            eventType: "screening.run.completed.v1",
            aggregateType: "screening_run",
            aggregateId: payload.requestId,
            aggregateVersion: event.aggregateVersion,
            payload: {
              taskId: task.id,
              screeningRunId: payload.requestId,
              odooDatabaseUuid: payload.odooDatabaseUuid,
              odooJobId: payload.odooJobId,
              status: "cancelled",
              collectedCount: Number(task.candidate_count),
              matchedCount: 0,
              failedCount: 0,
              pendingReviewCount: 0,
              cancelledById: payload.cancelledById,
              cancelledAt: payload.cancelledAt
            }
          });
          await transaction`
            INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
            VALUES (
              ${randomUUID()}, ${payload.cancelledById}, 'task.cancelled',
              'task', ${task.id},
              ${transaction.json({ source: "odoo", requestId: payload.requestId })}
            )
          `;
          result = {
            eventId: event.eventId,
            eventType: event.eventType,
            replayed: false,
            resourceType: "task",
            resourceId: task.id
          };
        } else if (event.eventType === "candidate.review.completed.v1") {
          const payload = event.payload;
          const reviewSnapshot = jsonValue({
            candidateStateId: payload.candidateStateId,
            odooDatabaseUuid: payload.odooDatabaseUuid,
            odooApplicantId: payload.odooApplicantId,
            odooJobId: payload.odooJobId,
            decision: payload.decision,
            reviewerId: payload.reviewerId,
            reviewedAt: payload.reviewedAt,
            reviewVersion: payload.reviewVersion
          });
          const stateRows = await transaction<
            Array<{
              id: string;
              task_id: string;
              odoo_database_uuid: string | null;
              odoo_applicant_id: number | null;
              position_database_uuid: string | null;
              odoo_job_id: number | null;
              resume_screening_status: string;
              odoo_review_version: number;
              same_review_snapshot: boolean | null;
            }>
          >`
            SELECT cps.id, cps.latest_task_id AS task_id,
              cps.odoo_database_uuid, cps.odoo_applicant_id,
              p.odoo_database_uuid AS position_database_uuid, p.odoo_job_id,
              cps.resume_screening_status, cps.odoo_review_version,
              CASE WHEN cps.odoo_review_snapshot IS NULL THEN NULL
                ELSE cps.odoo_review_snapshot = ${transaction.json(reviewSnapshot)}::jsonb
              END AS same_review_snapshot
            FROM candidate_position_states cps
            JOIN positions p ON p.id = cps.position_id
            WHERE cps.id = ${payload.candidateStateId}
            FOR UPDATE OF cps, p
          `;
          const state = stateRows[0];
          if (!state) throw new Error("Candidate state was not found for Odoo review.");
          if (
            state.position_database_uuid !== payload.odooDatabaseUuid ||
            Number(state.odoo_job_id) !== payload.odooJobId ||
            (state.odoo_database_uuid !== null &&
              state.odoo_database_uuid !== payload.odooDatabaseUuid) ||
            (state.odoo_applicant_id !== null &&
              Number(state.odoo_applicant_id) !== payload.odooApplicantId)
          ) {
            throw new Error("Odoo review does not match the mapped candidate/job.");
          }
          if (["not_requested", "queued", "processing"].includes(state.resume_screening_status)) {
            throw new Error("Candidate resume screening must finish before Odoo review.");
          }
          if (payload.reviewVersion < Number(state.odoo_review_version)) {
            result = {
              eventId: event.eventId,
              eventType: event.eventType,
              replayed: true,
              resourceType: "candidate_state",
              resourceId: state.id
            };
          } else if (
            payload.reviewVersion === Number(state.odoo_review_version) &&
            state.same_review_snapshot === false
          ) {
            throw new Error("Odoo review version was reused with a different immutable snapshot.");
          } else if (
            payload.reviewVersion === Number(state.odoo_review_version) &&
            state.same_review_snapshot === true
          ) {
            result = {
              eventId: event.eventId,
              eventType: event.eventType,
              replayed: true,
              resourceType: "candidate_state",
              resourceId: state.id
            };
          } else {
            await transaction`
              UPDATE candidate_position_states SET
                odoo_database_uuid = ${payload.odooDatabaseUuid},
                odoo_applicant_id = ${payload.odooApplicantId},
                review_status = ${payload.decision},
                odoo_review_version = ${payload.reviewVersion},
                odoo_review_snapshot = ${transaction.json(reviewSnapshot)},
                version = version + 1, updated_at = now()
              WHERE id = ${state.id}
            `;
            await transaction`
              INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
              VALUES (
                ${randomUUID()}, ${payload.reviewerId},
                ${`candidate.review.${payload.decision}`}, 'candidate_position_state',
                ${state.id}, ${transaction.json(reviewSnapshot)}
              )
            `;
            result = {
              eventId: event.eventId,
              eventType: event.eventType,
              replayed: false,
              resourceType: "candidate_state",
              resourceId: state.id
            };
          }
          await enqueueTaskCompletionIfReady(transaction, state.task_id);
        } else {
          const payload = event.payload;
          const contactReviewSnapshot = jsonValue({
            candidateStateId: payload.candidateStateId,
            odooDatabaseUuid: payload.odooDatabaseUuid,
            odooApplicantId: payload.odooApplicantId,
            odooJobId: payload.odooJobId,
            decision: "approved",
            reviewerId: payload.reviewerId,
            reviewedAt: payload.reviewedAt,
            reviewVersion: payload.reviewVersion
          });
          if (payload.doNotContact) throw new Error("Contact authorization is marked do-not-contact.");
          if (
            payload.transportMode === "real" &&
            process.env.BOSS_FORGE_REAL_GREET_ENABLED !== "1"
          ) {
            throw new Error("Real contact is disabled by the Boss-Forge circuit breaker.");
          }
          if (
            payload.authorizationExpiresAt &&
            Date.parse(payload.authorizationExpiresAt) <= Date.now()
          ) {
            throw new Error("Contact authorization has expired.");
          }
          const stateRows = await transaction<
            Array<{
              id: string;
              position_id: string;
              task_id: string;
              position_name: string;
              boss_account_id: string;
              odoo_database_uuid: string | null;
              odoo_job_id: number | null;
              odoo_applicant_id: number | null;
              contact_status: string;
              rule_version_external_id: string | null;
              position_status: "active" | "paused" | "closed";
              auto_contact_after_review: boolean;
              odoo_review_version: number;
              same_review_snapshot: boolean | null;
            }>
          >`
            SELECT cps.id, cps.position_id, cps.latest_task_id AS task_id,
              p.name AS position_name, p.boss_account_id, p.odoo_database_uuid,
              p.odoo_job_id, cps.odoo_applicant_id, cps.contact_status,
              rv.external_version_id AS rule_version_external_id,
              p.status AS position_status, p.auto_contact_after_review,
              cps.odoo_review_version,
              CASE WHEN cps.odoo_review_snapshot IS NULL THEN NULL
                ELSE cps.odoo_review_snapshot = ${transaction.json(contactReviewSnapshot)}::jsonb
              END AS same_review_snapshot
            FROM candidate_position_states cps
            JOIN positions p ON p.id = cps.position_id
            JOIN rule_versions rv ON rv.id = cps.rule_version_id
            WHERE cps.id = ${payload.candidateStateId}
            FOR UPDATE OF cps, p
          `;
          const state = stateRows[0];
          if (!state) throw new Error("Candidate state not found for Odoo authorization.");
          if (
            state.odoo_database_uuid !== payload.odooDatabaseUuid ||
            Number(state.odoo_job_id) !== payload.odooJobId ||
            state.boss_account_id !== payload.bossAccountId
          ) {
            throw new Error("Contact authorization does not match the mapped Odoo job/account.");
          }
          if (
            state.odoo_applicant_id !== null &&
            Number(state.odoo_applicant_id) !== payload.odooApplicantId
          ) {
            throw new Error("Candidate state is already mapped to another Odoo applicant.");
          }
          if (payload.reviewVersion < Number(state.odoo_review_version)) {
            throw new Error("Contact authorization references a stale Odoo review version.");
          }
          if (
            payload.reviewVersion === Number(state.odoo_review_version) &&
            state.same_review_snapshot === false
          ) {
            throw new Error("Contact authorization conflicts with the immutable Odoo review.");
          }
          if (state.rule_version_external_id !== payload.ruleVersionId) {
            throw new Error("Contact authorization rule version does not match the screening result.");
          }
          if (state.position_status !== "active") {
            throw new Error("Contact authorization requires an active Odoo job.");
          }
          if (!state.auto_contact_after_review) {
            throw new Error("Auto-contact after review is disabled for this Odoo job.");
          }
          const policyRows = await transaction<
            Array<{
              id: string;
              authorization_ttl_hours: number;
              auto_contact_after_review: boolean;
              snapshot: Record<string, unknown>;
            }>
          >`
            SELECT id, authorization_ttl_hours, auto_contact_after_review, snapshot
            FROM contact_policy_snapshots
            WHERE position_id = ${state.position_id}
              AND external_version_id = ${payload.contactPolicyVersionId}
            FOR SHARE
          `;
          const policy = policyRows[0];
          if (!policy) {
            throw new Error("Published contact-policy snapshot was not found for authorization.");
          }
          if (!policy.auto_contact_after_review) {
            throw new Error("The authorized contact-policy snapshot has auto-contact disabled.");
          }
          const reviewedAt = new Date(payload.reviewedAt);
          const authorizationExpiresAt = new Date(payload.authorizationExpiresAt);
          const maximumExpiresAt =
            reviewedAt.getTime() + policy.authorization_ttl_hours * 60 * 60 * 1_000;
          if (authorizationExpiresAt.getTime() > maximumExpiresAt) {
            throw new Error("Contact authorization exceeds the immutable policy TTL.");
          }
          const authorizationSnapshot = {
            source: "odoo_authorization",
            authorizationId: payload.authorizationId,
            candidateStateId: payload.candidateStateId,
            odooDatabaseUuid: payload.odooDatabaseUuid,
            odooApplicantId: payload.odooApplicantId,
            odooJobId: payload.odooJobId,
            reviewerId: payload.reviewerId,
            reviewedAt: payload.reviewedAt,
            reviewVersion: payload.reviewVersion,
            bossAccountId: payload.bossAccountId,
            ruleVersionId: payload.ruleVersionId,
            templateVersionId: payload.templateVersionId,
            contactPolicyVersionId: payload.contactPolicyVersionId,
            renderedMessage: payload.renderedMessage,
            transportMode: payload.transportMode,
            authorizationExpiresAt: payload.authorizationExpiresAt,
            doNotContact: payload.doNotContact,
            contactPolicy: policy.snapshot
          };
          const existingAuthorizationRows = await transaction<
            Array<{
              id: string;
              candidate_position_state_id: string;
              odoo_database_uuid: string;
              odoo_applicant_id: number;
              odoo_job_id: number;
              review_version: number;
              reviewer_id: string;
              reviewed_at: Date;
              boss_account_id: string;
              rule_version_external_id: string;
              template_version_external_id: string;
              rendered_message: string;
              transport_mode: "fake" | "real";
              authorization_expires_at: Date | null;
              do_not_contact: boolean;
              contact_policy_snapshot_id: string | null;
            }>
          >`
            SELECT id, candidate_position_state_id, odoo_database_uuid, odoo_applicant_id,
              odoo_job_id, review_version, reviewer_id, reviewed_at, boss_account_id,
              rule_version_external_id, template_version_external_id, rendered_message,
              transport_mode, authorization_expires_at, do_not_contact,
              contact_policy_snapshot_id
            FROM contact_authorizations
            WHERE id = ${payload.authorizationId}
            FOR UPDATE
          `;
          const existingAuthorization = existingAuthorizationRows[0];
          if (
            existingAuthorization &&
            (existingAuthorization.candidate_position_state_id !== payload.candidateStateId ||
              existingAuthorization.odoo_database_uuid !== payload.odooDatabaseUuid ||
              Number(existingAuthorization.odoo_applicant_id) !== payload.odooApplicantId ||
              Number(existingAuthorization.odoo_job_id) !== payload.odooJobId ||
              existingAuthorization.review_version !== payload.reviewVersion ||
              existingAuthorization.reviewer_id !== payload.reviewerId ||
              existingAuthorization.reviewed_at.getTime() !== reviewedAt.getTime() ||
              existingAuthorization.boss_account_id !== payload.bossAccountId ||
              existingAuthorization.rule_version_external_id !== payload.ruleVersionId ||
              existingAuthorization.template_version_external_id !== payload.templateVersionId ||
              existingAuthorization.rendered_message !== payload.renderedMessage ||
              existingAuthorization.transport_mode !== payload.transportMode ||
              existingAuthorization.authorization_expires_at?.getTime() !==
                authorizationExpiresAt.getTime() ||
              existingAuthorization.do_not_contact !== payload.doNotContact ||
              existingAuthorization.contact_policy_snapshot_id !== policy.id)
          ) {
            throw new Error("Contact authorization ID was reused with a different snapshot.");
          }
          const existingIntent = await transaction<{ id: string }[]>`
            SELECT id FROM contact_intents WHERE authorization_id = ${payload.authorizationId}
          `;
          let intentId = existingIntent[0]?.id;
          if (!intentId) {
            await transaction`
              INSERT INTO contact_authorizations (
                id, correlation_id, candidate_position_state_id,
                odoo_database_uuid, odoo_applicant_id,
                odoo_job_id, review_version, reviewer_id, reviewed_at, boss_account_id,
                rule_version_external_id, template_version_external_id, rendered_message,
                transport_mode, authorization_expires_at, do_not_contact,
                contact_policy_snapshot_id, policy_snapshot
              ) VALUES (
                ${payload.authorizationId}, ${event.eventId}, ${payload.candidateStateId},
                ${payload.odooDatabaseUuid}, ${payload.odooApplicantId}, ${payload.odooJobId},
                ${payload.reviewVersion}, ${payload.reviewerId}, ${new Date(payload.reviewedAt)},
                ${payload.bossAccountId}, ${payload.ruleVersionId}, ${payload.templateVersionId},
                ${payload.renderedMessage}, ${payload.transportMode},
                ${authorizationExpiresAt}, ${payload.doNotContact}, ${policy.id},
                ${transaction.json(jsonValue(authorizationSnapshot))}
              ) ON CONFLICT (id) DO NOTHING
            `;
            const templateName = `Odoo ${payload.templateVersionId}`;
            const templateRows = await transaction<{ id: string }[]>`
              SELECT id FROM message_templates
              WHERE position_id = ${state.position_id} AND name = ${templateName}
              ORDER BY created_at ASC LIMIT 1
            `;
            const templateId = templateRows[0]?.id ?? randomUUID();
            if (!templateRows[0]) {
              await transaction`
                INSERT INTO message_templates (id, position_id, name)
                VALUES (${templateId}, ${state.position_id}, ${templateName})
              `;
            }
            const versionRows = await transaction<{ next_version: number }[]>`
              SELECT COALESCE(MAX(version), 0) + 1 AS next_version
              FROM template_versions WHERE template_id = ${templateId}
            `;
            const templateVersionId = randomUUID();
            await transaction`
              INSERT INTO template_versions (id, template_id, version, body, created_by)
              VALUES (
                ${templateVersionId}, ${templateId}, ${Number(versionRows[0]!.next_version)},
                ${payload.renderedMessage}, ${payload.reviewerId}
              )
            `;
            await transaction`
              UPDATE message_templates SET active_version_id = ${templateVersionId}
              WHERE id = ${templateId}
            `;
            intentId = randomUUID();
            await transaction`
              INSERT INTO contact_intents (
                id, idempotency_key, candidate_position_state_id, task_id,
                template_version_id, rendered_message, status, policy_snapshot,
                created_by, authorization_id, transport_mode,
                contact_policy_snapshot_id
              ) VALUES (
                ${intentId}, ${`odoo-authorization:${payload.authorizationId}`},
                ${payload.candidateStateId}, ${state.task_id}, ${templateVersionId},
                ${payload.renderedMessage}, 'ready',
                ${transaction.json(jsonValue(authorizationSnapshot))},
                ${payload.reviewerId}, ${payload.authorizationId}, ${payload.transportMode},
                ${policy.id}
              )
            `;
            await transaction`
              INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload)
              VALUES (
                ${randomUUID()}, 'contact_intent', ${intentId}, 'contact.requested',
                ${transaction.json({ contactIntentId: intentId, transportMode: payload.transportMode })}
              )
            `;
            await transaction`
              UPDATE candidate_position_states SET
                odoo_database_uuid = ${payload.odooDatabaseUuid},
                odoo_applicant_id = ${payload.odooApplicantId},
                review_status = 'approved', contact_status = 'queued',
                odoo_review_version = ${payload.reviewVersion},
                odoo_review_snapshot = ${transaction.json(contactReviewSnapshot)},
                version = version + 1, updated_at = now()
              WHERE id = ${payload.candidateStateId}
            `;
            await transaction`
              UPDATE contact_authorizations SET status = 'consumed', consumed_at = now()
              WHERE id = ${payload.authorizationId}
            `;
            await enqueueIntegrationEvent(transaction, {
              deduplicationKey: `contact:${intentId}:queued`,
              correlationId: event.eventId,
              eventType: "contact.queued.v1",
              aggregateType: "contact_intent",
              aggregateId: intentId,
              aggregateVersion: 1,
              payload: {
                contactIntentId: intentId,
                authorizationId: payload.authorizationId,
                candidateStateId: payload.candidateStateId,
                odooDatabaseUuid: payload.odooDatabaseUuid,
                odooApplicantId: payload.odooApplicantId,
                odooJobId: payload.odooJobId,
                bossAccountId: payload.bossAccountId,
                contactPolicyVersionId: payload.contactPolicyVersionId,
                transportMode: payload.transportMode
              }
            });
            await transaction`
              INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
              VALUES (
                ${randomUUID()}, ${payload.reviewerId}, 'contact.authorization.accepted',
                'contact_authorization', ${payload.authorizationId},
                ${transaction.json(jsonValue(authorizationSnapshot))}
              )
            `;
            await enqueueTaskCompletionIfReady(transaction, state.task_id);
          }
          result = {
            eventId: event.eventId,
            eventType: event.eventType,
            replayed: false,
            resourceType: "contact_intent",
            resourceId: intentId
          };
        }

        await transaction`
          UPDATE integration_inbox_events
          SET status = 'completed', result = ${transaction.json(result)},
            processed_at = now(), last_error = NULL
          WHERE event_id = ${event.eventId}
        `;
        return result;
      });
    } catch (error: unknown) {
      const message = errorMessage(error);
      await this.sql`
        INSERT INTO integration_inbox_events (
          event_id, source_system, event_type, aggregate_type, aggregate_id,
          aggregate_version, occurred_at, payload, status, last_error, processed_at
        ) VALUES (
          ${event.eventId}, 'odoo', ${event.eventType}, ${event.aggregateType},
          ${event.aggregateId}, ${event.aggregateVersion}, ${new Date(event.occurredAt)},
          ${this.sql.json(jsonValue(event.payload))}, 'failed', ${message}, now()
        ) ON CONFLICT (event_id) DO UPDATE SET
          status = 'failed', attempts = integration_inbox_events.attempts + 1,
          last_error = EXCLUDED.last_error, processed_at = now()
        WHERE integration_inbox_events.status <> 'completed'
      `;
      throw error;
    }
  }

  async claimOutboundEvent(workerId: string): Promise<OutboundEventDelivery | null> {
    return this.sql.begin(async (transaction) => {
      const rows = await transaction<
        Array<{
          event_id: string;
          correlation_id: string;
          event_type: BossForgeOutboundEvent["eventType"];
          aggregate_type: string;
          aggregate_id: string;
          aggregate_version: number;
          occurred_at: Date;
          payload: Record<string, unknown>;
          attempts: number;
        }>
      >`
        SELECT candidate.event_id, candidate.correlation_id, candidate.event_type,
          candidate.aggregate_type, candidate.aggregate_id, candidate.aggregate_version,
          candidate.occurred_at, candidate.payload, candidate.attempts + 1 AS attempts
        FROM integration_outbox_events candidate
        WHERE candidate.status IN ('pending', 'failed')
          AND candidate.available_at <= now()
          AND NOT EXISTS (
            SELECT 1
            FROM integration_outbox_events earlier
            WHERE earlier.correlation_id = candidate.correlation_id
              AND earlier.sequence_no < candidate.sequence_no
              AND earlier.status <> 'delivered'
          )
        ORDER BY candidate.sequence_no ASC
        FOR UPDATE OF candidate SKIP LOCKED
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) return null;
      await transaction`
        UPDATE integration_outbox_events
        SET status = 'processing', attempts = ${row.attempts}, locked_by = ${workerId},
          locked_at = now()
        WHERE event_id = ${row.event_id}
      `;
      const outbound = BossForgeOutboundEventSchema.parse({
        eventId: row.event_id,
        correlationId: row.correlation_id,
        eventType: row.event_type,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        aggregateVersion: row.aggregate_version,
        occurredAt: row.occurred_at.toISOString(),
        payload: row.payload
      });
      return { ...outbound, attempts: row.attempts };
    });
  }

  async finishOutboundEvent(input: {
    eventId: string;
    delivered: boolean;
    error?: string | null;
  }): Promise<void> {
    if (input.delivered) {
      await this.sql`
        UPDATE integration_outbox_events
        SET status = 'delivered', delivered_at = now(), locked_by = NULL,
          locked_at = NULL, last_error = NULL
        WHERE event_id = ${input.eventId} AND status = 'processing'
      `;
      return;
    }
    const message = (input.error ?? "Unknown Odoo delivery error").slice(0, 1_000);
    await this.sql`
      UPDATE integration_outbox_events
      SET status = CASE WHEN attempts >= 8 THEN 'dead_letter' ELSE 'failed' END,
        available_at = now() + (LEAST(attempts, 6) * interval '30 seconds'),
        locked_by = NULL, locked_at = NULL, last_error = ${message}
      WHERE event_id = ${input.eventId} AND status = 'processing'
    `;
  }

  async recoverStaleOutboundEvents(): Promise<number> {
    const rows = await this.sql<{ event_id: string }[]>`
      UPDATE integration_outbox_events
      SET status = 'failed', locked_by = NULL, locked_at = NULL,
        available_at = now(), last_error = 'Recovered stale Odoo delivery claim.'
      WHERE status = 'processing' AND locked_at < now() - interval '5 minutes'
      RETURNING event_id
    `;
    return rows.length;
  }
}
