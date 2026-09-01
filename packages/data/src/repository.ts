import { randomUUID } from "node:crypto";
import type { Database } from "./client.js";
import type {
  CandidateEvaluationRecord,
  CandidateDetail,
  DashboardCandidate,
  DashboardSnapshot,
  Position,
  RuleConfig,
  RuleVersion,
  ResumeScreeningJob,
  ReviewRecord,
  Task
} from "./types.js";
import {
  enqueueIntegrationEvent,
  enqueueTaskCompletionIfReady,
  loadTaskIntegrationContext
} from "./integration-events.js";

export class OptimisticLockError extends Error {
  constructor(
    readonly expectedVersion: number,
    readonly actualVersion: number
  ) {
    super(`State version conflict: expected ${expectedVersion}, actual ${actualVersion}.`);
    this.name = "OptimisticLockError";
  }
}

type PositionRow = {
  id: string;
  boss_account_id: string;
  name: string;
  boss_job_keyword: string | null;
  status: Position["status"];
  owner_name: string;
  version: number;
  created_at: Date;
  updated_at: Date;
};

type TaskRow = {
  id: string;
  idempotency_key: string;
  position_id: string;
  position_name: string;
  boss_account_id: string;
  boss_job_keyword: string | null;
  rule_version_id: string;
  rule_config: RuleConfig;
  execution_mode: Task["executionMode"];
  source: Task["source"];
  search_keyword: string | null;
  status: Task["status"];
  created_by: string;
  candidate_count: number;
  error_message: string | null;
  claim_token: string | null;
  created_at: Date;
};

function iso(value: Date): string {
  return value.toISOString();
}

function mapPosition(row: PositionRow): Position {
  return {
    id: row.id,
    bossAccountId: row.boss_account_id,
    name: row.name,
    bossJobKeyword: row.boss_job_keyword,
    status: row.status,
    ownerName: row.owner_name,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    positionId: row.position_id,
    positionName: row.position_name,
    bossAccountId: row.boss_account_id,
    bossJobKeyword: row.boss_job_keyword,
    ruleVersionId: row.rule_version_id,
    ruleConfig: row.rule_config,
    executionMode: row.execution_mode,
    source: row.source,
    searchKeyword: row.search_keyword,
    status: row.status,
    createdBy: row.created_by,
    candidateCount: row.candidate_count,
    errorMessage: row.error_message,
    claimToken: row.claim_token,
    createdAt: iso(row.created_at)
  };
}

const TASK_SELECT = `
  SELECT t.id, t.idempotency_key, t.position_id, p.name AS position_name,
    p.boss_account_id, p.boss_job_keyword, t.rule_version_id, rv.config AS rule_config,
    t.execution_mode, t.source, t.search_keyword, t.status, t.created_by,
    t.candidate_count, t.error_message, t.claim_token, t.created_at
  FROM tasks t
  JOIN positions p ON p.id = t.position_id
  JOIN rule_versions rv ON rv.id = t.rule_version_id
`;

export class BossForgeRepository {
  constructor(private readonly sql: Database) {}

  async createPosition(input: {
    bossAccountId: string;
    name: string;
    bossJobKeyword?: string | null;
    ownerName: string;
  }): Promise<Position> {
    const rows = await this.sql<PositionRow[]>`
      INSERT INTO positions (
        id, boss_account_id, name, boss_job_keyword, owner_name
      ) VALUES (
        ${randomUUID()}, ${input.bossAccountId}, ${input.name},
        ${input.bossJobKeyword ?? null}, ${input.ownerName}
      )
      ON CONFLICT (boss_account_id, name) DO UPDATE SET
        boss_job_keyword = EXCLUDED.boss_job_keyword,
        owner_name = EXCLUDED.owner_name,
        version = positions.version + 1,
        updated_at = now()
      RETURNING *
    `;
    return mapPosition(rows[0]!);
  }

  async listPositions(): Promise<Position[]> {
    const rows = await this.sql<PositionRow[]>`
      SELECT * FROM positions ORDER BY created_at ASC
    `;
    return rows.map(mapPosition);
  }

  async createRuleVersion(input: {
    positionId: string;
    name: string;
    config: RuleConfig;
    dictionaryVersion: string;
    createdBy: string;
  }): Promise<RuleVersion> {
    return this.sql.begin(async (transaction) => {
      const ruleSetRows = await transaction<{ id: string }[]>`
        INSERT INTO rule_sets (id, position_id, name)
        VALUES (${randomUUID()}, ${input.positionId}, ${input.name})
        ON CONFLICT (position_id) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
      `;
      const ruleSetId = ruleSetRows[0]!.id;
      const versionRows = await transaction<{ next_version: number }[]>`
        SELECT COALESCE(MAX(version), 0) + 1 AS next_version
        FROM rule_versions WHERE rule_set_id = ${ruleSetId}
      `;
      const version = Number(versionRows[0]!.next_version);
      const id = randomUUID();
      const rows = await transaction<
        Array<{
          id: string;
          rule_set_id: string;
          version: number;
          config: RuleConfig;
          dictionary_version: string;
          created_by: string;
          created_at: Date;
        }>
      >`
        INSERT INTO rule_versions (
          id, rule_set_id, version, config, dictionary_version, created_by
        ) VALUES (
          ${id}, ${ruleSetId}, ${version}, ${transaction.json(input.config)},
          ${input.dictionaryVersion}, ${input.createdBy}
        ) RETURNING *
      `;
      await transaction`
        UPDATE rule_sets SET active_version_id = ${id} WHERE id = ${ruleSetId}
      `;
      await transaction`
        INSERT INTO audit_logs (
          id, actor_id, action, resource_type, resource_id, payload
        ) VALUES (
          ${randomUUID()}, ${input.createdBy}, 'rule.version.created',
          'rule_version', ${id}, ${transaction.json({ version, positionId: input.positionId })}
        )
      `;
      const row = rows[0]!;
      return {
        id: row.id,
        ruleSetId: row.rule_set_id,
        version: row.version,
        config: row.config,
        dictionaryVersion: row.dictionary_version,
        createdBy: row.created_by,
        createdAt: iso(row.created_at)
      };
    });
  }

