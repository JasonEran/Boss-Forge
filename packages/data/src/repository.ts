import { randomUUID } from "node:crypto";
import type { Database } from "./client.js";
import type {
  CandidateEvaluationRecord,
  DashboardCandidate,
  DashboardSnapshot,
  Position,
  RuleConfig,
  RuleVersion,
  Task
} from "./types.js";

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
    createdAt: iso(row.created_at)
  };
}

const TASK_SELECT = `
  SELECT t.id, t.idempotency_key, t.position_id, p.name AS position_name,
    p.boss_job_keyword, t.rule_version_id, rv.config AS rule_config,
    t.execution_mode, t.source, t.search_keyword, t.status, t.created_by,
    t.candidate_count, t.error_message, t.created_at
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

  async claimNextTask(workerId: string): Promise<Task | null> {
    return this.sql.begin(async (transaction) => {
      const selected = await transaction<{ id: string }[]>`
        SELECT id FROM tasks
        WHERE status = 'queued'
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `;
      const id = selected[0]?.id;
      if (!id) return null;
      await transaction`
        UPDATE tasks SET status = 'running', claimed_by = ${workerId}, started_at = now()
        WHERE id = ${id}
      `;
      const rows = await transaction.unsafe<TaskRow[]>(`${TASK_SELECT} WHERE t.id = $1`, [id]);
      return mapTask(rows[0]!);
    });
  }

  async completeTask(task: Task, records: CandidateEvaluationRecord[]): Promise<void> {
    await this.sql.begin(async (transaction) => {
      for (const record of records) {
        const candidateRows = await transaction<{ id: string }[]>`
          INSERT INTO candidates (id, fingerprint, display_name)
          VALUES (${randomUUID()}, ${record.fingerprint}, ${record.displayName})
          ON CONFLICT (fingerprint) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            updated_at = now()
          RETURNING id
        `;
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
        const stateRows = await transaction<{ id: string }[]>`
          INSERT INTO candidate_position_states (
            id, position_id, candidate_id, latest_task_id, latest_snapshot_id,
            rule_version_id, rule_decision, rule_confidence, review_status
          ) VALUES (
            ${randomUUID()}, ${task.positionId}, ${candidateId}, ${task.id}, ${snapshotId},
            ${task.ruleVersionId}, ${record.decision}, ${record.confidence},
            ${record.decision === "not_matched" ? "not_required" : "pending"}
          )
          ON CONFLICT (position_id, candidate_id) DO UPDATE SET
            latest_task_id = EXCLUDED.latest_task_id,
            latest_snapshot_id = EXCLUDED.latest_snapshot_id,
            rule_version_id = EXCLUDED.rule_version_id,
            rule_decision = EXCLUDED.rule_decision,
            rule_confidence = EXCLUDED.rule_confidence,
            review_status = EXCLUDED.review_status,
            updated_at = now()
          RETURNING id
        `;
        const stateId = stateRows[0]!.id;
        await transaction`DELETE FROM match_evidence WHERE candidate_position_state_id = ${stateId}`;
        for (const evidence of record.evidence) {
          await transaction`
            INSERT INTO match_evidence (
              id, candidate_position_state_id, capability_id, canonical_label,
              dictionary_version, source_text, normalized_alias, evidence_status,
              confidence, reason_codes
            ) VALUES (
              ${randomUUID()}, ${stateId}, ${record.capabilityId}, ${record.canonicalLabel},
              ${record.dictionaryVersion}, ${evidence.sourceText}, ${evidence.normalizedAlias},
              ${evidence.status}, ${evidence.confidence}, ${transaction.json(record.reasonCodes)}
            )
          `;
        }
      }
      const status = records.length > 0 ? "waiting_review" : "completed";
      await transaction`
        UPDATE tasks SET status = ${status}, candidate_count = ${records.length},
          finished_at = now(), error_message = NULL
        WHERE id = ${task.id}
      `;
      await transaction`
        INSERT INTO audit_logs (
          id, actor_id, action, resource_type, resource_id, payload
        ) VALUES (
          ${randomUUID()}, ${task.createdBy}, 'task.collection.completed',
          'task', ${task.id}, ${transaction.json({ candidateCount: records.length })}
        )
      `;
    });
  }

  async failTask(taskId: string, message: string): Promise<void> {
    await this.sql`
      UPDATE tasks SET status = 'failed', error_message = ${message}, finished_at = now()
      WHERE id = ${taskId}
    `;
  }

  async getDashboard(): Promise<DashboardSnapshot> {
    const [positions, taskRows, candidateRows, metricRows] = await Promise.all([
      this.listPositions(),
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
          source_evidence: string[];
          raw_fields: Record<string, string>;
          updated_at: Date;
        }>
      >`
        SELECT cps.id AS state_id, c.id AS candidate_id, c.display_name,
          p.name AS position_name, cps.rule_decision, cps.rule_confidence,
          cps.review_status, cps.contact_status, cs.source_evidence, cs.raw_fields,
          cps.updated_at
        FROM candidate_position_states cps
        JOIN candidates c ON c.id = cps.candidate_id
        JOIN positions p ON p.id = cps.position_id
        JOIN candidate_snapshots cs ON cs.id = cps.latest_snapshot_id
        WHERE cps.review_status = 'pending'
        ORDER BY
          CASE cps.rule_decision WHEN 'matched' THEN 0 WHEN 'ambiguous' THEN 1 ELSE 2 END,
          cps.rule_confidence DESC, cps.updated_at DESC
        LIMIT 50
      `,
      this.sql<
        Array<{
          total_candidates: number;
          matched_candidates: number;
          pending_review: number;
          contacted_today: number;
        }>
      >`
        SELECT
          COUNT(*)::int AS total_candidates,
          COUNT(*) FILTER (WHERE rule_decision = 'matched')::int AS matched_candidates,
          COUNT(*) FILTER (WHERE review_status = 'pending')::int AS pending_review,
          COUNT(*) FILTER (
            WHERE contact_status = 'sent' AND updated_at >= date_trunc('day', now())
          )::int AS contacted_today
        FROM candidate_position_states
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
        evidence: row.source_evidence,
        fields: row.raw_fields,
        updatedAt: iso(row.updated_at)
      }))
    };
  }
}