  async createImmediateTask(input: {
    idempotencyKey: string;
    positionId: string;
    source: "recommend" | "search";
    searchKeyword?: string | null;
    createdBy: string;
  }): Promise<Task> {
    return this.sql.begin(async (transaction) => {
      const activeRows = await transaction<{ active_version_id: string | null }[]>`
        SELECT active_version_id FROM rule_sets WHERE position_id = ${input.positionId}
      `;
      const ruleVersionId = activeRows[0]?.active_version_id;
      if (!ruleVersionId) throw new Error("Position has no active rule version.");
      const taskId = randomUUID();
      await transaction`
        INSERT INTO tasks (
          id, idempotency_key, position_id, rule_version_id, execution_mode,
          source, search_keyword, status, created_by
        ) VALUES (
          ${taskId}, ${input.idempotencyKey}, ${input.positionId}, ${ruleVersionId},
          'immediate', ${input.source}, ${input.searchKeyword ?? null}, 'queued', ${input.createdBy}
        ) ON CONFLICT (idempotency_key) DO NOTHING
      `;
      const rows = await transaction.unsafe<TaskRow[]>(
        `${TASK_SELECT} WHERE t.idempotency_key = $1`,
        [input.idempotencyKey]
      );
      const task = mapTask(rows[0]!);
      await transaction`
        INSERT INTO audit_logs (
          id, actor_id, action, resource_type, resource_id, payload
        ) VALUES (
          ${randomUUID()}, ${input.createdBy}, 'task.immediate.requested',
          'task', ${task.id}, ${transaction.json({ positionId: input.positionId, source: input.source })}
        )
      `;
      return task;
    });
  }

  async claimNextTask(workerId: string, bossAccountId: string): Promise<Task | null> {
    return this.sql.begin(async (transaction) => {
      const selected = await transaction<{ id: string }[]>`
        SELECT t.id FROM tasks t
        JOIN positions p ON p.id = t.position_id
        WHERE (
            t.status = 'queued'
            OR (
              t.status = 'running'
              AND t.claimed_at < now() - interval '15 minutes'
            )
          )
          AND p.boss_account_id = ${bossAccountId}
        ORDER BY t.created_at ASC
        FOR UPDATE OF t SKIP LOCKED
        LIMIT 1
      `;
      const id = selected[0]?.id;
      if (!id) return null;
      const claimToken = randomUUID();
      await transaction`
        UPDATE tasks SET status = 'running', claimed_by = ${workerId},
          claim_token = ${claimToken}, claimed_at = now(),
          claim_attempts = claim_attempts + 1,
          started_at = COALESCE(started_at, now()), finished_at = NULL,
          error_message = NULL
        WHERE id = ${id}
      `;
      const integration = await loadTaskIntegrationContext(transaction, id);
      if (integration) {
        await enqueueIntegrationEvent(transaction, {
          deduplicationKey: `task:${id}:started`,
          correlationId: integration.correlationId,
          eventType: "screening.run.started.v1",
          aggregateType: "screening_run",
          aggregateId: integration.odooRunId,
          aggregateVersion: 1,
          payload: {
            taskId: id,
            screeningRunId: integration.odooRunId,
            odooDatabaseUuid: integration.odooDatabaseUuid,
            odooJobId: integration.odooJobId,
            workerId
          }
        });
      }
      const rows = await transaction.unsafe<TaskRow[]>(`${TASK_SELECT} WHERE t.id = $1`, [id]);
      return mapTask(rows[0]!);
    });
  }

  async completeTask(task: Task, records: CandidateEvaluationRecord[]): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const currentTasks = await transaction<
        Array<{ status: Task["status"]; claim_token: string | null }>
      >`
        SELECT status, claim_token FROM tasks WHERE id = ${task.id} FOR UPDATE
      `;
      const currentTask = currentTasks[0];
      if (!currentTask) throw new Error("Task was not found during collection completion.");
      if (["cancelled", "completed", "failed"].includes(currentTask.status)) return;
      if (
        currentTask.status !== "running" ||
        !task.claimToken ||
        currentTask.claim_token !== task.claimToken
      ) {
        throw new Error("Task collection lease is no longer active.");
      }
      const integration = await loadTaskIntegrationContext(transaction, task.id);
      const uniqueStateIds = new Set<string>();
      for (const record of records) {
        const baseInfo = record.rawFields["信息"]?.trim();
        let candidateRows: Array<{ id: string }> = [];
        if (baseInfo) {
          candidateRows = await transaction<{ id: string }[]>`
            SELECT c.id
            FROM candidates c
            JOIN candidate_snapshots cs ON cs.candidate_id = c.id
            WHERE LOWER(BTRIM(c.display_name)) = LOWER(BTRIM(${record.displayName}))
              AND BTRIM(cs.raw_fields ->> '信息') = ${baseInfo}
            ORDER BY c.updated_at DESC, cs.collected_at DESC
            LIMIT 1
          `;
          if (candidateRows[0]) {
            candidateRows = await transaction<{ id: string }[]>`
              UPDATE candidates
              SET fingerprint = ${record.fingerprint},
                display_name = ${record.displayName},
                updated_at = now()
              WHERE id = ${candidateRows[0].id}
              RETURNING id
            `;
          }
        }
        if (!candidateRows[0]) {
          candidateRows = await transaction<{ id: string }[]>`
            INSERT INTO candidates (id, fingerprint, display_name)
            VALUES (${randomUUID()}, ${record.fingerprint}, ${record.displayName})
            ON CONFLICT (fingerprint) DO UPDATE SET
              display_name = EXCLUDED.display_name,
              updated_at = now()
            RETURNING id
          `;
        }
        const candidateId = candidateRows[0]!.id;
        const snapshotRows = await transaction<{ id: string }[]>`
          INSERT INTO candidate_snapshots (
            id, task_id, candidate_id, source_reference, source, raw_fields,
            source_evidence, raw_text
          ) VALUES (
            ${randomUUID()}, ${task.id}, ${candidateId}, ${record.sourceReference},
            ${record.source}, ${transaction.json(record.rawFields)},
            ${transaction.json(record.sourceEvidence)}, ${record.rawText}
          )
          ON CONFLICT (task_id, source_reference) DO UPDATE SET
            raw_fields = EXCLUDED.raw_fields,
            source_evidence = EXCLUDED.source_evidence,
            raw_text = EXCLUDED.raw_text
          RETURNING id
        `;
        const snapshotId = snapshotRows[0]!.id;
        const stateRows = await transaction<
          Array<{ id: string; resume_screening_status: string; version: number }>
        >`
          INSERT INTO candidate_position_states (
            id, position_id, candidate_id, latest_task_id, latest_snapshot_id,
            rule_version_id, rule_decision, rule_confidence, review_status,
            resume_screening_status, current_english_level
          ) VALUES (
            ${randomUUID()}, ${task.positionId}, ${candidateId}, ${task.id}, ${snapshotId},
            ${task.ruleVersionId}, ${record.decision}, ${record.confidence},
            ${record.decision === "not_matched" ? "not_required" : "pending"},
            'queued', ${record.currentEnglishLevel}
          )
          ON CONFLICT (position_id, candidate_id) DO UPDATE SET
            latest_task_id = EXCLUDED.latest_task_id,
            latest_snapshot_id = EXCLUDED.latest_snapshot_id,
            rule_version_id = EXCLUDED.rule_version_id,
            rule_decision = CASE
              WHEN candidate_position_states.resume_screening_status = 'screened'
                THEN candidate_position_states.rule_decision
              ELSE EXCLUDED.rule_decision
            END,
            rule_confidence = CASE
              WHEN candidate_position_states.resume_screening_status = 'screened'
                THEN candidate_position_states.rule_confidence
              ELSE EXCLUDED.rule_confidence
            END,
            current_english_level = CASE
              WHEN candidate_position_states.resume_screening_status = 'screened'
                THEN candidate_position_states.current_english_level
              ELSE EXCLUDED.current_english_level
            END,
            resume_screening_status = CASE
              WHEN candidate_position_states.resume_screening_status = 'screened'
                THEN 'screened'
              ELSE 'queued'
            END,
            resume_screening_error = NULL,
            review_status = CASE
              WHEN candidate_position_states.review_status IN ('approved', 'rejected')
                THEN candidate_position_states.review_status
              WHEN candidate_position_states.resume_screening_status = 'screened'
                THEN candidate_position_states.review_status
              ELSE EXCLUDED.review_status
            END,
            version = candidate_position_states.version + 1,
            updated_at = now()
          RETURNING id, resume_screening_status, version
        `;
        const stateId = stateRows[0]!.id;
        uniqueStateIds.add(stateId);
        if (stateRows[0]!.resume_screening_status !== "screened") {
          await transaction`DELETE FROM match_evidence WHERE candidate_position_state_id = ${stateId}`;
          for (const evidence of record.evidence) {
            await transaction`
              INSERT INTO match_evidence (
                id, candidate_position_state_id, capability_id, canonical_label,
                dictionary_version, source_text, normalized_alias, evidence_status,
                confidence, reason_codes
              ) VALUES (
                ${randomUUID()}, ${stateId},
                ${evidence.capabilityId ?? record.capabilityId},
                ${evidence.canonicalLabel ?? record.canonicalLabel},
                ${evidence.dictionaryVersion ?? record.dictionaryVersion},
                ${evidence.sourceText}, ${evidence.normalizedAlias},
                ${evidence.status}, ${evidence.confidence},
                ${transaction.json(evidence.reasonCodes ?? record.reasonCodes)}
              )
            `;
          }
        }
        if (integration) {
          await enqueueIntegrationEvent(transaction, {
            deduplicationKey: `task:${task.id}:candidate:${stateId}:collected`,
            correlationId: integration.correlationId,
            eventType: "candidate.collected.v1",
            aggregateType: "candidate_state",
            aggregateId: stateId,
            aggregateVersion: stateRows[0]!.version,
            payload: {
              taskId: task.id,
              screeningRunId: integration.odooRunId,
              odooDatabaseUuid: integration.odooDatabaseUuid,
              odooJobId: integration.odooJobId,
              candidateStateId: stateId,
              externalCandidateId: candidateId,
              identityKey: record.fingerprint,
              candidateName: record.displayName,
              source: record.source,
              screeningStatus: "queued",
              fields: record.rawFields
            }
          });
        }
      }
      const uniqueCandidateCount = uniqueStateIds.size;
      const status = uniqueCandidateCount > 0 ? "screening" : "completed";
      await transaction`
        UPDATE tasks SET status = ${status}, candidate_count = ${uniqueCandidateCount},
          finished_at = ${uniqueCandidateCount > 0 ? null : new Date()}, error_message = NULL,
          claimed_by = NULL, claim_token = NULL, claimed_at = NULL
        WHERE id = ${task.id}
      `;
      await transaction`
        INSERT INTO audit_logs (
          id, actor_id, action, resource_type, resource_id, payload
        ) VALUES (
          ${randomUUID()}, ${task.createdBy}, 'task.collection.completed',
          'task', ${task.id},
          ${transaction.json({
            candidateCount: uniqueCandidateCount,
            rawRecordCount: records.length,
            duplicatesCollapsed: records.length - uniqueCandidateCount
          })}
        )
      `;
      await enqueueTaskCompletionIfReady(transaction, task.id);
    });
  }

  async claimNextResumeScreening(
    workerId: string,
    bossAccountId: string
  ): Promise<ResumeScreeningJob | null> {
    return this.sql.begin(async (transaction) => {
      const selected = await transaction<{ id: string }[]>`
        SELECT id FROM candidate_position_states
        WHERE (
          resume_screening_status = 'queued'
          OR (
              resume_screening_status = 'processing'
              AND resume_screening_claimed_at < now() - interval '15 minutes'
            )
          )
          AND EXISTS (
            SELECT 1 FROM tasks
            JOIN positions ON positions.id = tasks.position_id
            WHERE tasks.id = candidate_position_states.latest_task_id
              AND tasks.status IN ('screening', 'waiting_review')
              AND positions.boss_account_id = ${bossAccountId}
          )
        ORDER BY updated_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `;
      const stateId = selected[0]?.id;
      if (!stateId) return null;
      await transaction`
        UPDATE candidate_position_states
        SET resume_screening_status = 'processing',
          resume_screening_claimed_by = ${workerId},
          resume_screening_claimed_at = now(),
          resume_screening_attempts = resume_screening_attempts + 1,
          resume_screening_error = NULL,
          updated_at = now()
        WHERE id = ${stateId}
      `;
      const rows = await transaction<
        Array<{
          state_id: string;
          task_id: string;
          candidate_name: string;
          boss_account_id: string;
          boss_job_keyword: string | null;
          source: "recommend" | "search";
          search_keyword: string | null;
          rule_version_id: string;
          rule_config: RuleConfig;
          source_reference: string;
          raw_fields: Record<string, string>;
          source_evidence: string[];
          raw_text: string;
        }>
      >`
        SELECT cps.id AS state_id, t.id AS task_id, c.display_name AS candidate_name,
          p.boss_account_id, p.boss_job_keyword, t.source, t.search_keyword,
          COALESCE(rv.external_version_id, rv.id::text) AS rule_version_id,
          rv.config AS rule_config,
          cs.source_reference, cs.raw_fields, cs.source_evidence, cs.raw_text
        FROM candidate_position_states cps
        JOIN candidates c ON c.id = cps.candidate_id
        JOIN positions p ON p.id = cps.position_id
        JOIN tasks t ON t.id = cps.latest_task_id
        JOIN rule_versions rv ON rv.id = cps.rule_version_id
        JOIN candidate_snapshots cs ON cs.id = cps.latest_snapshot_id
        WHERE cps.id = ${stateId}
      `;
      const row = rows[0];
      if (!row) return null;
      const indexMatch = row.source_reference.match(/^[^:]+:(\d+):/u);
      return {
        stateId: row.state_id,
        taskId: row.task_id,
        ruleVersionId: row.rule_version_id,
        candidateName: row.candidate_name,
        bossAccountId: row.boss_account_id,
        bossJobKeyword: row.boss_job_keyword,
        source: row.source,
        searchKeyword: row.search_keyword,
        ruleConfig: row.rule_config,
        candidate: {
          index: Number(indexMatch?.[1] ?? "1"),
          name: row.candidate_name,
          source: row.source,
          fields: row.raw_fields,
          evidence: row.source_evidence,
          raw: row.raw_text
        }
      };
    });
  }

  async completeResumeScreening(input: {
    job: ResumeScreeningJob;
    record: CandidateEvaluationRecord;
    screenshotPath: string | null;
    resumeTextHash: string;
    workerId: string;
    ocrProvider?: "boss" | "tencent";
    ocrLineCount?: number | null;
    ocrAverageConfidence?: number | null;
    ocrRequestId?: string | null;
  }): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const taskRows = await transaction<Array<{ status: Task["status"] }>>`
        SELECT status FROM tasks WHERE id = ${input.job.taskId} FOR UPDATE
      `;
      if (!taskRows[0]) throw new Error("Resume screening task was not found.");
      if (!["screening", "waiting_review"].includes(taskRows[0].status)) return;
      const updatedStates = await transaction<Array<{ version: number; review_status: string }>>`
        UPDATE candidate_position_states
        SET rule_decision = ${input.record.decision},
          rule_confidence = ${input.record.confidence},
          current_english_level = ${input.record.currentEnglishLevel},
          resume_screening_status = 'screened',
          resume_screenshot_path = ${input.screenshotPath},
          resume_text_hash = ${input.resumeTextHash},
          resume_screened_at = now(),
          resume_screening_error = NULL,
          resume_screening_claimed_by = NULL,
          resume_screening_claimed_at = NULL,
          review_status = CASE
            WHEN review_status IN ('approved', 'rejected') THEN review_status
            WHEN ${input.record.decision} = 'not_matched' THEN 'not_required'
            ELSE 'pending'
          END,
          version = version + 1,
          updated_at = now()
        WHERE id = ${input.job.stateId}
          AND latest_task_id = ${input.job.taskId}
          AND resume_screening_status = 'processing'
        RETURNING version, review_status
      `;
      const updatedState = updatedStates[0];
      if (!updatedState) throw new Error("Candidate resume screening claim is no longer active.");
      await transaction`
        DELETE FROM match_evidence WHERE candidate_position_state_id = ${input.job.stateId}
      `;
      for (const evidence of input.record.evidence) {
        await transaction`
          INSERT INTO match_evidence (
            id, candidate_position_state_id, capability_id, canonical_label,
            dictionary_version, source_text, normalized_alias, evidence_status,
            confidence, reason_codes
          ) VALUES (
            ${randomUUID()}, ${input.job.stateId},
            ${evidence.capabilityId ?? input.record.capabilityId},
            ${evidence.canonicalLabel ?? input.record.canonicalLabel},
            ${evidence.dictionaryVersion ?? input.record.dictionaryVersion},
            ${evidence.sourceText}, ${evidence.normalizedAlias}, ${evidence.status},
            ${evidence.confidence},
            ${transaction.json(evidence.reasonCodes ?? input.record.reasonCodes)}
          )
        `;
      }
      await transaction`
        INSERT INTO audit_logs (
          id, actor_id, action, resource_type, resource_id, payload
        ) VALUES (
          ${randomUUID()}, ${input.workerId}, 'candidate.resume_screened',
          'candidate_position_state', ${input.job.stateId},
          ${transaction.json({
            taskId: input.job.taskId,
            decision: input.record.decision,
            confidence: input.record.confidence,
            currentEnglishLevel: input.record.currentEnglishLevel,
            screenshotAvailable: Boolean(input.screenshotPath),
            resumeTextHash: input.resumeTextHash,
            ocrProvider: input.ocrProvider ?? "synthetic",
            ocrLineCount: input.ocrLineCount ?? null,
            ocrAverageConfidence: input.ocrAverageConfidence ?? null,
            ocrRequestId: input.ocrRequestId ?? null
          })}
        )
      `;
      await transaction`
        UPDATE tasks
        SET status = CASE
            WHEN EXISTS (
              SELECT 1 FROM candidate_position_states
              WHERE latest_task_id = ${input.job.taskId}
                AND resume_screening_status IN ('queued', 'processing')
            ) THEN 'screening'
            ELSE 'waiting_review'
          END,
          finished_at = CASE
            WHEN EXISTS (
              SELECT 1 FROM candidate_position_states
              WHERE latest_task_id = ${input.job.taskId}
                AND resume_screening_status IN ('queued', 'processing')
            ) THEN NULL ELSE now()
          END
        WHERE id = ${input.job.taskId} AND status IN ('screening', 'waiting_review')
      `;
      const integration = await loadTaskIntegrationContext(transaction, input.job.taskId);
      if (integration) {
        await enqueueIntegrationEvent(transaction, {
          deduplicationKey:
            `task:${input.job.taskId}:candidate:${input.job.stateId}:screened:${updatedState.version}`,
          correlationId: integration.correlationId,
          eventType: "candidate.screened.v1",
          aggregateType: "candidate_state",
          aggregateId: input.job.stateId,
          aggregateVersion: updatedState.version,
          payload: {
            taskId: input.job.taskId,
            screeningRunId: integration.odooRunId,
            odooDatabaseUuid: integration.odooDatabaseUuid,
            odooJobId: integration.odooJobId,
            candidateStateId: input.job.stateId,
            ruleVersionId: input.job.ruleVersionId,
            decision: input.record.decision,
            score: Number((input.record.confidence * 100).toFixed(2)),
            confidence: input.record.confidence,
            reviewStatus: updatedState.review_status,
            currentEnglishLevel: input.record.currentEnglishLevel,
            dictionaryVersion: input.record.dictionaryVersion,
            ...(input.record.institutionDecision
              ? { institutionDecision: input.record.institutionDecision }
              : {}),
            ...(input.record.institutionSummary
              ? { institutionSummary: input.record.institutionSummary }
              : {}),
            ...(input.record.institutionCatalogVersion
              ? { institutionCatalogVersion: input.record.institutionCatalogVersion }
              : {}),
            ...(input.record.education ? { education: input.record.education } : {}),
            reasonCodes: input.record.reasonCodes,
            evidence: input.record.evidence
          }
        });
      }
      await enqueueTaskCompletionIfReady(transaction, input.job.taskId);
    });
  }

  async completeResumeScreeningWithoutText(input: {
    stateId: string;
    taskId: string;
    screenshotPath: string | null;
    workerId: string;
  }): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const taskRows = await transaction<Array<{ status: Task["status"] }>>`
        SELECT status FROM tasks WHERE id = ${input.taskId} FOR UPDATE
      `;
      if (!taskRows[0]) throw new Error("Resume screening task was not found.");
      if (!["screening", "waiting_review"].includes(taskRows[0].status)) return;
      const updatedStates = await transaction<Array<{ version: number }>>`
        UPDATE candidate_position_states
        SET rule_decision = 'insufficient', rule_confidence = 0,
          resume_screening_status = 'no_text',
          resume_screenshot_path = ${input.screenshotPath},
          resume_screened_at = now(),
          resume_screening_error = '简历已预览，但未取得可用于自动筛选的 OCR 文本。',
          resume_screening_claimed_by = NULL,
          resume_screening_claimed_at = NULL,
          review_status = CASE
            WHEN review_status IN ('approved', 'rejected') THEN review_status ELSE 'pending'
          END,
          version = version + 1,
          updated_at = now()
        WHERE id = ${input.stateId}
          AND latest_task_id = ${input.taskId}
          AND resume_screening_status = 'processing'
        RETURNING version
      `;
      const updatedState = updatedStates[0];
      if (!updatedState) throw new Error("Candidate resume screening claim is no longer active.");
      await transaction`
        INSERT INTO audit_logs (
          id, actor_id, action, resource_type, resource_id, payload
        ) VALUES (
          ${randomUUID()}, ${input.workerId}, 'candidate.resume_screening.no_text',
          'candidate_position_state', ${input.stateId},
          ${transaction.json({ taskId: input.taskId, screenshotAvailable: Boolean(input.screenshotPath) })}
        )
      `;
      await transaction`
        UPDATE tasks
        SET status = CASE
            WHEN EXISTS (
              SELECT 1 FROM candidate_position_states
              WHERE latest_task_id = ${input.taskId}
                AND resume_screening_status IN ('queued', 'processing')
            ) THEN 'screening'
            ELSE 'waiting_review'
          END,
          finished_at = CASE
            WHEN EXISTS (
              SELECT 1 FROM candidate_position_states
              WHERE latest_task_id = ${input.taskId}
                AND resume_screening_status IN ('queued', 'processing')
            ) THEN NULL ELSE now()
          END
        WHERE id = ${input.taskId} AND status IN ('screening', 'waiting_review')
      `;
      const integration = await loadTaskIntegrationContext(transaction, input.taskId);
      if (integration) {
        await enqueueIntegrationEvent(transaction, {
          deduplicationKey:
            `task:${input.taskId}:candidate:${input.stateId}:screening-no-text:${updatedState.version}`,
          correlationId: integration.correlationId,
          eventType: "candidate.screening_failed.v1",
          aggregateType: "candidate_state",
          aggregateId: input.stateId,
          aggregateVersion: updatedState.version,
          payload: {
            taskId: input.taskId,
            screeningRunId: integration.odooRunId,
            odooDatabaseUuid: integration.odooDatabaseUuid,
            odooJobId: integration.odooJobId,
            candidateStateId: input.stateId,
            failureCode: "no_text",
            message: "简历已预览，但未取得可用于自动筛选的 OCR 文本。",
            recoverable: true
          }
        });
      }
      await enqueueTaskCompletionIfReady(transaction, input.taskId);
    });
  }

  async failResumeScreening(input: {
    stateId: string;
    taskId: string;
    message: string;
    workerId: string;
  }): Promise<void> {
    const message = input.message.slice(0, 1_000);
    await this.sql.begin(async (transaction) => {
      const taskRows = await transaction<Array<{ status: Task["status"] }>>`
        SELECT status FROM tasks WHERE id = ${input.taskId} FOR UPDATE
      `;
      if (!taskRows[0]) throw new Error("Resume screening task was not found.");
      if (!["screening", "waiting_review"].includes(taskRows[0].status)) return;
      const updatedStates = await transaction<Array<{ version: number }>>`
        UPDATE candidate_position_states
        SET rule_decision = 'insufficient', rule_confidence = 0,
          resume_screening_status = 'failed', resume_screening_error = ${message},
          resume_screening_claimed_by = NULL, resume_screening_claimed_at = NULL,
          review_status = CASE
            WHEN review_status IN ('approved', 'rejected') THEN review_status ELSE 'pending'
          END,
          version = version + 1,
          updated_at = now()
        WHERE id = ${input.stateId}
          AND latest_task_id = ${input.taskId}
          AND EXISTS (
            SELECT 1 FROM tasks
            WHERE tasks.id = candidate_position_states.latest_task_id
              AND tasks.status IN ('screening', 'waiting_review')
          )
        RETURNING version
      `;
      const updatedState = updatedStates[0];
      if (!updatedState) throw new Error("Candidate state not found during screening failure.");
      await transaction`
        INSERT INTO audit_logs (
          id, actor_id, action, resource_type, resource_id, payload
        ) VALUES (
          ${randomUUID()}, ${input.workerId}, 'candidate.resume_screening.failed',
          'candidate_position_state', ${input.stateId},
          ${transaction.json({ taskId: input.taskId, message })}
        )
      `;
      await transaction`
        UPDATE tasks
        SET status = CASE
            WHEN EXISTS (
              SELECT 1 FROM candidate_position_states
              WHERE latest_task_id = ${input.taskId}
                AND resume_screening_status IN ('queued', 'processing')
            ) THEN 'screening'
            ELSE 'waiting_review'
          END,
          finished_at = CASE
            WHEN EXISTS (
              SELECT 1 FROM candidate_position_states
              WHERE latest_task_id = ${input.taskId}
                AND resume_screening_status IN ('queued', 'processing')
            ) THEN NULL ELSE now()
          END
        WHERE id = ${input.taskId} AND status IN ('screening', 'waiting_review')
      `;
      const integration = await loadTaskIntegrationContext(transaction, input.taskId);
      if (integration) {
        await enqueueIntegrationEvent(transaction, {
          deduplicationKey:
            `task:${input.taskId}:candidate:${input.stateId}:screening-failed:${updatedState.version}`,
          correlationId: integration.correlationId,
          eventType: "candidate.screening_failed.v1",
          aggregateType: "candidate_state",
          aggregateId: input.stateId,
          aggregateVersion: updatedState.version,
          payload: {
            taskId: input.taskId,
            screeningRunId: integration.odooRunId,
            odooDatabaseUuid: integration.odooDatabaseUuid,
            odooJobId: integration.odooJobId,
            candidateStateId: input.stateId,
            failureCode: "worker_error",
            message,
            recoverable: true
          }
        });
      }
      await enqueueTaskCompletionIfReady(transaction, input.taskId);
    });
  }

  async requeueResumeScreening(stateId: string, actorId: string): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const currentStates = await transaction<Array<{ latest_task_id: string }>>`
        SELECT latest_task_id FROM candidate_position_states WHERE id = ${stateId}
      `;
      const taskId = currentStates[0]?.latest_task_id;
      if (!taskId) throw new Error("Candidate state was not found.");
      const taskRows = await transaction<Array<{ status: Task["status"] }>>`
        SELECT status FROM tasks WHERE id = ${taskId} FOR UPDATE
      `;
      if (!taskRows[0] || !["screening", "waiting_review"].includes(taskRows[0].status)) {
        throw new Error("Candidate screening task is not open for requeue.");
      }
      const rows = await transaction<{ id: string; latest_task_id: string }[]>`
        UPDATE candidate_position_states
        SET resume_screening_status = 'queued', resume_screening_error = NULL,
          resume_screening_claimed_by = NULL, resume_screening_claimed_at = NULL,
          version = version + 1, updated_at = now()
        WHERE id = ${stateId} AND latest_task_id = ${taskId}
          AND resume_screening_status <> 'processing'
        RETURNING id, latest_task_id
      `;
      const state = rows[0];
      if (!state) throw new Error("Candidate state was not found or is currently processing.");
      await transaction`
        UPDATE tasks SET status = 'screening', finished_at = NULL
        WHERE id = ${state.latest_task_id}
      `;
      await transaction`
        INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
        VALUES (
          ${randomUUID()}, ${actorId}, 'candidate.resume_screening.requeued',
          'candidate_position_state', ${stateId},
          ${transaction.json({ taskId: state.latest_task_id })}
        )
      `;
    });
  }

  async failTask(taskId: string, message: string, claimToken: string | null): Promise<void> {
    const errorMessage = message.slice(0, 1_000);
    await this.sql.begin(async (transaction) => {
      const taskRows = await transaction<
        Array<{
          status: Task["status"];
          candidate_count: number;
          created_by: string;
          claim_token: string | null;
        }>
      >`
        SELECT status, candidate_count, created_by, claim_token
        FROM tasks WHERE id = ${taskId} FOR UPDATE
      `;
      const task = taskRows[0];
      if (!task) throw new Error("Task was not found during failure handling.");
      if (["cancelled", "completed", "failed"].includes(task.status)) return;
      if (task.status !== "running" || !claimToken || task.claim_token !== claimToken) return;
      await transaction`
        UPDATE tasks SET status = 'failed', error_message = ${errorMessage}, finished_at = now(),
          claimed_by = NULL, claim_token = NULL, claimed_at = NULL
        WHERE id = ${taskId}
      `;
      await transaction`
        INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
        VALUES (
          ${randomUUID()}, ${task.created_by}, 'task.failed', 'task', ${taskId},
          ${transaction.json({ errorMessage })}
        )
      `;
      const integration = await loadTaskIntegrationContext(transaction, taskId);
      if (integration) {
        await enqueueIntegrationEvent(transaction, {
          deduplicationKey: `task:${taskId}:failed`,
          correlationId: integration.correlationId,
          eventType: "screening.run.completed.v1",
          aggregateType: "screening_run",
          aggregateId: integration.odooRunId,
          aggregateVersion: 1,
          payload: {
            taskId,
            screeningRunId: integration.odooRunId,
            odooDatabaseUuid: integration.odooDatabaseUuid,
            odooJobId: integration.odooJobId,
            status: "failed",
            collectedCount: Number(task.candidate_count),
            matchedCount: 0,
            failedCount: Number(task.candidate_count),
            pendingReviewCount: 0,
            errorMessage
          }
        });
      }
    });
  }

  async getCandidateDetail(stateId: string): Promise<CandidateDetail | null> {
    const rows = await this.sql<
      Array<{
        state_id: string;
        candidate_id: string;
        display_name: string;
        position_name: string;
        rule_decision: DashboardCandidate["ruleDecision"];
        rule_confidence: number;
        review_status: DashboardCandidate["reviewStatus"];
        contact_status: DashboardCandidate["contactStatus"];
        state_version: number;
        resume_screening_status: DashboardCandidate["resumeScreeningStatus"];
        current_english_level: string | null;
        resume_screened_at: Date | null;
        resume_screening_error: string | null;
        resume_screenshot_path: string | null;
        source_evidence: string[];
        raw_fields: Record<string, string>;
        raw_text: string;
        source: string;
        collected_at: Date;
        updated_at: Date;
        rule_version: number;
        dictionary_version: string;
      }>
    >`
      SELECT cps.id AS state_id, c.id AS candidate_id, c.display_name,
        p.name AS position_name, cps.rule_decision, cps.rule_confidence,
        cps.review_status, cps.contact_status, cps.version AS state_version,
        cps.resume_screening_status, cps.current_english_level,
        cps.resume_screened_at, cps.resume_screening_error, cps.resume_screenshot_path,
        cs.source_evidence, cs.raw_fields, cs.raw_text, cs.source, cs.collected_at,
        cps.updated_at, rv.version AS rule_version, rv.dictionary_version
      FROM candidate_position_states cps
      JOIN candidates c ON c.id = cps.candidate_id
      JOIN positions p ON p.id = cps.position_id
      JOIN candidate_snapshots cs ON cs.id = cps.latest_snapshot_id
      JOIN rule_versions rv ON rv.id = cps.rule_version_id
      WHERE cps.id = ${stateId}
    `;
    const row = rows[0];
    if (!row) return null;
    const [evidenceRows, reviewRows] = await Promise.all([
      this.sql<
        Array<{
          capability_id: string;
          canonical_label: string;
          dictionary_version: string;
          source_text: string;
          normalized_alias: string;
          evidence_status: "positive" | "negative" | "ambiguous";
          confidence: number;
          reason_codes: string[];
        }>
      >`
        SELECT capability_id, canonical_label, dictionary_version, source_text,
          normalized_alias, evidence_status, confidence, reason_codes
        FROM match_evidence
        WHERE candidate_position_state_id = ${stateId}
        ORDER BY created_at ASC
      `,
      this.sql<
        Array<{
          id: string;
          candidate_position_state_id: string;
          decision: ReviewRecord["decision"];
          note: string;
          correction_code: string | null;
          reviewer_id: string;
          previous_status: ReviewRecord["previousStatus"];
          resulting_version: number;
          created_at: Date;
        }>
      >`
        SELECT id, candidate_position_state_id, decision, note, correction_code, reviewer_id,
          previous_status, resulting_version, created_at
        FROM reviews
        WHERE candidate_position_state_id = ${stateId}
        ORDER BY created_at DESC
      `
    ]);
    return {
      stateId: row.state_id,
      candidateId: row.candidate_id,
      name: row.display_name,
      positionName: row.position_name,
      ruleDecision: row.rule_decision,
      ruleConfidence: row.rule_confidence,
      reviewStatus: row.review_status,
      contactStatus: row.contact_status,
      stateVersion: row.state_version,
      resumeScreeningStatus: row.resume_screening_status,
      currentEnglishLevel: row.current_english_level,
      resumeScreenedAt: row.resume_screened_at ? iso(row.resume_screened_at) : null,
      resumeScreeningError: row.resume_screening_error,
      resumeScreenshotAvailable: Boolean(row.resume_screenshot_path),
      evidence: row.source_evidence,
      fields: row.raw_fields,
      updatedAt: iso(row.updated_at),
      rawText: row.raw_text,
      source: row.source,
      collectedAt: iso(row.collected_at),
      ruleVersion: row.rule_version,
      dictionaryVersion: row.dictionary_version,
      matchEvidence: evidenceRows.map((item) => ({
        capabilityId: item.capability_id,
        canonicalLabel: item.canonical_label,
        dictionaryVersion: item.dictionary_version,
        sourceText: item.source_text,
        normalizedAlias: item.normalized_alias,
        status: item.evidence_status,
        confidence: item.confidence,
        reasonCodes: item.reason_codes
      })),
      reviews: reviewRows.map((item) => ({
        id: item.id,
        decision: item.decision,
        note: item.note,
        correctionCode: item.correction_code,
        reviewerId: item.reviewer_id,
        previousStatus: item.previous_status,
        resultingVersion: item.resulting_version,
        createdAt: iso(item.created_at)
      }))
    };
  }

  async reviewCandidate(input: {
    stateId: string;
    idempotencyKey: string;
    decision: "approved" | "rejected";
    note: string;
    correctionCode?: string | null;
    reviewerId: string;
    expectedVersion: number;
  }): Promise<ReviewRecord> {
    return this.sql.begin(async (transaction) => {
      const existing = await transaction<
        Array<{
          id: string;
          candidate_position_state_id: string;
          decision: ReviewRecord["decision"];
          note: string;
          correction_code: string | null;
          reviewer_id: string;
          previous_status: ReviewRecord["previousStatus"];
          resulting_version: number;
          created_at: Date;
        }>
      >`
        SELECT id, candidate_position_state_id, decision, note, correction_code, reviewer_id,
          previous_status, resulting_version, created_at
        FROM reviews WHERE idempotency_key = ${input.idempotencyKey}
      `;
      const replay = existing[0];
      if (replay) {
        if (replay.candidate_position_state_id !== input.stateId) {
          throw new Error("Idempotency-Key is already used for another candidate state.");
        }
        return {
          id: replay.id,
          decision: replay.decision,
          note: replay.note,
          correctionCode: replay.correction_code,
          reviewerId: replay.reviewer_id,
          previousStatus: replay.previous_status,
          resultingVersion: replay.resulting_version,
          createdAt: iso(replay.created_at)
        };
      }
      const stateRows = await transaction<
        Array<{
          version: number;
          review_status: ReviewRecord["previousStatus"];
          resume_screening_status: DashboardCandidate["resumeScreeningStatus"];
        }>
      >`
        SELECT version, review_status, resume_screening_status FROM candidate_position_states
        WHERE id = ${input.stateId}
        FOR UPDATE
      `;
      const state = stateRows[0];
      if (!state) throw new Error("Candidate state was not found.");
      if (["not_requested", "queued", "processing"].includes(state.resume_screening_status)) {
        throw new Error("Candidate resume screening must finish before human review.");
      }
      if (state.version !== input.expectedVersion) {
        throw new OptimisticLockError(input.expectedVersion, state.version);
      }
      const reviewId = randomUUID();
      const resultingVersion = state.version + 1;
      const rows = await transaction<
        Array<{
          id: string;
          decision: ReviewRecord["decision"];
          note: string;
          correction_code: string | null;
          reviewer_id: string;
          previous_status: ReviewRecord["previousStatus"];
          resulting_version: number;
          created_at: Date;
        }>
      >`
        INSERT INTO reviews (
          id, candidate_position_state_id, idempotency_key, decision, note,
          correction_code, reviewer_id, previous_status, resulting_version
        ) VALUES (
          ${reviewId}, ${input.stateId}, ${input.idempotencyKey}, ${input.decision},
          ${input.note}, ${input.correctionCode ?? null}, ${input.reviewerId},
          ${state.review_status}, ${resultingVersion}
        ) RETURNING id, decision, note, correction_code, reviewer_id,
          previous_status, resulting_version, created_at
      `;
      await transaction`
        UPDATE candidate_position_states
        SET review_status = ${input.decision}, version = ${resultingVersion}, updated_at = now()
        WHERE id = ${input.stateId}
      `;
      await transaction`
        INSERT INTO audit_logs (
          id, actor_id, action, resource_type, resource_id, payload
        ) VALUES (
          ${randomUUID()}, ${input.reviewerId}, ${`candidate.review.${input.decision}`},
          'candidate_position_state', ${input.stateId},
          ${transaction.json({
            reviewId,
            previousStatus: state.review_status,
            resultingVersion,
            correctionCode: input.correctionCode ?? null
          })}
        )
      `;
      await enqueueTaskCompletionIfReady(transaction, input.stateId);
      const row = rows[0]!;
      return {
        id: row.id,
        decision: row.decision,
        note: row.note,
        correctionCode: row.correction_code,
        reviewerId: row.reviewer_id,
        previousStatus: row.previous_status,
        resultingVersion: row.resulting_version,
        createdAt: iso(row.created_at)
      };
    });
  }

  async getDashboard(): Promise<DashboardSnapshot> {
    const [positions, activeRuleRows, taskRows, candidateRows, metricRows] = await Promise.all([
      this.listPositions(),
      this.sql<
        Array<{
          position_id: string;
          id: string;
          version: number;
          config: RuleConfig;
          dictionary_version: string;
          created_at: Date;
        }>
      >`
        SELECT rs.position_id, rv.id, rv.version, rv.config,
          rv.dictionary_version, rv.created_at
        FROM rule_sets rs
        JOIN rule_versions rv ON rv.id = rs.active_version_id
        ORDER BY rs.position_id
      `,
      this.sql.unsafe<TaskRow[]>(`${TASK_SELECT} ORDER BY t.created_at DESC LIMIT 10`),
      this.sql<
        Array<{
          state_id: string;
          candidate_id: string;
          display_name: string;
          position_name: string;
          rule_decision: DashboardCandidate["ruleDecision"];
          rule_confidence: number;
          review_status: DashboardCandidate["reviewStatus"];
          contact_status: DashboardCandidate["contactStatus"];
          state_version: number;
          resume_screening_status: DashboardCandidate["resumeScreeningStatus"];
          current_english_level: string | null;
          resume_screened_at: Date | null;
          resume_screening_error: string | null;
          source_evidence: string[];
          raw_fields: Record<string, string>;
          updated_at: Date;
        }>
      >`
        WITH candidate_source AS (
          SELECT cps.id AS state_id, c.id AS candidate_id, c.display_name,
            p.id AS position_id, p.name AS position_name,
            cps.rule_decision, cps.rule_confidence,
            cps.review_status, cps.contact_status, cps.version AS state_version,
            cps.resume_screening_status, cps.current_english_level,
            cps.resume_screened_at, cps.resume_screening_error,
            cs.source_evidence, cs.raw_fields, cps.updated_at,
            CASE
              WHEN NULLIF(BTRIM(cs.raw_fields ->> '信息'), '') IS NULL THEN c.id::text
              ELSE LOWER(BTRIM(c.display_name)) || E'\x1f' ||
                REGEXP_REPLACE(LOWER(BTRIM(cs.raw_fields ->> '信息')), '\\s+', ' ', 'g')
            END AS candidate_identity
          FROM candidate_position_states cps
          JOIN candidates c ON c.id = cps.candidate_id
          JOIN positions p ON p.id = cps.position_id
          JOIN candidate_snapshots cs ON cs.id = cps.latest_snapshot_id
        ), ranked_candidates AS (
          SELECT candidate_source.*,
            ROW_NUMBER() OVER (
              PARTITION BY position_id, candidate_identity
              ORDER BY
                CASE review_status WHEN 'approved' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
                CASE resume_screening_status WHEN 'screened' THEN 0 ELSE 1 END,
                updated_at DESC
            ) AS identity_rank
          FROM candidate_source
        )
        SELECT state_id, candidate_id, display_name, position_name,
          rule_decision, rule_confidence, review_status, contact_status,
          state_version, resume_screening_status, current_english_level,
          resume_screened_at, resume_screening_error, source_evidence,
          raw_fields, updated_at
        FROM ranked_candidates
        WHERE identity_rank = 1
          AND review_status IN ('pending', 'approved', 'not_required')
        ORDER BY
          CASE rule_decision WHEN 'matched' THEN 0 WHEN 'ambiguous' THEN 1 ELSE 2 END,
          rule_confidence DESC, updated_at DESC
      `,
      this.sql<
        Array<{
          total_candidates: number;
          matched_candidates: number;
          pending_review: number;
          contacted_today: number;
        }>
      >`
        WITH candidate_source AS (
          SELECT cps.*,
            CASE
              WHEN NULLIF(BTRIM(cs.raw_fields ->> '信息'), '') IS NULL THEN c.id::text
              ELSE LOWER(BTRIM(c.display_name)) || E'\x1f' ||
                REGEXP_REPLACE(LOWER(BTRIM(cs.raw_fields ->> '信息')), '\\s+', ' ', 'g')
            END AS candidate_identity
          FROM candidate_position_states cps
          JOIN candidates c ON c.id = cps.candidate_id
          JOIN candidate_snapshots cs ON cs.id = cps.latest_snapshot_id
        ), ranked_candidates AS (
          SELECT candidate_source.*,
            ROW_NUMBER() OVER (
              PARTITION BY candidate_identity
              ORDER BY
                CASE review_status WHEN 'approved' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
                CASE resume_screening_status WHEN 'screened' THEN 0 ELSE 1 END,
                updated_at DESC
            ) AS identity_rank
          FROM candidate_source
        )
        SELECT
          COUNT(*)::int AS total_candidates,
          COUNT(*) FILTER (
            WHERE rule_decision = 'matched' AND resume_screening_status = 'screened'
          )::int AS matched_candidates,
          COUNT(*) FILTER (
            WHERE review_status = 'pending'
              AND resume_screening_status IN ('screened', 'no_text', 'failed')
          )::int AS pending_review,
          COUNT(*) FILTER (
            WHERE contact_status = 'sent' AND updated_at >= date_trunc('day', now())
          )::int AS contacted_today
        FROM ranked_candidates
        WHERE identity_rank = 1
      `
    ]);
    const metrics = metricRows[0]!;
    return {
      metrics: {
        totalCandidates: metrics.total_candidates,
        matchedCandidates: metrics.matched_candidates,
        pendingReview: metrics.pending_review,
        contactedToday: metrics.contacted_today
      },
      positions,
      activeRules: activeRuleRows.map((row) => ({
        positionId: row.position_id,
        id: row.id,
        version: row.version,
        config: row.config,
        dictionaryVersion: row.dictionary_version,
        createdAt: iso(row.created_at)
      })),
      tasks: taskRows.map(mapTask),
      candidates: candidateRows.map((row) => ({
        stateId: row.state_id,
        candidateId: row.candidate_id,
        name: row.display_name,
        positionName: row.position_name,
        ruleDecision: row.rule_decision,
        ruleConfidence: row.rule_confidence,
        reviewStatus: row.review_status,
        contactStatus: row.contact_status,
        stateVersion: row.state_version,
        resumeScreeningStatus: row.resume_screening_status,
        currentEnglishLevel: row.current_english_level,
        resumeScreenedAt: row.resume_screened_at ? iso(row.resume_screened_at) : null,
        resumeScreeningError: row.resume_screening_error,
        evidence: row.source_evidence,
        fields: row.raw_fields,
        updatedAt: iso(row.updated_at)
      }))
    };
  }
}
