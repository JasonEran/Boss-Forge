import { enqueueRecruitmentAssessment } from "./recruitment-repository.js";
import { limitScreeningRecords } from "./screening-limit.js";
import { screeningCandidateLimit, screeningBudgetMet, dailyAutoGreetCapStopMessage, SCREENING_CHUNK_SIZE } from "@boss-forge/contracts";
import {
  applyScreeningBudgetSeal,
  screeningBudgetMetWaitExcludedSql,
  screeningBudgetStillOpenSql,
  screeningTerminalWaitExcludedSql,
} from "./screening-budget.js";
import { assertRuleScreeningSource } from "./rule-config.js";
import { randomUUID } from "node:crypto";
import { bossRecommendationFilterPlanSchema, type BossRecommendationFilterPlan } from "@boss-forge/contracts";
import type { SemanticEvaluation } from "@boss-forge/semantic-engine";
import type { Database } from "./client.js";
import type {
  CandidateEvaluationRecord,
  CandidateDetail,
  DashboardCandidate,
  DashboardSnapshot,
  Position,
  RuleConfig,
  RuleVersion,
  SemanticEvaluationSummary,
  ResumeScreeningErrorCode,
  ResumeScreeningJob,
  ReviewRecord,
  Task,
  TaskWaitReasonCode,
} from "./types.js";
import { summarizeFailedRuleLabels, summarizeMissingRuleLabels } from "./rule-failure.js";
import {
  enqueueIntegrationEvent,
  enqueueTaskCompletionIfReady,
  loadTaskIntegrationContext,
} from "./integration-events.js";

export class OptimisticLockError extends Error {
  constructor(
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(`State version conflict: expected ${expectedVersion}, actual ${actualVersion}.`);
    this.name = "OptimisticLockError";
  }
}

/**
 * The resume claim was cancelled, replaced, or otherwise ceased to belong to
 * this worker before any BOSS preview was started. Callers must treat this as
 * a no-side-effect skip rather than turning the candidate into a failed or
 * retryable screening state.
 */
export class ResumeScreeningLeaseLostError extends Error {
  constructor() {
    super(
      "简历查看租约已失效（任务可能已取消或被重新领取）；未打开 BOSS 简历，也未计入本次查看。",
    );
    this.name = "ResumeScreeningLeaseLostError";
  }
}

type PositionRow = {
  id: string;
  boss_account_id: string;
  name: string;
  boss_job_keyword: string | null;
  boss_job_id: string | null;
  boss_job_name_unique: boolean;
  boss_job_status: string | null;
  boss_synced_at: Date | null;
  status: Position["status"];
  owner_name: string;
  semantic_mode: Position["semanticMode"];
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
  boss_job_id: string | null;
  boss_job_name_unique: boolean;
  rule_version_id: string;
  rule_version: number;
  dictionary_version: string;
  rule_config: RuleConfig;
  source_boss_filters: BossRecommendationFilterPlan | null;
  execution_mode: Task["executionMode"];
  source: Task["source"];
  search_keyword: string | null;
  status: Task["status"];
  created_by: string;
  candidate_count: number;
  candidate_limit: number;
  auto_greet: boolean;
  new_candidate_count: number;
  repeat_candidate_count: number;
  error_message: string | null;
  wait_reason_code: TaskWaitReasonCode | null;
  wait_reason: string | null;
  next_run_at: Date | null;
  version: number;
  claim_token: string | null;
  created_at: Date;
};

function iso(value: Date): string {
  return value.toISOString();
}

// Manual recovery only. Worker automatic retry remains limited to temporary
// preview/content failures; missing cards must first be resolved in the task context.
const RETRYABLE_RESUME_ERROR_CODES: readonly ResumeScreeningErrorCode[] = [
  "source_expired",
  "target_missing",
  "content_empty",
  "content_incomplete",
  "preview_not_opened",
  "ocr_failed",
  "historical_result_needs_recheck",
  "worker_error",
];

export function resumeScreeningFailureRecoverable(
  errorCode: ResumeScreeningErrorCode | null,
): boolean {
  return errorCode === null || RETRYABLE_RESUME_ERROR_CODES.includes(errorCode);
}

function summarizeSemanticEvaluations(
  evaluations: Array<{
    result: "matched" | "not_matched" | "unknown";
    runtime_mode: "off" | "shadow" | "active";
    reason_codes: string[];
  }>,
): SemanticEvaluationSummary {
  return {
    mode: evaluations.some((item) => item.runtime_mode === "active")
      ? "active"
      : evaluations.some((item) => item.runtime_mode === "shadow")
        ? "shadow"
        : evaluations.length > 0
          ? "off"
          : null,
    total: evaluations.length,
    matched: evaluations.filter((item) => item.result === "matched").length,
    notMatched: evaluations.filter((item) => item.result === "not_matched").length,
    unknown: evaluations.filter((item) => item.result === "unknown").length,
    modelError: evaluations.some((item) =>
      semanticReasonCodesIndicateRuntimeProblem(item.reason_codes),
    ),
  };
}

export function semanticReasonCodesIndicateRuntimeProblem(
  reasonCodes: readonly string[],
): boolean {
  return reasonCodes.some((reason) =>
    [
      "semantic_model_error",
      "semantic_model_unavailable",
      "semantic_model_missing_result",
    ].includes(reason),
  );
}

function mapPosition(row: PositionRow): Position {
  return {
    id: row.id,
    bossAccountId: row.boss_account_id,
    name: row.name,
    bossJobKeyword: row.boss_job_keyword,
    bossJobId: row.boss_job_id,
    bossJobNameUnique: row.boss_job_name_unique,
    bossJobStatus: row.boss_job_status,
    bossSyncedAt: row.boss_synced_at?.toISOString() ?? null,
    status: row.status,
    ownerName: row.owner_name,
    semanticMode: row.semantic_mode,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
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
    bossJobId: row.boss_job_id,
    bossJobNameUnique: row.boss_job_name_unique,
    ruleVersionId: row.rule_version_id,
    ruleVersion: row.rule_version,
    dictionaryVersion: row.dictionary_version,
    ruleConfig: row.rule_config,
    sourceBossFilters: row.source_boss_filters ?? null,
    executionMode: row.execution_mode,
    source: row.source,
    searchKeyword: row.search_keyword,
    status: row.status,
    createdBy: row.created_by,
    candidateCount: row.candidate_count,
    candidateLimit: row.candidate_limit,
    autoGreet: row.auto_greet,
    newCandidateCount: row.new_candidate_count,
    repeatCandidateCount: row.repeat_candidate_count,
    errorMessage: row.error_message,
    waitReasonCode: row.wait_reason_code,
    waitReason: row.wait_reason,
    nextRunAt: row.next_run_at ? iso(row.next_run_at) : null,
    nextAction: taskNextAction(row),
    version: row.version,
    claimToken: row.claim_token,
    createdAt: iso(row.created_at),
  };
}

function taskNextAction(row: TaskRow): string {
  if (row.wait_reason) return row.wait_reason;
  switch (row.status) {
    case "queued":
      return "等待筛选服务领取任务";
    case "running":
      return "正在从 BOSS 获取候选人";
    case "screening":
      return "系统将按安全节奏继续查看简历";
    case "waiting_review":
      return "请审核已完成精筛的候选人";
    case "completed":
      return row.candidate_count === 0
        ? "本次未采集到候选人，可检查 BOSS 推荐列表或调整官方筛选条件后新建任务"
        : "任务已完成，可查看结果";
    case "failed":
      return "请查看失败原因并重试任务";
    case "cancelled":
      return "任务已取消，无需操作";
  }
}

export function candidateNextAction(input: {
  taskStatus: Task["status"];
  resumeStatus: DashboardCandidate["resumeScreeningStatus"];
  errorCode: ResumeScreeningErrorCode | null;
  reviewStatus: DashboardCandidate["reviewStatus"];
  contactStatus: DashboardCandidate["contactStatus"];
  nextAttemptAt: Date | null;
}): string {
  if (input.taskStatus === "cancelled") return "所属任务已取消，不会继续查看";
  if (input.resumeStatus === "queued") {
    return input.nextAttemptAt
      ? `系统将在 ${iso(input.nextAttemptAt)} 后自动重试`
      : "等待系统按安全节奏查看简历";
  }
  if (input.resumeStatus === "processing") return "系统正在读取并识别简历";
  if (input.resumeStatus === "failed" || input.resumeStatus === "no_text") {
    if (!resumeScreeningFailureRecoverable(input.errorCode)) {
      return input.errorCode === "risk_control"
        ? "系统已停止自动操作，请管理员先确认 BOSS 账号状态"
        : "系统已停止自动重试，请重新采集或人工核对候选人";
    }
    return "查看失败原因后重新精筛，或转人工审核";
  }
  if (input.resumeStatus === "not_requested") return "等待进入简历精筛";
  if (input.reviewStatus === "pending") return "请人工审核候选人";
  if (input.reviewStatus === "not_required") return "查看未通过原因；需要时可人工改判";
  if (input.reviewStatus === "rejected") return "候选人已人工拒绝";
  if (input.contactStatus === "sent") return "候选人已联系";
  if (input.contactStatus === "uncertain") return "发送结果不确定，请勿重试并先人工核对";
  if (input.contactStatus === "queued") return "联系消息已进入安全队列";
  return "预览联系消息并人工确认";
}

const TASK_SELECT = `
  SELECT t.id, t.idempotency_key, t.position_id, p.name AS position_name,
    p.boss_account_id,
    CASE WHEN t.source_job_id = p.boss_job_id THEN p.boss_job_keyword
      ELSE COALESCE(t.source_job_name, p.boss_job_keyword) END AS boss_job_keyword,
    t.source_job_id AS boss_job_id, CASE WHEN t.source_job_id = p.boss_job_id THEN p.boss_job_name_unique ELSE false END AS boss_job_name_unique, t.rule_version_id,
    rv.version AS rule_version, rv.dictionary_version, rv.config AS rule_config, t.source_boss_filters,
    t.execution_mode, t.source, t.search_keyword, t.status, t.created_by,
    t.candidate_count, t.candidate_limit, t.auto_greet, t.new_candidate_count, t.repeat_candidate_count,
    t.error_message, t.wait_reason_code, t.wait_reason, t.next_run_at,
    t.claim_token, t.version, t.created_at
  FROM tasks t
  JOIN positions p ON p.id = t.position_id
  JOIN rule_versions rv ON rv.id = t.rule_version_id
`;

export class BossForgeRepository {
  constructor(private readonly sql: Database) {}

  async resumeViewUsage(
    bossAccountId: string,
    dayStartedAt: Date,
    hourStartedAt: Date,
  ): Promise<{
    viewsToday: number;
    viewsLastHour: number;
    absoluteViewsToday: number;
    nextHourlyAvailableAt: Date | null;
  }> {
    const rows = await this.sql<
      Array<{
        views_today: number;
        views_last_hour: number;
        absolute_views_today: number;
        oldest_view_last_hour: Date | null;
      }>
    >`
      WITH latest_reset AS (
        SELECT MAX(created_at) AS reset_at
        FROM audit_logs
        WHERE action = 'candidate.resume_view_quota.reset'
          AND payload ->> 'bossAccountId' = ${bossAccountId}
      )
      SELECT
        count(*) FILTER (
          WHERE created_at >= GREATEST(
            ${dayStartedAt},
            COALESCE(latest_reset.reset_at, ${dayStartedAt})
          )
        )::int AS views_today,
        count(*) FILTER (
          WHERE created_at >= ${hourStartedAt}
        )::int AS views_last_hour,
        count(*) FILTER (WHERE created_at >= ${dayStartedAt})::int AS absolute_views_today,
        MIN(created_at) FILTER (
          WHERE created_at >= ${hourStartedAt}
        ) AS oldest_view_last_hour
      FROM audit_logs
      CROSS JOIN latest_reset
      WHERE action = 'candidate.resume_viewed'
        AND payload ->> 'bossAccountId' = ${bossAccountId}
    `;
    const oldestView = rows[0]?.oldest_view_last_hour ?? null;
    return {
      viewsToday: rows[0]?.views_today ?? 0,
      viewsLastHour: rows[0]?.views_last_hour ?? 0,
      absoluteViewsToday: rows[0]?.absolute_views_today ?? 0,
      nextHourlyAvailableAt: oldestView
        ? new Date(oldestView.getTime() + 60 * 60 * 1_000)
        : null,
    };
  }

  async markResumeScreeningWait(input: {
    bossAccountId: string;
    code: TaskWaitReasonCode;
    reason: string;
    nextRunAt: Date | null;
  }): Promise<void> {
    await this.sql`
      UPDATE tasks t
      SET wait_reason_code = ${input.code},
        wait_reason = ${input.reason.slice(0, 500)},
        next_run_at = ${input.nextRunAt},
        last_progress_at = COALESCE(t.last_progress_at, now()),
        version = t.version + 1
      FROM positions p
      WHERE p.id = t.position_id
        AND p.boss_account_id = ${input.bossAccountId}
        AND t.status = 'screening'
        AND EXISTS (
          SELECT 1 FROM candidate_position_states cps
          WHERE cps.latest_task_id = t.id
            AND cps.resume_screening_status = 'queued'
        )
        AND (
          t.wait_reason_code IS DISTINCT FROM ${input.code}
          OR t.wait_reason IS DISTINCT FROM ${input.reason.slice(0, 500)}
          OR t.next_run_at IS DISTINCT FROM ${input.nextRunAt}
        )
    `;
  }

  /**
   * Clear account-wide waits that are derived directly from the resume-view
   * policy. The caller must invoke this only after evaluating the current
   * effective policy as `ready`. Candidate retry and batch-break waits carry
   * their own recovery semantics and are deliberately left untouched.
   */
  async clearResumeScreeningWait(bossAccountId: string): Promise<number> {
    const rows = await this.sql<Array<{ id: string }>>`
      UPDATE tasks t
      SET wait_reason_code = NULL,
        wait_reason = NULL,
        next_run_at = NULL,
        version = t.version + 1
      FROM positions p
      WHERE p.id = t.position_id
        AND p.boss_account_id = ${bossAccountId}
        AND t.status = 'screening'
        AND t.wait_reason_code IN (
          'outside_working_hours',
          'daily_hard_limit_reached',
          'hourly_quota_reached',
          'daily_quota_reached'
        )
        AND EXISTS (
          SELECT 1 FROM candidate_position_states cps
          WHERE cps.latest_task_id = t.id
            AND cps.resume_screening_status = 'queued'
        )
      RETURNING t.id
    `;
    return rows.length;
  }

  async resetResumeViewQuota(input: {
    bossAccountId: string;
    actorId: string;
  }): Promise<void> {
    await this.sql`
      INSERT INTO audit_logs (
        id, actor_id, action, resource_type, resource_id, payload
      ) VALUES (
        ${randomUUID()},
        ${input.actorId},
        'candidate.resume_view_quota.reset',
        'boss_account',
        ${input.bossAccountId},
        ${this.sql.json({ bossAccountId: input.bossAccountId })}
      )
    `;
  }

  async recordResumeView(input: {
    stateId: string;
    candidateId: string;
    taskId: string;
    bossAccountId: string;
    workerId: string;
    openedAt: string;
  }): Promise<void> {
    await this.sql.begin(async (transaction) => {
      // Keep the lock order aligned with task cancellation: task first, then
      // candidate state. Cancellation therefore either wins before this check
      // (and no view is recorded) or waits until this audit record commits.
      const tasks = await transaction<Array<{ id: string }>>`
        SELECT t.id
        FROM tasks t
        JOIN positions p ON p.id = t.position_id
        WHERE t.id = ${input.taskId}
          AND t.status IN ('screening', 'waiting_review')
          AND p.boss_account_id = ${input.bossAccountId}
        FOR UPDATE OF t
      `;
      if (!tasks[0]) throw new ResumeScreeningLeaseLostError();

      const leases = await transaction<Array<{ id: string }>>`
        SELECT cps.id
        FROM candidate_position_states cps
        WHERE cps.id = ${input.stateId}
          AND cps.candidate_id = ${input.candidateId}
          AND cps.latest_task_id = ${input.taskId}
          AND cps.resume_screening_status = 'processing'
          AND cps.resume_screening_claimed_by = ${input.workerId}
          AND cps.resume_screening_claimed_at IS NOT NULL
        FOR UPDATE OF cps
      `;
      if (!leases[0]) throw new ResumeScreeningLeaseLostError();

      await transaction`
        INSERT INTO audit_logs (
          id, actor_id, action, resource_type, resource_id, payload, created_at
        ) VALUES (
          ${randomUUID()}, ${input.workerId}, 'candidate.resume_viewed',
          'candidate_position_state', ${input.stateId},
          ${transaction.json({
            candidateId: input.candidateId,
            taskId: input.taskId,
            bossAccountId: input.bossAccountId,
          })},
          ${new Date(input.openedAt)}
        )
      `;
    });
  }

  async retryFailedResumeScreenings(input: {
    taskId: string;
    actorId: string;
    reason: string;
  }): Promise<number> {
    return this.sql.begin(async (transaction) => {
      const states = await transaction<Array<{ id: string }>>`
        SELECT id
        FROM candidate_position_states
        WHERE latest_task_id = ${input.taskId}
          AND resume_screening_status = 'failed'
          AND (
            resume_screening_error_code IS NULL
            OR resume_screening_error_code = ANY(${RETRYABLE_RESUME_ERROR_CODES}::text[])
          )
        FOR UPDATE
      `;
      for (const state of states) {
        await transaction`
          INSERT INTO audit_logs (
            id, actor_id, action, resource_type, resource_id, payload
          ) VALUES (
            ${randomUUID()}, ${input.actorId},
            'candidate.resume_screening.retry_authorized',
            'candidate_position_state', ${state.id},
            ${transaction.json({
              taskId: input.taskId,
              reason: input.reason.slice(0, 500),
            })}
          )
        `;
      }
      if (states.length === 0) return 0;
      await transaction`
        UPDATE candidate_position_states
        SET resume_screening_status = 'queued',
          resume_screening_claimed_by = NULL,
          resume_screening_claimed_at = NULL,
          resume_screening_error = NULL,
          resume_screening_error_code = NULL,
          resume_screening_next_attempt_at = NULL,
          updated_at = now()
        WHERE latest_task_id = ${input.taskId}
          AND resume_screening_status = 'failed'
          AND (
            resume_screening_error_code IS NULL
            OR resume_screening_error_code = ANY(${RETRYABLE_RESUME_ERROR_CODES}::text[])
          )
      `;
      await transaction`
        UPDATE tasks
        SET status = 'screening', finished_at = NULL, error_message = NULL,
          wait_reason_code = NULL, wait_reason = NULL, next_run_at = NULL,
          version = version + 1, last_progress_at = now()
        WHERE id = ${input.taskId}
          AND status IN ('screening', 'waiting_review')
      `;
      return states.length;
    });
  }

  async recordBossAccountHealthy(bossAccountId: string, reason: string): Promise<void> {
    await this.sql`
      INSERT INTO account_health (
        boss_account_id, status, authoritative, reason, checked_at
      ) VALUES (
        ${bossAccountId}, 'healthy', true, ${reason.slice(0, 500)}, now()
      )
      ON CONFLICT (boss_account_id) DO UPDATE SET
        status = 'healthy', authoritative = true, reason = EXCLUDED.reason,
        checked_at = now(), updated_at = now()
    `;
  }

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
      ON CONFLICT (boss_account_id, name) WHERE boss_job_id IS NULL DO UPDATE SET
        boss_job_keyword = EXCLUDED.boss_job_keyword,
        owner_name = EXCLUDED.owner_name,
        version = positions.version + 1,
        updated_at = now()
      RETURNING *
    `;
    return mapPosition(rows[0]!);
  }

  async listPositions(positionIds?: readonly string[]): Promise<Position[]> {
    const positionScope = positionIds === undefined ? null : [...positionIds];
    const rows = await this.sql<PositionRow[]>`
      SELECT * FROM positions
      WHERE (${positionScope}::uuid[] IS NULL OR id = ANY(${positionScope}::uuid[]))
      ORDER BY created_at ASC
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
        createdAt: iso(row.created_at),
      };
    });
  }

  async createImmediateTask(input: {
    idempotencyKey: string;
    positionId: string;
    source: "recommend" | "search";
    searchKeyword?: string | null;
    createdBy: string;
    candidateLimit?: number;
    autoGreet?: boolean;
  }): Promise<Task> {
    const candidateLimit = screeningCandidateLimit(input.candidateLimit);
    const autoGreet = input.autoGreet === true;
    return this.sql.begin(async (transaction) => {
      const assertReplayMatches = (task: Task): Task => {
        if (
          task.positionId !== input.positionId ||
          task.source !== input.source ||
          task.searchKeyword !== (input.searchKeyword ?? null) ||
          task.createdBy !== input.createdBy ||
          task.executionMode !== "immediate" ||
          task.candidateLimit !== candidateLimit ||
          Boolean(task.autoGreet) !== autoGreet
        ) {
          throw new Error("Idempotency-Key is already used for a different task request.");
        }
        return task;
      };
      const replayRows = await transaction.unsafe<TaskRow[]>(
        `${TASK_SELECT} WHERE t.idempotency_key = $1`,
        [input.idempotencyKey],
      );
      if (replayRows[0]) return assertReplayMatches(mapTask(replayRows[0]));

      if (input.source === "recommend") {
        const unbound = await transaction`SELECT p.id FROM positions p
          WHERE p.id = ${input.positionId} AND p.boss_job_id IS NULL
            AND EXISTS (SELECT 1 FROM positions linked WHERE linked.boss_account_id = p.boss_account_id AND linked.boss_job_id IS NOT NULL)`;
        if (unbound.length) throw new Error("请先在岗位设置关联对应的 BOSS 岗位，再开始推荐筛选。");
      }
      const activeRows = await transaction<{ active_version_id: string | null; config: unknown; boss_job_id: string | null }[]>`
        SELECT rs.active_version_id, rv.config, p.boss_job_id
        FROM rule_sets rs
        JOIN rule_versions rv ON rv.id = rs.active_version_id
        JOIN positions p ON p.id = rs.position_id
        WHERE rs.position_id = ${input.positionId}
          AND rv.lifecycle_status = 'published'
          AND p.assignment_status = 'assigned'
          AND p.status = 'active'
      `;
      const ruleVersionId = activeRows[0]?.active_version_id;
      if (!ruleVersionId) {
        throw new Error("Position needs an assigned owner and a published active rule before creating tasks.");
      }
      assertRuleScreeningSource(activeRows[0]!.config, input.source, activeRows[0]!.boss_job_id);
      const taskId = randomUUID();
      const insertedRows = await transaction<Array<{ id: string }>>`
        INSERT INTO tasks (
          id, idempotency_key, position_id, rule_version_id, execution_mode,
          source, search_keyword, status, created_by, candidate_limit, auto_greet
        ) VALUES (
          ${taskId}, ${input.idempotencyKey}, ${input.positionId}, ${ruleVersionId},
          'immediate', ${input.source}, ${input.searchKeyword ?? null}, 'queued', ${input.createdBy},
          ${candidateLimit}, ${autoGreet}
        ) ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id
      `;
      const rows = await transaction.unsafe<TaskRow[]>(
        `${TASK_SELECT} WHERE t.idempotency_key = $1`,
        [input.idempotencyKey],
      );
      const task = assertReplayMatches(mapTask(rows[0]!));
      if (insertedRows.length === 0) return task;
      await transaction`
        INSERT INTO audit_logs (
          id, actor_id, action, resource_type, resource_id, payload
        ) VALUES (
          ${randomUUID()}, ${input.createdBy}, 'task.immediate.requested',
          'task', ${task.id}, ${transaction.json({
            positionId: input.positionId,
            source: input.source,
            candidateLimit,
            autoGreet
          })}
        )
      `;
      return task;
    });
  }

  async cancelTask(input: {
    taskId: string;
    idempotencyKey: string;
    expectedVersion: number;
    actorId: string;
  }): Promise<Task> {
    return this.sql.begin(async (transaction) => {
      const replay = await transaction<
        Array<{
          task_id: string;
          command: "cancel" | "retry";
          expected_version: number;
          actor_id: string;
        }>
      >`
        SELECT task_id, command, expected_version, actor_id
        FROM task_commands WHERE idempotency_key = ${input.idempotencyKey}
      `;
      if (replay[0]) {
        if (
          replay[0].task_id !== input.taskId ||
          replay[0].command !== "cancel" ||
          replay[0].expected_version !== input.expectedVersion ||
          replay[0].actor_id !== input.actorId
        ) {
          throw new Error("Idempotency-Key is already used for a different task command.");
        }
        const rows = await transaction.unsafe<TaskRow[]>(`${TASK_SELECT} WHERE t.id = $1`, [
          input.taskId,
        ]);
        if (!rows[0]) throw new Error("Task was not found.");
        return mapTask(rows[0]);
      }

      const current = await transaction<Array<{ status: Task["status"]; version: number }>>`
        SELECT status, version FROM tasks WHERE id = ${input.taskId} FOR UPDATE
      `;
      const task = current[0];
      if (!task) throw new Error("Task was not found.");
      if (task.version !== input.expectedVersion) {
        throw new OptimisticLockError(input.expectedVersion, task.version);
      }
      if (!["queued", "running", "screening", "waiting_review"].includes(task.status)) {
        throw new Error(`Task in ${task.status} state cannot be cancelled.`);
      }
      const resultingVersion = task.version + 1;
      await transaction`
        UPDATE tasks
        SET status = 'cancelled', finished_at = now(), claimed_by = NULL,
          claim_token = NULL, claimed_at = NULL, wait_reason_code = NULL,
          wait_reason = NULL, next_run_at = NULL, version = ${resultingVersion},
          last_progress_at = now()
        WHERE id = ${input.taskId}
      `;
      const cancelledResumeScreenings = await transaction<Array<{ id: string }>>`
        UPDATE candidate_position_states
        SET resume_screening_status = 'not_requested',
          resume_screening_attempts = 0,
          resume_screening_claimed_by = NULL,
          resume_screening_claimed_at = NULL,
          resume_screening_error = NULL,
          resume_screening_error_code = NULL,
          resume_screening_next_attempt_at = NULL,
          version = version + 1, updated_at = now()
        WHERE latest_task_id = ${input.taskId}
          AND resume_screening_status IN ('queued', 'processing')
        RETURNING id
      `;
      await transaction`
        INSERT INTO task_commands (
          id, task_id, idempotency_key, command, expected_version,
          resulting_version, actor_id
        ) VALUES (
          ${randomUUID()}, ${input.taskId}, ${input.idempotencyKey}, 'cancel',
          ${input.expectedVersion}, ${resultingVersion}, ${input.actorId}
        )
      `;
      await transaction`
        INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
        VALUES (
          ${randomUUID()}, ${input.actorId}, 'task.cancelled', 'task', ${input.taskId},
          ${transaction.json({
            expectedVersion: input.expectedVersion,
            resultingVersion,
            cancelledResumeScreeningCount: cancelledResumeScreenings.length,
          })}
        )
      `;
      const rows = await transaction.unsafe<TaskRow[]>(`${TASK_SELECT} WHERE t.id = $1`, [
        input.taskId,
      ]);
      return mapTask(rows[0]!);
    });
  }

  async retryTask(input: {
    taskId: string;
    idempotencyKey: string;
    expectedVersion: number;
    actorId: string;
  }): Promise<Task> {
    return this.sql.begin(async (transaction) => {
      const replay = await transaction<
        Array<{
          task_id: string;
          command: "cancel" | "retry";
          expected_version: number;
          actor_id: string;
        }>
      >`
        SELECT task_id, command, expected_version, actor_id
        FROM task_commands WHERE idempotency_key = ${input.idempotencyKey}
      `;
      if (replay[0]) {
        if (
          replay[0].task_id !== input.taskId ||
          replay[0].command !== "retry" ||
          replay[0].expected_version !== input.expectedVersion ||
          replay[0].actor_id !== input.actorId
        ) {
          throw new Error("Idempotency-Key is already used for a different task command.");
        }
        const rows = await transaction.unsafe<TaskRow[]>(`${TASK_SELECT} WHERE t.id = $1`, [
          input.taskId,
        ]);
        if (!rows[0]) throw new Error("Task was not found.");
        return mapTask(rows[0]);
      }

      const current = await transaction<Array<{ status: Task["status"]; version: number; candidate_count: number; candidate_limit: number }>>`
        SELECT status, version, candidate_count, candidate_limit FROM tasks WHERE id = ${input.taskId} FOR UPDATE
      `;
      const task = current[0];
      if (!task) throw new Error("Task was not found.");
      if (task.version !== input.expectedVersion) {
        throw new OptimisticLockError(input.expectedVersion, task.version);
      }
      if (!["failed", "cancelled", "waiting_review"].includes(task.status)) {
        throw new Error(`Task in ${task.status} state cannot be retried.`);
      }
      if (task.status === "waiting_review") {
        const retryable = await transaction<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS count FROM candidate_position_states
          WHERE latest_task_id = ${input.taskId}
            AND review_status IN ('pending', 'not_required')
            AND (
              resume_screening_status = 'no_text'
              OR (
                resume_screening_status = 'failed'
                AND (
                  resume_screening_error_code IS NULL
                  OR resume_screening_error_code = ANY(${RETRYABLE_RESUME_ERROR_CODES}::text[])
                )
              )
            )
        `;
        if ((retryable[0]?.count ?? 0) === 0) {
          throw new Error("Task has no failed resume screenings to retry.");
        }
      }

      const retryStates = await transaction<Array<{ id: string }>>`
        SELECT id
        FROM candidate_position_states
        WHERE latest_task_id = ${input.taskId}
          AND review_status IN ('pending', 'not_required')
          AND (
            resume_screening_status IN ('not_requested', 'queued', 'processing', 'no_text')
            OR (
              resume_screening_status = 'failed'
              AND (
                resume_screening_error_code IS NULL
                OR resume_screening_error_code = ANY(${RETRYABLE_RESUME_ERROR_CODES}::text[])
              )
            )
          )
        FOR UPDATE
      `;
      await transaction`
        UPDATE candidate_position_states
        SET resume_screening_status = 'queued', resume_screening_error = NULL,
          resume_screening_error_code = NULL,
          resume_screening_next_attempt_at = NULL,
          resume_screening_claimed_by = NULL,
          resume_screening_claimed_at = NULL,
          resume_screening_attempts = 0,
          version = version + 1, updated_at = now()
        WHERE id = ANY(${retryStates.map((state) => state.id)}::uuid[])
      `;
      for (const state of retryStates) {
        await transaction`
          INSERT INTO audit_logs (
            id, actor_id, action, resource_type, resource_id, payload
          ) VALUES (
            ${randomUUID()}, ${input.actorId},
            'candidate.resume_screening.retry_authorized',
            'candidate_position_state', ${state.id},
            ${transaction.json({
              taskId: input.taskId,
              reason: "任务级人工重试",
            })}
          )
        `;
      }
      const stateCounts = await transaction<
        Array<{ state_count: number; queued_count: number; pending_review_count: number }>
      >`
        SELECT COUNT(*)::int AS state_count,
          COUNT(*) FILTER (WHERE resume_screening_status = 'queued')::int AS queued_count,
          COUNT(*) FILTER (WHERE review_status = 'pending')::int AS pending_review_count
        FROM candidate_position_states
        WHERE latest_task_id = ${input.taskId}
      `;
      const stateCount = stateCounts[0]?.state_count ?? 0;
      const queuedCount = stateCounts[0]?.queued_count ?? 0;
      const pendingReviewCount = stateCounts[0]?.pending_review_count ?? 0;
      // Failed mid multi-wave (e.g. identity clash on a later chunk): keep
      // admitted rows and re-queue collection toward the remaining headcount.
      const canContinueCollection =
        task.candidate_count < task.candidate_limit &&
        ["failed", "cancelled"].includes(task.status);
      if (
        stateCount > 0 &&
        queuedCount === 0 &&
        pendingReviewCount === 0 &&
        !canContinueCollection
      ) {
        throw new Error("Task has no unfinished screening or review work to retry.");
      }
      const nextStatus = queuedCount > 0
        ? "screening"
        : pendingReviewCount > 0
          ? "waiting_review"
          : "queued";
      const resultingVersion = task.version + 1;
      await transaction`
        UPDATE tasks
        SET status = ${nextStatus}, finished_at = NULL, error_message = NULL,
          claimed_by = NULL, claim_token = NULL, claimed_at = NULL,
          wait_reason_code = NULL, wait_reason = NULL, next_run_at = NULL,
          version = ${resultingVersion}, last_progress_at = now()
        WHERE id = ${input.taskId}
      `;
      await transaction`
        INSERT INTO task_commands (
          id, task_id, idempotency_key, command, expected_version,
          resulting_version, actor_id
        ) VALUES (
          ${randomUUID()}, ${input.taskId}, ${input.idempotencyKey}, 'retry',
          ${input.expectedVersion}, ${resultingVersion}, ${input.actorId}
        )
      `;
      await transaction`
        INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
        VALUES (
          ${randomUUID()}, ${input.actorId}, 'task.retried', 'task', ${input.taskId},
          ${transaction.json({
            expectedVersion: input.expectedVersion,
            resultingVersion,
            status: nextStatus
          })}
        )
      `;
      const rows = await transaction.unsafe<TaskRow[]>(`${TASK_SELECT} WHERE t.id = $1`, [
        input.taskId,
      ]);
      return mapTask(rows[0]!);
    });
  }

  /**
   * One BOSS account, one browser. Overlapping tasks run strictly in sequence:
   * older schedule.created_at first (tasks with no schedule use task.created_at),
   * then task.created_at, then task id. Later tasks are not claimed until the
   * earlier task is finished (screening-pass target met when auto-greet is off,
   * greet target met when auto-greet is on, pool exhausted, cancelled, or
   * daily greet cap). `candidate_limit` is successful greets when auto_greet
   * is true, and screening passes (matched + resume screened) when it is false.
   */
  async claimNextTask(workerId: string, bossAccountId: string): Promise<Task | null> {
    return this.sql.begin(async (transaction) => {
      const selected = await transaction<{ id: string }[]>`
        SELECT t.id FROM tasks t
        JOIN positions p ON p.id = t.position_id
        LEFT JOIN schedules s ON s.id = t.schedule_id
        WHERE (
            t.status = 'queued'
            OR (
              t.status = 'running'
              AND t.claimed_at < now() - interval '15 minutes'
            )
          )
          AND (t.next_run_at IS NULL OR t.next_run_at <= now())
          AND p.boss_account_id = ${bossAccountId}
          AND NOT EXISTS (
            SELECT 1
            FROM tasks earlier
            JOIN positions earlier_position ON earlier_position.id = earlier.position_id
            LEFT JOIN schedules earlier_schedule ON earlier_schedule.id = earlier.schedule_id
            WHERE earlier_position.boss_account_id = p.boss_account_id
              AND earlier.id <> t.id
              AND (
                earlier.status IN ('queued', 'running', 'screening')
                OR (
                  earlier.status = 'waiting_review'
                  AND ${transaction.unsafe(screeningTerminalWaitExcludedSql("earlier.wait_reason_code"))}
                  AND COALESCE(earlier.error_message, '') NOT LIKE '%每日打招呼上限%'
                  AND ${transaction.unsafe(screeningBudgetStillOpenSql("earlier"))}
                )
                OR EXISTS (
                  SELECT 1 FROM contact_intents open_greet
                  WHERE open_greet.task_id = earlier.id
                    AND open_greet.action_kind = 'greet'
                    AND open_greet.status IN ('ready', 'processing')
                )
                OR EXISTS (
                  SELECT 1 FROM candidate_position_states inflight_resume
                  WHERE inflight_resume.latest_task_id = earlier.id
                    AND inflight_resume.resume_screening_status = 'processing'
                )
                OR EXISTS (
                  SELECT 1 FROM candidate_position_states open_resume
                  WHERE open_resume.latest_task_id = earlier.id
                    AND open_resume.resume_screening_status IN ('queued', 'processing')
                    AND ${transaction.unsafe(screeningBudgetStillOpenSql("earlier"))}
                    AND ${transaction.unsafe(screeningBudgetMetWaitExcludedSql("earlier.wait_reason_code"))}
                )
              )
              AND (
                COALESCE(earlier_schedule.created_at, earlier.created_at),
                earlier.created_at,
                earlier.id
              ) < (
                COALESCE(s.created_at, t.created_at),
                t.created_at,
                t.id
              )
          )
        ORDER BY COALESCE(s.created_at, t.created_at) ASC, t.created_at ASC, t.id ASC
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
          error_message = NULL, wait_reason_code = NULL, wait_reason = NULL,
          next_run_at = NULL, last_progress_at = now(), version = version + 1
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
            workerId,
          },
        });
      }
      const rows = await transaction.unsafe<TaskRow[]>(`${TASK_SELECT} WHERE t.id = $1`, [id]);
      return mapTask(rows[0]!);
    });
  }

  async completeTask(
    task: Task,
    records: CandidateEvaluationRecord[],
    sourceJobLabel: string | null = null,
    sourceBossFilters: BossRecommendationFilterPlan | null = null,
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const currentTasks = await transaction<
        Array<{
          status: Task["status"];
          claim_token: string | null;
          candidate_limit: number;
          auto_greet: boolean;
        }>
      >`
        SELECT status, claim_token, candidate_limit, auto_greet FROM tasks WHERE id = ${task.id} FOR UPDATE
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
      const repeatStateIds = new Set<string>();
      // Prior chunks already admitted people on this task. Re-reads must not
      // reset them; only net-new candidates consume the remaining headcount.
      const priorKeys = await transaction<Array<{ key: string }>>`
        SELECT CASE
          WHEN snapshot.source_locator ->> 'kind' = 'boss_geek_id'
            THEN 'boss:' || BTRIM(snapshot.source_locator ->> 'value')
          ELSE 'fingerprint:' || candidate.fingerprint
        END AS key
        FROM candidate_position_states state
        JOIN candidates candidate ON candidate.id = state.candidate_id
        JOIN candidate_snapshots snapshot ON snapshot.id = state.latest_snapshot_id
        WHERE state.latest_task_id = ${task.id}
      `;
      const priorKeySet = new Set(priorKeys.map((row) => row.key));
      const progressRows = await transaction<Array<{ sent: number; passes: number }>>`
        SELECT
          (
            SELECT count(*)::int FROM contact_intents
            WHERE task_id = ${task.id}
              AND action_kind = 'greet'
              AND status = 'sent'
          ) AS sent,
          (
            SELECT count(*)::int FROM candidate_position_states
            WHERE latest_task_id = ${task.id}
              AND rule_decision = 'matched'
              AND resume_screening_status = 'screened'
          ) AS passes
      `;
      const sentGreets = Number(progressRows[0]?.sent ?? 0);
      const screeningPasses = Number(progressRows[0]?.passes ?? 0);
      // One wave admits at most a chunk. Stop admitting once the task budget is
      // met: successful greets when auto-greet is on, screening passes when it is off.
      const remainingSlots = screeningBudgetMet({
        autoGreet: currentTask.auto_greet,
        candidateLimit: currentTask.candidate_limit,
        successfulGreets: sentGreets,
        screeningPasses,
      })
        ? 0
        : SCREENING_CHUNK_SIZE;
      const freshRecords = records.filter((record) => {
        const key =
          record.sourceLocator?.kind === "boss_geek_id"
            ? `boss:${record.sourceLocator.value.trim()}`
            : `fingerprint:${record.fingerprint}`;
        return !priorKeySet.has(key);
      });
      const admittedRecords =
        remainingSlots === 0
          ? []
          : limitScreeningRecords(freshRecords, remainingSlots);
      for (const record of admittedRecords) {
        let candidateRows: Array<{ id: string }> = [];
        if (record.sourceLocator?.kind === "boss_geek_id") {
          candidateRows = await transaction<{ id: string }[]>`
            SELECT c.id
            FROM candidates c
            JOIN candidate_snapshots cs ON cs.candidate_id = c.id
            WHERE cs.source_locator ->> 'kind' = 'boss_geek_id'
              AND BTRIM(cs.source_locator ->> 'value') = ${record.sourceLocator.value.trim()}
            ORDER BY c.updated_at DESC, cs.collected_at DESC
            LIMIT 1
          `;
          if (candidateRows[0]) {
            candidateRows = await transaction<{ id: string }[]>`
              UPDATE candidates candidate
              SET fingerprint = CASE
                  WHEN NOT EXISTS (
                    SELECT 1 FROM candidates duplicate
                    WHERE duplicate.fingerprint = ${record.fingerprint}
                      AND duplicate.id <> candidate.id
                  ) THEN ${record.fingerprint}
                  ELSE candidate.fingerprint
                END,
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
        const repeatRows = await transaction<Array<{ repeated: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM candidate_snapshots prior_snapshot
            JOIN tasks prior_task ON prior_task.id = prior_snapshot.task_id
            WHERE prior_snapshot.candidate_id = ${candidateId}
              AND prior_task.position_id = ${task.positionId}
              AND prior_task.id <> ${task.id}
          ) AS repeated
        `;
        const isRepeat = repeatRows[0]?.repeated ?? false;
        const insertSnapshot = async (sourceReference: string) =>
          transaction<Array<{ id: string; candidate_id: string }>>`
            INSERT INTO candidate_snapshots (
              id, task_id, candidate_id, source_reference, source, source_locator, raw_fields,
              source_evidence, raw_text
            ) VALUES (
              ${randomUUID()}, ${task.id}, ${candidateId}, ${sourceReference},
              ${record.source}, ${record.sourceLocator ? transaction.json(record.sourceLocator) : null},
              ${transaction.json(record.rawFields)},
              ${transaction.json(record.sourceEvidence)}, ${record.rawText}
            )
            ON CONFLICT (task_id, source_reference) DO UPDATE SET
              source_locator = EXCLUDED.source_locator,
              raw_fields = EXCLUDED.raw_fields,
              source_evidence = EXCLUDED.source_evidence,
              raw_text = EXCLUDED.raw_text
            RETURNING id, candidate_id
          `;
        // Multi-wave collects restart list indices; index+name refs can collide with
        // an earlier admit for a different person. Disambiguate instead of failing
        // the whole screening task.
        let snapshotRows = await insertSnapshot(record.sourceReference);
        if (snapshotRows[0]!.candidate_id !== candidateId) {
          const disambiguator =
            record.sourceLocator?.kind === "boss_geek_id"
              ? record.sourceLocator.value.trim()
              : record.fingerprint;
          snapshotRows = await insertSnapshot(
            `${record.sourceReference}#${disambiguator || randomUUID()}`,
          );
          if (snapshotRows[0]!.candidate_id !== candidateId) {
            continue;
          }
        }
        const snapshotId = snapshotRows[0]!.id;
        await transaction`
          UPDATE candidate_position_states
          SET is_current = false, updated_at = now()
          WHERE position_id = ${task.positionId}
            AND candidate_id = ${candidateId}
            AND is_current
        `;
        const stateRows = await transaction<
          Array<{ id: string; resume_screening_status: string; version: number }>
        >`
          INSERT INTO candidate_position_states (
            id, position_id, candidate_id, latest_task_id, latest_snapshot_id,
            rule_version_id, rule_decision, rule_confidence, review_status,
            contact_status, resume_screening_status, current_english_level,
            is_current, is_repeat, resume_screening_error,
            resume_screening_error_code, resume_screening_next_attempt_at
          ) VALUES (
            ${randomUUID()}, ${task.positionId}, ${candidateId}, ${task.id}, ${snapshotId},
            ${task.ruleVersionId}, ${record.decision}, ${record.confidence},
            ${record.decision === "not_matched" ? "not_required" : "pending"},
            'not_contacted', ${record.salaryScreening?.status === 'above_budget' ? 'screened' : 'queued'}, ${record.currentEnglishLevel}, true, ${isRepeat},
            NULL, NULL, NULL
          )
          ON CONFLICT (latest_task_id, candidate_id) DO UPDATE SET
            latest_snapshot_id = EXCLUDED.latest_snapshot_id,
            rule_version_id = EXCLUDED.rule_version_id,
            rule_decision = EXCLUDED.rule_decision,
            rule_confidence = EXCLUDED.rule_confidence,
            current_english_level = EXCLUDED.current_english_level,
            resume_screening_status = EXCLUDED.resume_screening_status,
            resume_screening_error = NULL,
            resume_screening_error_code = NULL,
            resume_screening_next_attempt_at = NULL,
            resume_screening_claimed_by = NULL,
            resume_screening_claimed_at = NULL,
            resume_screenshot_path = NULL,
            resume_text_hash = NULL,
            resume_screened_at = NULL,
            review_status = EXCLUDED.review_status,
            contact_status = CASE
              WHEN candidate_position_states.contact_status IN ('sent', 'uncertain')
                THEN candidate_position_states.contact_status
              ELSE 'not_contacted'
            END,
            is_current = true,
            is_repeat = EXCLUDED.is_repeat,
            version = candidate_position_states.version + 1,
            updated_at = now()
          RETURNING id, resume_screening_status, version
        `;
        const stateId = stateRows[0]!.id;
        await transaction`UPDATE candidate_position_states SET salary_screening = ${record.salaryScreening ? transaction.json(record.salaryScreening) : null} WHERE id = ${stateId}`;
        await transaction`DELETE FROM recruitment_assessments WHERE candidate_position_state_id = ${stateId}`;
        uniqueStateIds.add(stateId);
        if (isRepeat) repeatStateIds.add(stateId);
        await transaction`DELETE FROM semantic_evaluations WHERE candidate_position_state_id = ${stateId}`;
        await transaction`DELETE FROM match_evidence WHERE candidate_position_state_id = ${stateId}`;
        for (const evidence of record.evidence) {
          await transaction`
            INSERT INTO match_evidence (
              id, candidate_position_state_id, source_snapshot_id, rule_version_id,
              capability_id, canonical_label, dictionary_version, source_text,
              normalized_alias, evidence_status, confidence, reason_codes
            ) VALUES (
              ${randomUUID()}, ${stateId}, ${snapshotId}, ${task.ruleVersionId},
              ${evidence.capabilityId ?? record.capabilityId},
              ${evidence.canonicalLabel ?? record.canonicalLabel},
              ${evidence.dictionaryVersion ?? record.dictionaryVersion},
              ${evidence.sourceText}, ${evidence.normalizedAlias},
              ${evidence.status}, ${evidence.confidence},
              ${transaction.json(evidence.reasonCodes ?? record.reasonCodes)}
            )
          `;
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
              fields: record.rawFields,
            },
          });
        }
      }
      const uniqueCandidateCountRows = await transaction<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count
        FROM candidate_position_states
        WHERE latest_task_id = ${task.id}
      `;
      const uniqueCandidateCount = Number(uniqueCandidateCountRows[0]?.count ?? uniqueStateIds.size);
      const repeatCandidateCount = repeatStateIds.size;
      const newCandidateCount = Math.max(0, uniqueCandidateCount - repeatCandidateCount);
      const pending = await transaction`SELECT id FROM candidate_position_states WHERE latest_task_id = ${task.id} AND resume_screening_status IN ('queued', 'processing') LIMIT 1`;
      const status = pending[0] ? "screening" : "completed";
      await transaction`
        UPDATE tasks SET status = ${status}, candidate_count = ${uniqueCandidateCount},
          source_job_label = ${sourceJobLabel},
          source_boss_filters = ${sourceBossFilters ? transaction.json(bossRecommendationFilterPlanSchema.parse(sourceBossFilters)) : null},
          new_candidate_count = ${newCandidateCount},
          repeat_candidate_count = ${repeatCandidateCount},
          finished_at = ${pending[0] ? null : new Date()}, error_message = NULL,
          claimed_by = NULL, claim_token = NULL, claimed_at = NULL,
          wait_reason_code = NULL, wait_reason = NULL, next_run_at = NULL,
          last_progress_at = now(), version = version + 1
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
            newCandidateCount,
            repeatCandidateCount,
            rawRecordCount: records.length,
            candidateLimit: currentTask.candidate_limit,
            admittedRecordCount: admittedRecords.length,
            notAdmittedCount: records.length - admittedRecords.length,
            priorAdmittedCount: priorKeySet.size,
            chunkRemainingSlots: remainingSlots,
            sourceJobLabel,
            sourceBossFilters,
            duplicatesCollapsed: admittedRecords.length - uniqueStateIds.size,
          })}
        )
      `;
      await enqueueTaskCompletionIfReady(transaction, task.id);
      await applyScreeningBudgetSeal(transaction, task.id);
    });
  }

  /** Stop requesting more chunks when BOSS no longer yields net-new people. */
  async sealIfChunkAdmittedNothing(
    taskId: string,
    previousCandidateCount: number,
    options?: { collectionStopReason?: "limit" | "exhausted" | null }
  ): Promise<boolean> {
    return this.sql.begin(async (transaction) => {
      const rows = await transaction<
        Array<{ candidate_count: number; candidate_limit: number; status: string }>
      >`
        SELECT candidate_count, candidate_limit, status FROM tasks WHERE id = ${taskId} FOR UPDATE
      `;
      const task = rows[0];
      if (!task) return false;
      if (task.candidate_count > previousCandidateCount) {
        await transaction`
          INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
          VALUES (
            ${randomUUID()}, 'system:screening-chunk', 'task.chunk.progress',
            'task', ${taskId},
            ${transaction.json({
              candidateCount: task.candidate_count,
              previousCandidateCount,
              admitted: task.candidate_count - previousCandidateCount
            })}
          )
        `;
        return false;
      }
      if (await applyScreeningBudgetSeal(transaction, taskId)) return false;

      const emptyStreak = await transaction<Array<{ count: number }>>`
        SELECT count(*)::int AS count
        FROM audit_logs
        WHERE resource_type = 'task'
          AND resource_id = ${taskId}
          AND action = 'task.chunk.empty_wave'
          AND created_at > COALESCE(
            (
              SELECT MAX(created_at) FROM audit_logs
              WHERE resource_type = 'task'
                AND resource_id = ${taskId}
                AND action IN ('task.chunk.progress', 'task.chunk.exhausted')
            ),
            '-infinity'::timestamptz
          )
      `;
      // Soft empty while the collector still believed more pages existed: retry
      // instead of silently rewriting the user-requested headcount.
      const stopReason = options?.collectionStopReason ?? null;
      const priorEmpty = emptyStreak[0]?.count ?? 0;
      const genuineExhaustion =
        stopReason === "exhausted" || priorEmpty >= 2;
      await transaction`
        INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
        VALUES (
          ${randomUUID()}, 'system:screening-chunk',
          ${genuineExhaustion ? "task.chunk.exhausted" : "task.chunk.empty_wave"},
          'task', ${taskId},
          ${transaction.json({
            candidateCount: task.candidate_count,
            previousCandidateLimit: task.candidate_limit,
            previousCandidateCount,
            collectionStopReason: stopReason,
            emptyWaveBeforeSeal: priorEmpty,
            sealed: genuineExhaustion
          })}
        )
      `;
      if (!genuineExhaustion) {
        return false;
      }
      const pending = await transaction`
        SELECT id FROM candidate_position_states
        WHERE latest_task_id = ${taskId}
          AND resume_screening_status IN ('queued', 'processing')
        LIMIT 1
      `;
      await transaction`
        UPDATE tasks
        SET status = ${pending[0] ? "screening" : "waiting_review"},
          finished_at = ${pending[0] ? null : new Date()},
          claimed_by = NULL, claim_token = NULL, claimed_at = NULL,
          wait_reason_code = ${pending[0] ? null : "screening_pool_exhausted"},
          wait_reason = ${
            pending[0]
              ? null
              : "推荐列表在重试后仍无新增候选人，已停止收集（成功打招呼未达设定人数）。"
          },
          next_run_at = NULL,
          last_progress_at = now(), version = version + 1
        WHERE id = ${taskId}
      `;
      return true;
    });
  }

  /** Boss geek IDs already admitted on this task (for multi-wave net-new collect). */
  async listTaskAdmittedGeekIds(taskId: string): Promise<string[]> {
    const rows = await this.sql<Array<{ geek_id: string }>>`
      SELECT BTRIM(snapshot.source_locator ->> 'value') AS geek_id
      FROM candidate_position_states state
      JOIN candidate_snapshots snapshot ON snapshot.id = state.latest_snapshot_id
      WHERE state.latest_task_id = ${taskId}
        AND snapshot.source_locator ->> 'kind' = 'boss_geek_id'
        AND BTRIM(snapshot.source_locator ->> 'value') <> ''
    `;
    return rows.map((row) => row.geek_id);
  }

  /** When a claimed collection finds no remaining headcount, park the task for review. */
  async markTaskWaitingReviewIfIdle(
    taskId: string,
    claimToken: string | null
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const current = await transaction<
        Array<{ status: Task["status"]; claim_token: string | null }>
      >`
        SELECT status, claim_token FROM tasks WHERE id = ${taskId} FOR UPDATE
      `;
      const task = current[0];
      if (!task) return;
      if (task.status !== "running") return;
      if (claimToken && task.claim_token !== claimToken) return;
      const pending = await transaction`
        SELECT id FROM candidate_position_states
        WHERE latest_task_id = ${taskId}
          AND resume_screening_status IN ('queued', 'processing')
        LIMIT 1
      `;
      await transaction`
        UPDATE tasks
        SET status = ${pending[0] ? "screening" : "waiting_review"},
          finished_at = ${pending[0] ? null : new Date()},
          claimed_by = NULL, claim_token = NULL, claimed_at = NULL,
          wait_reason_code = NULL, wait_reason = NULL, next_run_at = NULL,
          last_progress_at = now(), version = version + 1
        WHERE id = ${taskId}
      `;
      await enqueueTaskCompletionIfReady(transaction, taskId);
    });
  }

  /**
   * After a screening chunk reaches waiting_review: auto-approve passers when
   * auto-greet is on. Does not start the next chunk until greets are queued/
   * finished — call continueScreeningChunk afterward.
   */
  async prepareAutoGreetPassers(taskId: string): Promise<{
    autoGreetEnabled: boolean;
    /** Task creator UUID — required so contact policy can authorize auto-greet intents. */
    createdBy: string | null;
    passers: Array<{
      stateId: string;
      stateVersion: number;
      candidateName: string;
      positionId: string;
      bossAccountId: string;
      bossJobId: string | null;
    }>;
    candidateCount: number;
    candidateLimit: number;
  }> {
    return this.sql.begin(async (transaction) => {
      const tasks = await transaction<
        Array<{
          id: string;
          status: Task["status"];
          candidate_count: number;
          candidate_limit: number;
          auto_greet: boolean;
          created_by: string;
        }>
      >`
        SELECT t.id, t.status, t.candidate_count, t.candidate_limit, t.auto_greet, t.created_by
        FROM tasks t
        WHERE t.id = ${taskId}
        FOR UPDATE OF t
      `;
      const task = tasks[0];
      if (!task) {
        return {
          autoGreetEnabled: false,
          createdBy: null,
          passers: [],
          candidateCount: 0,
          candidateLimit: 0
        };
      }
      const pendingResume = await transaction`
        SELECT id FROM candidate_position_states
        WHERE latest_task_id = ${taskId}
          AND resume_screening_status IN ('queued', 'processing')
        LIMIT 1
      `;
      if (
        pendingResume[0] ||
        !["waiting_review", "completed", "screening"].includes(task.status)
      ) {
        return {
          autoGreetEnabled: task.auto_greet,
          createdBy: task.created_by,
          passers: [],
          candidateCount: task.candidate_count,
          candidateLimit: task.candidate_limit
        };
      }
      if (task.status === "screening") {
        await transaction`
          UPDATE tasks
          SET status = 'waiting_review', finished_at = now(),
            wait_reason_code = NULL, wait_reason = NULL, next_run_at = NULL,
            last_progress_at = now(), version = version + 1
          WHERE id = ${taskId}
        `;
      }
      const passers = task.auto_greet
        ? await transaction<
            Array<{
              stateId: string;
              stateVersion: number;
              candidateName: string;
              positionId: string;
              bossAccountId: string;
              bossJobId: string | null;
            }>
          >`
            SELECT cps.id AS "stateId", cps.version AS "stateVersion",
              c.display_name AS "candidateName", p.id AS "positionId",
              p.boss_account_id AS "bossAccountId", p.boss_job_id AS "bossJobId"
            FROM candidate_position_states cps
            JOIN candidates c ON c.id = cps.candidate_id
            JOIN positions p ON p.id = cps.position_id
            WHERE cps.latest_task_id = ${taskId}
              AND cps.rule_decision = 'matched'
              AND cps.resume_screening_status = 'screened'
              AND cps.review_status IN ('pending', 'approved')
              AND cps.contact_status NOT IN ('sent', 'queued', 'uncertain')
              AND NOT EXISTS (
                SELECT 1 FROM contact_intents ci
                WHERE ci.candidate_position_state_id = cps.id
                  AND ci.action_kind = 'greet'
                  AND ci.status IN (
                    'ready', 'processing', 'sent', 'uncertain', 'simulated', 'failed'
                  )
              )
            ORDER BY cps.updated_at ASC, cps.id
          `
        : [];
      for (const passer of passers) {
        const current = await transaction<Array<{ review_status: string; version: number }>>`
          SELECT review_status, version FROM candidate_position_states WHERE id = ${passer.stateId}
          FOR UPDATE
        `;
        if (current[0]?.review_status === "pending") {
          await transaction`
            UPDATE candidate_position_states
            SET review_status = 'approved', version = version + 1, updated_at = now()
            WHERE id = ${passer.stateId} AND review_status = 'pending'
          `;
          await transaction`
            INSERT INTO reviews (
              id, candidate_position_state_id, idempotency_key, decision, note,
              correction_code, reviewer_id, previous_status, resulting_version
            ) VALUES (
              ${randomUUID()}, ${passer.stateId}, ${`auto-greet:${passer.stateId}`},
              'approved', '筛选分块完成后自动通过，准备自动打招呼。',
              NULL, 'system:auto-greet', 'pending', ${current[0].version + 1}
            )
            ON CONFLICT (idempotency_key) DO NOTHING
          `;
          passer.stateVersion = current[0].version + 1;
        }
      }
      return {
        autoGreetEnabled: task.auto_greet,
        createdBy: task.created_by,
        passers,
        candidateCount: task.candidate_count,
        candidateLimit: task.candidate_limit
      };
    });
  }

  /**
   * Re-queue the next screening chunk until the task budget is met
   * (successful greets when auto-greet is on, screening passes when it is off),
   * or the recommend pool is exhausted.
   */
  async continueScreeningChunk(taskId: string): Promise<boolean> {
    return this.sql.begin(async (transaction) => {
      const tasks = await transaction<
        Array<{
          status: Task["status"];
          candidate_count: number;
          candidate_limit: number;
          wait_reason_code: string | null;
        }>
      >`
        SELECT status, candidate_count, candidate_limit, wait_reason_code
        FROM tasks WHERE id = ${taskId} FOR UPDATE
      `;
      const task = tasks[0];
      if (!task) return false;
      if (!["waiting_review", "completed"].includes(task.status)) return false;
      if (task.wait_reason_code === "screening_pool_exhausted") return false;
      if (await applyScreeningBudgetSeal(transaction, taskId)) return false;
      if (task.candidate_count <= 0) return false;
      const pendingResume = await transaction`
        SELECT id FROM candidate_position_states
        WHERE latest_task_id = ${taskId}
          AND resume_screening_status IN ('queued', 'processing')
        LIMIT 1
      `;
      if (pendingResume[0]) return false;
      const pendingGreets = await transaction`
        SELECT id FROM contact_intents
        WHERE task_id = ${taskId}
          AND action_kind = 'greet'
          AND status IN ('ready', 'processing')
        LIMIT 1
      `;
      if (pendingGreets[0]) return false;
      await transaction`
        UPDATE tasks
        SET status = 'queued', finished_at = NULL, error_message = NULL,
          claimed_by = NULL, claim_token = NULL, claimed_at = NULL,
          wait_reason_code = NULL, wait_reason = NULL, next_run_at = NULL,
          last_progress_at = now(), version = version + 1
        WHERE id = ${taskId}
      `;
      await transaction`
        INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
        VALUES (
          ${randomUUID()}, 'system:screening-chunk', 'task.chunk.continue',
          'task', ${taskId},
          ${transaction.json({
            candidateCount: task.candidate_count,
            candidateLimit: task.candidate_limit
          })}
        )
      `;
      return true;
    });
  }

  /** Stop one task when its greet or screening-pass budget is already met. */
  async sealScreeningBudgetIfMet(taskId: string): Promise<boolean> {
    return this.sql.begin((transaction) => applyScreeningBudgetSeal(transaction, taskId));
  }

  /**
   * Park every task on this account whose budget is already met, including a
   * collection claim left `running` by the previous process. Called at the
   * start of each worker loop, before another resume or chunk is claimed.
   */
  async sealAccountTasksAtScreeningBudget(bossAccountId: string): Promise<string[]> {
    return this.sql.begin(async (transaction) => {
      const rows = await transaction<Array<{ id: string }>>`
        SELECT t.id
        FROM tasks t
        JOIN positions p ON p.id = t.position_id
        WHERE p.boss_account_id = ${bossAccountId}
          AND t.status IN ('queued', 'running', 'screening', 'waiting_review', 'completed')
          AND ${transaction.unsafe(screeningTerminalWaitExcludedSql("t.wait_reason_code"))}
          AND NOT ${transaction.unsafe(screeningBudgetStillOpenSql("t"))}
        FOR UPDATE OF t
      `;
      const sealed: string[] = [];
      for (const row of rows) {
        if (await applyScreeningBudgetSeal(transaction, row.id)) sealed.push(row.id);
      }
      return sealed;
    });
  }

  /** Tasks that finished a resume chunk and may need auto-greet / continuation. */
  async listTasksReadyForChunkFinalize(bossAccountId: string): Promise<string[]> {
    const rows = await this.sql<Array<{ id: string }>>`
      SELECT t.id
      FROM tasks t
      JOIN positions p ON p.id = t.position_id
      LEFT JOIN schedules s ON s.id = t.schedule_id
      WHERE p.boss_account_id = ${bossAccountId}
        AND t.status IN ('waiting_review', 'completed')
        AND ${this.sql.unsafe(screeningTerminalWaitExcludedSql("t.wait_reason_code"))}
        AND NOT EXISTS (
          SELECT 1 FROM candidate_position_states cps
          WHERE cps.latest_task_id = t.id
            AND cps.resume_screening_status IN ('queued', 'processing')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM tasks earlier
          JOIN positions earlier_position ON earlier_position.id = earlier.position_id
          LEFT JOIN schedules earlier_schedule ON earlier_schedule.id = earlier.schedule_id
          WHERE earlier_position.boss_account_id = p.boss_account_id
            AND earlier.id <> t.id
            AND (
              earlier.status IN ('queued', 'running', 'screening')
              OR (
                earlier.status = 'waiting_review'
                AND ${this.sql.unsafe(screeningTerminalWaitExcludedSql("earlier.wait_reason_code"))}
                AND COALESCE(earlier.error_message, '') NOT LIKE '%每日打招呼上限%'
                AND ${this.sql.unsafe(screeningBudgetStillOpenSql("earlier"))}
              )
              OR EXISTS (
                SELECT 1 FROM contact_intents open_greet
                WHERE open_greet.task_id = earlier.id
                  AND open_greet.action_kind = 'greet'
                  AND open_greet.status IN ('ready', 'processing')
              )
              OR EXISTS (
                SELECT 1 FROM candidate_position_states inflight_resume
                WHERE inflight_resume.latest_task_id = earlier.id
                  AND inflight_resume.resume_screening_status = 'processing'
              )
            )
            AND (
              COALESCE(earlier_schedule.created_at, earlier.created_at),
              earlier.created_at,
              earlier.id
            ) < (
              COALESCE(s.created_at, t.created_at),
              t.created_at,
              t.id
            )
        )
        AND (
          (
            t.auto_greet = true
            AND EXISTS (
              SELECT 1 FROM candidate_position_states cps
              WHERE cps.latest_task_id = t.id
                AND cps.rule_decision = 'matched'
                AND cps.resume_screening_status = 'screened'
                AND cps.review_status IN ('pending', 'approved')
                AND cps.contact_status NOT IN ('sent', 'queued', 'uncertain')
                AND NOT EXISTS (
                  SELECT 1 FROM contact_intents ci
                  WHERE ci.candidate_position_state_id = cps.id
                    AND ci.action_kind = 'greet'
                    AND ci.status IN (
                      'ready', 'processing', 'sent', 'uncertain', 'simulated', 'failed'
                    )
                )
            )
          )
          OR (
            ${this.sql.unsafe(screeningBudgetStillOpenSql("t"))}
            AND NOT EXISTS (
              SELECT 1 FROM contact_intents ci
              WHERE ci.task_id = t.id
                AND ci.action_kind = 'greet'
                AND ci.status IN ('ready', 'processing')
            )
          )
          OR (
            NOT ${this.sql.unsafe(screeningBudgetStillOpenSql("t"))}
            AND ${this.sql.unsafe(screeningBudgetMetWaitExcludedSql("t.wait_reason_code"))}
          )
        )
      ORDER BY COALESCE(s.created_at, t.created_at) ASC, t.created_at ASC, t.id ASC
      LIMIT 1
    `;
    return rows.map((row) => row.id);
  }

  /**
   * Account-day real auto-greet usage (Asia/Shanghai).
   * Counts sent + still-queued (ready/processing) + uncertain (consumed attempt).
   */
  async countAccountDailyRealGreets(bossAccountId: string): Promise<number> {
    const rows = await this.sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM contact_intents ci
      JOIN tasks t ON t.id = ci.task_id
      JOIN positions p ON p.id = t.position_id
      WHERE p.boss_account_id = ${bossAccountId}
        AND ci.action_kind = 'greet'
        AND ci.transport_mode = 'real'
        AND ci.status IN ('sent', 'ready', 'processing', 'uncertain')
        AND (timezone('Asia/Shanghai', COALESCE(ci.finished_at, ci.created_at)))::date
          = (timezone('Asia/Shanghai', now()))::date
    `;
    return Number(rows[0]?.count ?? 0);
  }

  /** Successful and still-open greets for one task. `candidate_limit` is compared to `sent`. */
  async countTaskGreetProgress(taskId: string): Promise<{ sent: number; inFlight: number }> {
    const rows = await this.sql<Array<{ sent: number; in_flight: number }>>`
      SELECT
        count(*) FILTER (WHERE status = 'sent')::int AS sent,
        count(*) FILTER (WHERE status IN ('ready', 'processing'))::int AS in_flight
      FROM contact_intents
      WHERE task_id = ${taskId}
        AND action_kind = 'greet'
    `;
    return {
      sent: Number(rows[0]?.sent ?? 0),
      inFlight: Number(rows[0]?.in_flight ?? 0)
    };
  }

  /**
   * Stop an auto-greet screening task at the account-day greet cap and disable
   * its schedule when present (schedule UI shows 已停用).
   */
  async stopTaskForDailyAutoGreetCap(input: {
    taskId: string;
    bossAccountId: string;
    used: number;
    limit: number;
  }): Promise<boolean> {
    return this.sql.begin(async (transaction) => {
      const tasks = await transaction<
        Array<{
          id: string;
          status: Task["status"];
          auto_greet: boolean;
          schedule_id: string | null;
          schedule_version: number | null;
        }>
      >`
        SELECT t.id, t.status, t.auto_greet, t.schedule_id, s.version AS schedule_version
        FROM tasks t
        LEFT JOIN schedules s ON s.id = t.schedule_id
        WHERE t.id = ${input.taskId}
        FOR UPDATE OF t
      `;
      const task = tasks[0];
      if (!task) return false;
      if (!task.auto_greet) return false;
      if (!["queued", "running", "screening", "waiting_review"].includes(task.status)) {
        return false;
      }
      const message = dailyAutoGreetCapStopMessage(input.limit);
      await transaction`
        UPDATE tasks
        SET status = 'cancelled',
          error_message = ${message},
          finished_at = now(),
          claimed_by = NULL, claim_token = NULL, claimed_at = NULL,
          wait_reason_code = NULL, wait_reason = NULL, next_run_at = NULL,
          last_progress_at = now(), version = version + 1
        WHERE id = ${input.taskId}
      `;
      await transaction`
        UPDATE candidate_position_states
        SET resume_screening_status = 'not_requested',
          resume_screening_attempts = 0,
          resume_screening_claimed_by = NULL,
          resume_screening_claimed_at = NULL,
          resume_screening_error = NULL,
          resume_screening_error_code = NULL,
          resume_screening_next_attempt_at = NULL,
          version = version + 1, updated_at = now()
        WHERE latest_task_id = ${input.taskId}
          AND resume_screening_status IN ('queued', 'processing')
      `;
      let scheduleDisabled = false;
      if (task.schedule_id) {
        const disabled = await transaction<Array<{ id: string }>>`
          UPDATE schedules
          SET enabled = false, version = version + 1, updated_at = now()
          WHERE id = ${task.schedule_id} AND enabled = true
          RETURNING id
        `;
        scheduleDisabled = Boolean(disabled[0]);
        if (scheduleDisabled) {
          await transaction`
            INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
            VALUES (
              ${randomUUID()}, 'system:auto-greet-daily-cap', 'schedule.cancelled',
              'schedule', ${task.schedule_id},
              ${transaction.json({
                reason: "daily_auto_greet_cap",
                taskId: input.taskId,
                used: input.used,
                limit: input.limit
              })}
            )
          `;
        }
      }
      await transaction`
        INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
        VALUES (
          ${randomUUID()}, 'system:auto-greet-daily-cap', 'task.stopped_daily_greet_cap',
          'task', ${input.taskId},
          ${transaction.json({
            bossAccountId: input.bossAccountId,
            used: input.used,
            limit: input.limit,
            scheduleDisabled,
            message
          })}
        )
      `;
      return true;
    });
  }

  async claimNextResumeScreening(
    workerId: string,
    bossAccountId: string,
    viewedSince: Date | null = null,
    contactPriorityTransportMode: "fake" | "real" | null = null,
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
          AND (
            resume_screening_next_attempt_at IS NULL
            OR resume_screening_next_attempt_at <= now()
          )
          AND EXISTS (
            SELECT 1 FROM tasks
            JOIN positions ON positions.id = tasks.position_id
            WHERE tasks.id = candidate_position_states.latest_task_id
              AND tasks.status IN ('screening', 'waiting_review')
              AND ${transaction.unsafe(screeningBudgetMetWaitExcludedSql("tasks.wait_reason_code"))}
              AND ${transaction.unsafe(screeningBudgetStillOpenSql("tasks"))}
              AND positions.boss_account_id = ${bossAccountId}
              AND NOT EXISTS (
                SELECT 1
                FROM tasks earlier
                JOIN positions earlier_position ON earlier_position.id = earlier.position_id
                LEFT JOIN schedules earlier_schedule ON earlier_schedule.id = earlier.schedule_id
                LEFT JOIN schedules current_schedule ON current_schedule.id = tasks.schedule_id
                WHERE earlier_position.boss_account_id = positions.boss_account_id
                  AND earlier.id <> tasks.id
                  AND (
                    earlier.status IN ('queued', 'running', 'screening')
                    OR (
                      earlier.status = 'waiting_review'
                      AND ${transaction.unsafe(screeningTerminalWaitExcludedSql("earlier.wait_reason_code"))}
                      AND COALESCE(earlier.error_message, '') NOT LIKE '%每日打招呼上限%'
                      AND ${transaction.unsafe(screeningBudgetStillOpenSql("earlier"))}
                    )
                    OR EXISTS (
                      SELECT 1 FROM contact_intents open_greet
                      WHERE open_greet.task_id = earlier.id
                        AND open_greet.action_kind = 'greet'
                        AND open_greet.status IN ('ready', 'processing')
                    )
                    OR EXISTS (
                      SELECT 1 FROM candidate_position_states inflight_resume
                      WHERE inflight_resume.latest_task_id = earlier.id
                        AND inflight_resume.resume_screening_status = 'processing'
                    )
                  )
                  AND (
                    COALESCE(earlier_schedule.created_at, earlier.created_at),
                    earlier.created_at,
                    earlier.id
                  ) < (
                    COALESCE(current_schedule.created_at, tasks.created_at),
                    tasks.created_at,
                    tasks.id
                  )
              )
          )
          AND (
            ${contactPriorityTransportMode}::text IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM contact_intents priority_intent
              JOIN candidate_position_states priority_state
                ON priority_state.id = priority_intent.candidate_position_state_id
              JOIN positions priority_position
                ON priority_position.id = priority_state.position_id
              JOIN outbox_events priority_event
                ON priority_event.aggregate_id = priority_intent.id
              WHERE priority_position.boss_account_id = ${bossAccountId}
                AND priority_intent.status = 'ready'
                AND priority_intent.transport_mode = ${contactPriorityTransportMode}
                AND priority_event.event_type = 'contact.requested'
                AND priority_event.status = 'pending'
                AND priority_event.available_at <= now()
            )
          )
          AND (
            ${viewedSince}::timestamptz IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM audit_logs
              WHERE audit_logs.action = 'candidate.resume_viewed'
                AND (
                  (
                    audit_logs.resource_type = 'candidate_position_state'
                    AND audit_logs.resource_id = candidate_position_states.id::text
                  )
                  OR audit_logs.payload ->> 'candidateId' =
                    candidate_position_states.candidate_id::text
                )
                AND audit_logs.created_at >= ${viewedSince}::timestamptz
            )
            OR EXISTS (
              SELECT 1
              FROM audit_logs retry_authorization
              WHERE retry_authorization.action =
                  'candidate.resume_screening.retry_authorized'
                AND retry_authorization.resource_type =
                  'candidate_position_state'
                AND retry_authorization.resource_id =
                  candidate_position_states.id::text
                AND retry_authorization.created_at > COALESCE(
                  (
                    SELECT MAX(resume_view.created_at)
                    FROM audit_logs resume_view
                    WHERE resume_view.action = 'candidate.resume_viewed'
                      AND (
                        (
                          resume_view.resource_type =
                            'candidate_position_state'
                          AND resume_view.resource_id =
                            candidate_position_states.id::text
                        )
                        OR resume_view.payload ->> 'candidateId' =
                          candidate_position_states.candidate_id::text
                      )
                  ),
                  '-infinity'::timestamptz
                )
            )
            OR EXISTS (
              -- Mid-flight orphan: this CPS was opened today but never reached
              -- screened/failed. Claim set is already queued / stale processing,
              -- so reclaim matches UI requeue without ops writing retry_authorized.
              SELECT 1
              FROM audit_logs mid_flight_view
              WHERE mid_flight_view.action = 'candidate.resume_viewed'
                AND mid_flight_view.resource_type =
                  'candidate_position_state'
                AND mid_flight_view.resource_id =
                  candidate_position_states.id::text
                AND mid_flight_view.created_at >= ${viewedSince}::timestamptz
            )
            OR (
              -- Cross-resource same-day view orphan (2026-09-22 morning):
              -- a newly admitted / still-claimable CPS is blocked by
              -- candidate.resume_viewed on candidateId (other CPS, boss_chat,
              -- list browse) while THIS row never finished screening.
              -- Auto-allow reclaim like ops POST …/resume-screenings.
              -- Still suppress when another CPS for the same candidate already
              -- finished screening today (screened / failed / no_text).
              NOT EXISTS (
                SELECT 1
                FROM candidate_position_states other_done
                WHERE other_done.candidate_id =
                    candidate_position_states.candidate_id
                  AND other_done.id <> candidate_position_states.id
                  AND other_done.resume_screening_status IN (
                    'screened', 'failed', 'no_text'
                  )
                  AND other_done.updated_at >= ${viewedSince}::timestamptz
              )
            )
          )
        ORDER BY is_repeat ASC,
          COALESCE(resume_screening_next_attempt_at, '-infinity'::timestamptz) ASC,
          updated_at ASC
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
          resume_screening_next_attempt_at = NULL,
          resume_screening_error = NULL,
          updated_at = now()
        WHERE id = ${stateId}
      `;
      await transaction`
        UPDATE tasks
        SET wait_reason_code = NULL, wait_reason = NULL, next_run_at = NULL,
          last_progress_at = now(), version = version + 1
        WHERE id = (
          SELECT latest_task_id FROM candidate_position_states WHERE id = ${stateId}
        )
      `;
      const rows = await transaction<
        Array<{
          state_id: string;
          candidate_id: string;
          task_id: string;
          candidate_name: string;
          boss_account_id: string;
          boss_job_keyword: string | null;
          boss_job_id: string | null;
          boss_job_name_unique: boolean;
          source: "recommend" | "search";
          search_keyword: string | null;
          rule_version_id: string;
          rule_config: RuleConfig;
          source_boss_filters: BossRecommendationFilterPlan | null;
          semantic_mode: "off" | "shadow" | "active";
          semantic_catalog_version_id: string | null;
          semantic_catalog_entries: unknown;
          resume_screening_attempts: number;
          source_reference: string;
          source_locator: import("@boss-forge/contracts").CandidateSourceLocator | null;
          raw_fields: Record<string, string>;
          source_evidence: string[];
          raw_text: string;
        }>
      >`
        SELECT cps.id AS state_id, cps.candidate_id, t.id AS task_id,
          c.display_name AS candidate_name,
          p.boss_account_id,
          CASE WHEN t.source_job_id = p.boss_job_id THEN p.boss_job_keyword
            ELSE COALESCE(t.source_job_label, t.source_job_name, p.boss_job_keyword) END AS boss_job_keyword,
          t.source_job_id AS boss_job_id, CASE WHEN t.source_job_id = p.boss_job_id THEN p.boss_job_name_unique ELSE false END AS boss_job_name_unique,
          t.source, t.search_keyword, t.source_boss_filters,
          COALESCE(rv.external_version_id, rv.id::text) AS rule_version_id,
          rv.config AS rule_config, p.semantic_mode,
          scv.id AS semantic_catalog_version_id, scv.entries AS semantic_catalog_entries,
          cps.resume_screening_attempts,
          cs.source_reference, cs.source_locator, cs.raw_fields, cs.source_evidence, cs.raw_text
        FROM candidate_position_states cps
        JOIN candidates c ON c.id = cps.candidate_id
        JOIN positions p ON p.id = cps.position_id
        JOIN tasks t ON t.id = cps.latest_task_id
        JOIN rule_versions rv ON rv.id = cps.rule_version_id
        JOIN candidate_snapshots cs ON cs.id = cps.latest_snapshot_id
        LEFT JOIN semantic_catalog_versions scv ON scv.id = p.semantic_active_catalog_version_id
        WHERE cps.id = ${stateId}
      `;
      const row = rows[0];
      if (!row) return null;
      const indexMatch = row.source_reference.match(/^[^:]+:(\d+):/u);
      return {
        stateId: row.state_id,
        candidateId: row.candidate_id,
        taskId: row.task_id,
        ruleVersionId: row.rule_version_id,
        candidateName: row.candidate_name,
        bossAccountId: row.boss_account_id,
        bossJobKeyword: row.boss_job_keyword,
        bossJobId: row.boss_job_id,
        bossJobNameUnique: row.boss_job_name_unique,
        source: row.source,
        searchKeyword: row.search_keyword,
        ruleConfig: row.rule_config,
        sourceBossFilters: row.source_boss_filters ?? null,
        semanticMode: row.semantic_mode,
        semanticCatalogVersionId: row.semantic_catalog_version_id,
        semanticCatalogEntries: row.semantic_catalog_entries,
        resumeScreeningAttempts: row.resume_screening_attempts,
        candidate: {
          index: Number(indexMatch?.[1] ?? "1"),
          name: row.candidate_name,
          source: row.source,
          ...(row.source_locator ? { sourceLocator: row.source_locator } : {}),
          fields: row.raw_fields,
          evidence: row.source_evidence,
          raw: row.raw_text,
        },
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
    /** Explicit offline re-evaluation of an already screened, saved resume.
     * An optimistic version is mandatory for this alternative to a live claim. */
    recheckExpectedVersion?: number;
  }): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const taskRows = await transaction<Array<{ status: Task["status"] }>>`
        SELECT status FROM tasks WHERE id = ${input.job.taskId} FOR UPDATE
      `;
      if (!taskRows[0]) throw new Error("Resume screening task was not found.");
      const allowedTaskStatuses = input.recheckExpectedVersion === undefined
        ? ["screening", "waiting_review"] : ["screening", "waiting_review", "completed"];
      if (!allowedTaskStatuses.includes(taskRows[0].status)) {
        if (input.recheckExpectedVersion !== undefined) throw new Error("Task is no longer available for saved resume re-evaluation.");
        return;
      }
      if (input.recheckExpectedVersion !== undefined) {
        const previous = await transaction`
          SELECT rule_decision, rule_confidence, review_status, version, resume_text_hash
          FROM candidate_position_states WHERE id = ${input.job.stateId}
            AND latest_task_id = ${input.job.taskId} AND resume_screening_status = 'screened'
            AND version = ${input.recheckExpectedVersion} FOR UPDATE
        `;
        if (!previous[0]) throw new Error("Saved resume changed before re-evaluation; please reload.");
        await transaction`
          INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
          VALUES (${randomUUID()}, ${input.workerId}, 'candidate.resume_recheck.started',
            'candidate_position_state', ${input.job.stateId}, ${transaction.json({ previous: previous[0], taskId: input.job.taskId, source: 'saved_resume_screenshot' })})
        `;
      }
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
          resume_screening_error_code = NULL,
          resume_screening_next_attempt_at = NULL,
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
          AND ((resume_screening_status = 'processing' AND ${input.recheckExpectedVersion ?? null}::integer IS NULL)
            OR (resume_screening_status = 'screened' AND version = ${input.recheckExpectedVersion ?? null}::integer))
        RETURNING version, review_status
      `;
      const updatedState = updatedStates[0];
      if (!updatedState) throw new Error("Candidate resume screening claim is no longer active.");
      await transaction`UPDATE candidate_position_states SET salary_screening = ${input.record.salaryScreening ? transaction.json(input.record.salaryScreening) : null} WHERE id = ${input.job.stateId}`;
      await enqueueRecruitmentAssessment(transaction, { stateId: input.job.stateId, taskId: input.job.taskId,
        ruleVersionId: input.job.ruleVersionId, ruleConfig: input.job.ruleConfig, resumeText: input.record.rawText, decision: input.record.decision });
      await transaction`
        UPDATE operational_alerts
        SET status = 'resolved', resolved_at = now()
        WHERE resource_type = 'candidate_position_state'
          AND resource_id = ${input.job.stateId}
          AND alert_type IN ('resume_screening_failed', 'resume_screening_no_text')
          AND status <> 'resolved'
      `;
      await transaction`
        DELETE FROM match_evidence WHERE candidate_position_state_id = ${input.job.stateId}
      `;
      for (const evidence of input.record.evidence) {
        await transaction`
          INSERT INTO match_evidence (
            id, candidate_position_state_id, source_snapshot_id, rule_version_id,
            capability_id, canonical_label, dictionary_version, source_text,
            normalized_alias, evidence_status, confidence, reason_codes
          ) SELECT
            ${randomUUID()}, cps.id, cps.latest_snapshot_id, cps.rule_version_id,
            ${evidence.capabilityId ?? input.record.capabilityId},
            ${evidence.canonicalLabel ?? input.record.canonicalLabel},
            ${evidence.dictionaryVersion ?? input.record.dictionaryVersion},
            ${evidence.sourceText}, ${evidence.normalizedAlias}, ${evidence.status},
            ${evidence.confidence},
            ${transaction.json(evidence.reasonCodes ?? input.record.reasonCodes)}
          FROM candidate_position_states cps
          WHERE cps.id = ${input.job.stateId}
        `;
      }
      await transaction`
        DELETE FROM semantic_evaluations
        WHERE candidate_position_state_id = ${input.job.stateId}
      `;
      for (const evaluation of input.record.semanticEvaluations ?? []) {
        await transaction`
          INSERT INTO semantic_evaluations (
            id, candidate_position_state_id, source_snapshot_id, rule_version_id,
            criterion_id, fact_type, execution_mode, result, normalized_value,
            qualifier, evidence, confidence, extractor, model_version,
            prompt_version, catalog_version, rubric_version, runtime_mode,
            reason_codes
          )
          SELECT
            ${randomUUID()}, cps.id, cps.latest_snapshot_id, cps.rule_version_id,
            ${evaluation.criterionId}, ${evaluation.factType},
            ${evaluation.executionMode}, ${evaluation.result},
            ${transaction.json(evaluation.normalizedValue)}, ${evaluation.qualifier},
            ${transaction.json(evaluation.evidence)}, ${evaluation.confidence},
            ${evaluation.extractor}, ${evaluation.modelVersion},
            ${evaluation.promptVersion}, ${evaluation.catalogVersion},
            ${evaluation.rubricVersion}, ${evaluation.runtimeMode},
            ${transaction.json(evaluation.reasonCodes)}
          FROM candidate_position_states cps
          WHERE cps.id = ${input.job.stateId}
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
            ocrRequestId: input.ocrRequestId ?? null,
            recheckSource: input.recheckExpectedVersion === undefined ? null : 'saved_resume_screenshot',
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
          END,
          wait_reason_code = NULL, wait_reason = NULL, next_run_at = NULL,
          version = version + 1, last_progress_at = now()
        WHERE id = ${input.job.taskId} AND (status IN ('screening', 'waiting_review')
          OR (status = 'completed' AND ${input.recheckExpectedVersion ?? null}::integer IS NOT NULL))
      `;
      const integration = await loadTaskIntegrationContext(transaction, input.job.taskId);
      if (integration) {
        await enqueueIntegrationEvent(transaction, {
          deduplicationKey: `task:${input.job.taskId}:candidate:${input.job.stateId}:screened:${updatedState.version}`,
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
            evidence: input.record.evidence,
          },
        });
      }
      await enqueueTaskCompletionIfReady(transaction, input.job.taskId);
      await applyScreeningBudgetSeal(transaction, input.job.taskId);
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
          resume_screening_error_code = 'content_empty',
          resume_screening_next_attempt_at = NULL,
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
      await transaction`DELETE FROM recruitment_assessments WHERE candidate_position_state_id = ${input.stateId}`;
      await transaction`
        INSERT INTO operational_alerts (
          id, department_id, severity, alert_type, message,
          resource_type, resource_id
        )
        SELECT ${randomUUID()}, p.department_id, 'warning',
          'resume_screening_no_text',
          '简历已打开，但 OCR 未取得可用正文。请人工查看截图后重试或完成审核。',
          'candidate_position_state', cps.id::text
        FROM candidate_position_states cps
        JOIN positions p ON p.id = cps.position_id
        WHERE cps.id = ${input.stateId}
          AND NOT EXISTS (
            SELECT 1 FROM operational_alerts existing
            WHERE existing.alert_type = 'resume_screening_no_text'
              AND existing.resource_type = 'candidate_position_state'
              AND existing.resource_id = cps.id::text
              AND existing.status <> 'resolved'
          )
      `;
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
          END,
          wait_reason_code = NULL, wait_reason = NULL, next_run_at = NULL,
          version = version + 1, last_progress_at = now()
        WHERE id = ${input.taskId} AND status IN ('screening', 'waiting_review')
      `;
      const integration = await loadTaskIntegrationContext(transaction, input.taskId);
      if (integration) {
        await enqueueIntegrationEvent(transaction, {
          deduplicationKey: `task:${input.taskId}:candidate:${input.stateId}:screening-no-text:${updatedState.version}`,
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
            failureCode: "content_empty",
            message: "简历已预览，但未取得可用于自动筛选的 OCR 文本。",
            recoverable: true,
          },
        });
      }
      await enqueueTaskCompletionIfReady(transaction, input.taskId);
      await applyScreeningBudgetSeal(transaction, input.taskId);
    });
  }

  async failResumeScreening(input: {
    stateId: string;
    taskId: string;
    message: string;
    workerId: string;
    errorCode?: ResumeScreeningErrorCode;
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
          resume_screening_error_code = ${input.errorCode ?? "worker_error"},
          resume_screening_next_attempt_at = NULL,
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
        INSERT INTO operational_alerts (
          id, department_id, severity, alert_type, message,
          resource_type, resource_id
        )
        SELECT ${randomUUID()}, p.department_id,
          CASE WHEN ${input.errorCode ?? "worker_error"} = 'risk_control'
            THEN 'critical' ELSE 'warning' END,
          'resume_screening_failed',
          CASE
            WHEN ${input.errorCode ?? "worker_error"} = 'risk_control'
              THEN 'BOSS 出现风控信号，系统已停止该候选人的自动精筛。请先检查账号状态。'
            WHEN cps.resume_screening_attempts >= 3
              THEN '简历精筛已连续失败 3 次，系统不再自动重试。请人工检查候选人页面或 OCR 配置。'
            ELSE '简历精筛失败且未安排自动重试。请查看失败原因后人工重试或审核。'
          END,
          'candidate_position_state', cps.id::text
        FROM candidate_position_states cps
        JOIN positions p ON p.id = cps.position_id
        WHERE cps.id = ${input.stateId}
          AND NOT EXISTS (
            SELECT 1 FROM operational_alerts existing
            WHERE existing.alert_type = 'resume_screening_failed'
              AND existing.resource_type = 'candidate_position_state'
              AND existing.resource_id = cps.id::text
              AND existing.status <> 'resolved'
          )
      `;
      await transaction`
        INSERT INTO audit_logs (
          id, actor_id, action, resource_type, resource_id, payload
        ) VALUES (
          ${randomUUID()}, ${input.workerId}, 'candidate.resume_screening.failed',
          'candidate_position_state', ${input.stateId},
          ${transaction.json({
            taskId: input.taskId,
            message,
            errorCode: input.errorCode ?? "worker_error"
          })}
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
          END,
          wait_reason_code = NULL, wait_reason = NULL, next_run_at = NULL,
          version = version + 1, last_progress_at = now()
        WHERE id = ${input.taskId} AND status IN ('screening', 'waiting_review')
      `;
      const integration = await loadTaskIntegrationContext(transaction, input.taskId);
      if (integration) {
        await enqueueIntegrationEvent(transaction, {
          deduplicationKey: `task:${input.taskId}:candidate:${input.stateId}:screening-failed:${updatedState.version}`,
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
            failureCode: input.errorCode ?? "worker_error",
            message,
            recoverable: resumeScreeningFailureRecoverable(
              input.errorCode ?? "worker_error",
            ),
          },
        });
      }
      await enqueueTaskCompletionIfReady(transaction, input.taskId);
      await applyScreeningBudgetSeal(transaction, input.taskId);
    });
  }

  async deferResumeScreening(input: {
    stateId: string;
    taskId: string;
    message: string;
    workerId: string;
    errorCode: ResumeScreeningErrorCode;
    nextAttemptAt: Date;
  }): Promise<void> {
    const message = input.message.slice(0, 1_000);
    await this.sql.begin(async (transaction) => {
      const updatedStates = await transaction<Array<{ id: string }>>`
        UPDATE candidate_position_states
        SET resume_screening_status = 'queued',
          resume_screening_error = ${message},
          resume_screening_error_code = ${input.errorCode},
          resume_screening_next_attempt_at = ${input.nextAttemptAt},
          resume_screening_claimed_by = NULL,
          resume_screening_claimed_at = NULL,
          version = version + 1,
          updated_at = now()
        WHERE id = ${input.stateId}
          AND latest_task_id = ${input.taskId}
          AND resume_screening_status = 'processing'
        RETURNING id
      `;
      if (!updatedStates[0]) {
        throw new Error("Candidate state not found during screening deferral.");
      }
      await transaction`
        UPDATE tasks SET status = 'screening', finished_at = NULL,
          wait_reason_code = 'resume_retry_scheduled',
          wait_reason = '候选人页面暂时不可用，系统将自动重试',
          next_run_at = ${input.nextAttemptAt}, version = version + 1,
          last_progress_at = now()
        WHERE id = ${input.taskId} AND status IN ('screening', 'waiting_review')
      `;
      await transaction`
        INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
        VALUES (
          ${randomUUID()}, ${input.workerId}, 'candidate.resume_screening.deferred',
          'candidate_position_state', ${input.stateId},
          ${transaction.json({
            taskId: input.taskId,
            message,
            errorCode: input.errorCode,
            nextAttemptAt: input.nextAttemptAt.toISOString()
          })}
        )
      `;
      await transaction`
        INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
        VALUES (
          ${randomUUID()}, ${input.workerId}, 'candidate.resume_screening.retry_authorized',
          'candidate_position_state', ${input.stateId},
          ${transaction.json({
            taskId: input.taskId,
            reason: "可恢复的 BOSS 页面异常，自动延后重试",
            errorCode: input.errorCode,
            nextAttemptAt: input.nextAttemptAt.toISOString()
          })}
        )
      `;
    });
  }

  async requeueResumeScreening(stateId: string, actorId: string): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const currentStates = await transaction<
        Array<{
          latest_task_id: string;
          resume_screening_status: DashboardCandidate["resumeScreeningStatus"];
          resume_screening_error_code: ResumeScreeningErrorCode | null;
        }>
      >`
        SELECT latest_task_id, resume_screening_status, resume_screening_error_code
        FROM candidate_position_states WHERE id = ${stateId}
      `;
      const currentState = currentStates[0];
      const taskId = currentState?.latest_task_id;
      if (!taskId) throw new Error("Candidate state was not found.");
      if (
        currentState.resume_screening_status === "failed" &&
        !resumeScreeningFailureRecoverable(currentState.resume_screening_error_code)
      ) {
        throw new Error(
          "Candidate resume screening cannot be retried until the account or candidate target is rechecked.",
        );
      }
      const taskRows = await transaction<Array<{ status: Task["status"] }>>`
        SELECT status FROM tasks WHERE id = ${taskId} FOR UPDATE
      `;
      if (!taskRows[0] || !["screening", "waiting_review"].includes(taskRows[0].status)) {
        throw new Error("Candidate screening task is not open for requeue.");
      }
      const rows = await transaction<{ id: string; latest_task_id: string }[]>`
        UPDATE candidate_position_states
        SET resume_screening_status = 'queued', resume_screening_error = NULL,
          resume_screening_error_code = NULL,
          resume_screening_next_attempt_at = NULL,
          resume_screening_claimed_by = NULL, resume_screening_claimed_at = NULL,
          version = version + 1, updated_at = now()
        WHERE id = ${stateId} AND latest_task_id = ${taskId}
          AND resume_screening_status <> 'processing'
        RETURNING id, latest_task_id
      `;
      const state = rows[0];
      if (!state) throw new Error("Candidate state was not found or is currently processing.");
      await transaction`
        UPDATE tasks SET status = 'screening', finished_at = NULL,
          wait_reason_code = NULL, wait_reason = NULL, next_run_at = NULL,
          version = version + 1, last_progress_at = now()
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
      await transaction`
        INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
        VALUES (
          ${randomUUID()}, ${actorId}, 'candidate.resume_screening.retry_authorized',
          'candidate_position_state', ${stateId},
          ${transaction.json({
            taskId: state.latest_task_id,
            reason: "人工重新精筛"
          })}
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
          claimed_by = NULL, claim_token = NULL, claimed_at = NULL,
          wait_reason_code = NULL, wait_reason = NULL, next_run_at = NULL,
          last_progress_at = now(), version = version + 1
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
            errorMessage,
          },
        });
      }
    });
  }

  async getResumeScreenshot(stateId: string): Promise<{ positionId: string; screenshotPath: string | null } | null> {
    const rows = await this.sql<Array<{ position_id: string; resume_screenshot_path: string | null }>>`
      SELECT position_id, resume_screenshot_path FROM candidate_position_states WHERE id = ${stateId}
    `;
    return rows[0] ? { positionId: rows[0].position_id, screenshotPath: rows[0].resume_screenshot_path } : null;
  }

  /** Persist the completed capture before OCR so HR can still review it if OCR fails. */
  async saveResumeScreenshot(input: { stateId: string; taskId: string; workerId: string; screenshotPath: string }): Promise<void> {
    const rows = await this.sql`
      UPDATE candidate_position_states SET resume_screenshot_path = ${input.screenshotPath}
      WHERE id = ${input.stateId} AND latest_task_id = ${input.taskId}
        AND resume_screening_status = 'processing' AND resume_screening_claimed_by = ${input.workerId}
      RETURNING id
    `;
    if (!rows.length) throw new ResumeScreeningLeaseLostError();
  }

  async getCandidateDetail(stateId: string): Promise<CandidateDetail | null> {
    const rows = await this.sql<
      Array<{
        state_id: string;
        candidate_id: string;
        task_id: string;
        position_id: string;
        display_name: string;
        position_name: string;
        rule_decision: DashboardCandidate["ruleDecision"];
        salary_screening: DashboardCandidate["salaryScreening"];
        assessment: DashboardCandidate["assessment"];
        rule_confidence: number;
        review_status: DashboardCandidate["reviewStatus"];
        contact_status: DashboardCandidate["contactStatus"];
        state_version: number;
        resume_screening_status: DashboardCandidate["resumeScreeningStatus"];
        current_english_level: string | null;
        resume_screened_at: Date | null;
        resume_screening_error: string | null;
        resume_screening_error_code: ResumeScreeningErrorCode | null;
        resume_screening_next_attempt_at: Date | null;
        task_status: Task["status"];
        is_repeat: boolean;
        is_current: boolean;
        first_seen_at: Date;
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
      SELECT cps.id AS state_id, c.id AS candidate_id,
        cps.latest_task_id AS task_id, p.id AS position_id, c.display_name,
        p.name AS position_name, cps.salary_screening,
        (SELECT jsonb_build_object('status', a.status, 'result', a.result, 'error', a.error, 'ruleVersionId', a.rule_version_id)
         FROM recruitment_assessments a WHERE a.candidate_position_state_id = cps.id AND cps.resume_screening_status = 'screened') AS assessment, cps.rule_decision, cps.rule_confidence,
        cps.review_status, cps.contact_status, cps.version AS state_version,
        cps.resume_screening_status, cps.current_english_level,
        cps.resume_screened_at, cps.resume_screening_error,
        cps.resume_screening_error_code, cps.resume_screening_next_attempt_at,
        t.status AS task_status,
        cps.is_repeat, cps.is_current, c.created_at AS first_seen_at,
        cps.resume_screenshot_path,
        cs.source_evidence, cs.raw_fields, cs.raw_text, cs.source, cs.collected_at,
        cps.updated_at, rv.version AS rule_version, rv.dictionary_version
      FROM candidate_position_states cps
      JOIN candidates c ON c.id = cps.candidate_id
      JOIN positions p ON p.id = cps.position_id
      JOIN tasks t ON t.id = cps.latest_task_id
      JOIN candidate_snapshots cs ON cs.id = cps.latest_snapshot_id
      JOIN rule_versions rv ON rv.id = cps.rule_version_id
      WHERE cps.id = ${stateId}
    `;
    const row = rows[0];
    if (!row) return null;
    const [evidenceRows, semanticRows, reviewRows] = await Promise.all([
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
          criterion_id: string;
          fact_type: string;
          execution_mode: "normalized_entity" | "semantic_rubric";
          result: "matched" | "not_matched" | "unknown";
          normalized_value: SemanticEvaluation["normalizedValue"];
          qualifier: string | null;
          evidence: string[];
          confidence: number;
          extractor: "alias" | "llm" | "none";
          model_version: string | null;
          prompt_version: string;
          catalog_version: string;
          rubric_version: string | null;
          runtime_mode: "off" | "shadow" | "active";
          reason_codes: string[];
        }>
      >`
        SELECT criterion_id, fact_type, execution_mode, result, normalized_value,
          qualifier, evidence, confidence, extractor, model_version,
          prompt_version, catalog_version, rubric_version, runtime_mode, reason_codes
        FROM semantic_evaluations
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
      `,
    ]);
    return {
      stateId: row.state_id,
      candidateId: row.candidate_id,
      taskId: row.task_id,
      positionId: row.position_id,
      name: row.display_name,
      positionName: row.position_name,
      ruleDecision: row.rule_decision,
      salaryScreening: row.salary_screening ?? null,
      assessment: row.assessment ?? null,
      ruleConfidence: row.rule_confidence,
      reviewStatus: row.review_status,
      contactStatus: row.contact_status,
      stateVersion: row.state_version,
      resumeScreeningStatus: row.resume_screening_status,
      currentEnglishLevel: row.current_english_level,
      resumeScreenedAt: row.resume_screened_at ? iso(row.resume_screened_at) : null,
      resumeScreeningError: row.resume_screening_error,
      resumeScreeningErrorCode: row.resume_screening_error_code,
      resumeScreeningNextAttemptAt: row.resume_screening_next_attempt_at
        ? iso(row.resume_screening_next_attempt_at)
        : null,
      isRepeat: row.is_repeat,
      isCurrent: row.is_current,
      firstSeenAt: iso(row.first_seen_at),
      nextAction: candidateNextAction({
        taskStatus: row.task_status,
        resumeStatus: row.resume_screening_status,
        errorCode: row.resume_screening_error_code,
        reviewStatus: row.review_status,
        contactStatus: row.contact_status,
        nextAttemptAt: row.resume_screening_next_attempt_at,
      }),
      failedRuleLabels: summarizeFailedRuleLabels(
        evidenceRows.map((item) => ({
          capabilityId: item.capability_id,
          canonicalLabel: item.canonical_label,
          status: item.evidence_status,
          reasonCodes: item.reason_codes,
        })),
      ),
      missingRuleLabels: summarizeMissingRuleLabels(evidenceRows.map((item) => ({
        capabilityId: item.capability_id, canonicalLabel: item.canonical_label, status: item.evidence_status, reasonCodes: item.reason_codes,
      }))),
      semanticSummary: summarizeSemanticEvaluations(semanticRows),
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
        reasonCodes: item.reason_codes,
      })),
      semanticEvaluations: semanticRows.map((item) => ({
        criterionId: item.criterion_id,
        factType: item.fact_type,
        executionMode: item.execution_mode,
        result: item.result,
        normalizedValue: item.normalized_value,
        qualifier: item.qualifier,
        evidence: item.evidence,
        confidence: item.confidence,
        extractor: item.extractor,
        modelVersion: item.model_version,
        promptVersion: item.prompt_version,
        catalogVersion: item.catalog_version,
        rubricVersion: item.rubric_version,
        runtimeMode: item.runtime_mode,
        reasonCodes: item.reason_codes,
      })),
      reviews: reviewRows.map((item) => ({
        id: item.id,
        decision: item.decision,
        note: item.note,
        correctionCode: item.correction_code,
        reviewerId: item.reviewer_id,
        previousStatus: item.previous_status,
        resultingVersion: item.resulting_version,
        createdAt: iso(item.created_at),
      })),
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
        if (
          replay.candidate_position_state_id !== input.stateId ||
          replay.decision !== input.decision ||
          replay.note !== input.note ||
          replay.correction_code !== (input.correctionCode ?? null) ||
          replay.reviewer_id !== input.reviewerId ||
          replay.resulting_version - 1 !== input.expectedVersion
        ) {
          throw new Error("Idempotency-Key is already used for a different review request.");
        }
        return {
          id: replay.id,
          decision: replay.decision,
          note: replay.note,
          correctionCode: replay.correction_code,
          reviewerId: replay.reviewer_id,
          previousStatus: replay.previous_status,
          resultingVersion: replay.resulting_version,
          createdAt: iso(replay.created_at),
        };
      }
      const stateRows = await transaction<
        Array<{
          version: number;
          review_status: ReviewRecord["previousStatus"];
          resume_screening_status: DashboardCandidate["resumeScreeningStatus"];
          stage_key: string;
        }>
      >`
        SELECT version, review_status, resume_screening_status, stage_key
        FROM candidate_position_states
        WHERE id = ${input.stateId}
        FOR UPDATE
      `;
      const state = stateRows[0];
      if (!state) throw new Error("Candidate state was not found.");
      if (["not_requested", "queued", "processing"].includes(state.resume_screening_status)) {
        throw new Error("Candidate resume screening must finish before human review.");
      }
      if (input.decision !== state.review_status && (await transaction`SELECT c.id FROM recruitment_cases c JOIN candidate_position_states s ON s.candidate_id=c.candidate_id AND s.position_id=c.position_id WHERE s.id=${input.stateId} AND c.stage<>'review' LIMIT 1`)[0]) {
        throw new Error("此候选人已进入招聘跟进，请在招聘跟进档案中记录后续结论或结束原因。");
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
        SET review_status = ${input.decision},
          stage_key = CASE
            WHEN ${input.decision} = 'rejected' THEN 'rejected'
            WHEN ${input.decision} = 'approved' AND stage_key IN ('screening', 'review') THEN 'approved'
            ELSE stage_key
          END,
          stage_updated_at = CASE
            WHEN ${input.decision} = 'rejected'
              OR (${input.decision} = 'approved' AND stage_key IN ('screening', 'review'))
            THEN now()
            ELSE stage_updated_at
          END,
          rejection_reason = CASE
            WHEN ${input.decision} = 'rejected' THEN NULLIF(${input.note}, '')
            ELSE rejection_reason
          END,
          version = ${resultingVersion}, updated_at = now()
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
            correctionCode: input.correctionCode ?? null,
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
        createdAt: iso(row.created_at),
      };
    });
  }

  async getDashboard(options?: {
    positionIds?: string[];
    taskLimit?: number;
    taskOffset?: number;
  }): Promise<DashboardSnapshot> {
    const positionScope = options?.positionIds === undefined ? null : options.positionIds;
    const taskLimit = Math.min(Math.max(options?.taskLimit ?? 100, 1), 200);
    const taskOffset = Math.max(options?.taskOffset ?? 0, 0);
    const [positions, activeRuleRows, latestRuleRows, taskRows, candidateRows, metricRows] =
      await Promise.all([
        this.listPositions(positionScope ?? undefined),
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
        WHERE (${positionScope}::uuid[] IS NULL OR rs.position_id = ANY(${positionScope}::uuid[]))
        ORDER BY rs.position_id
      `,
        this.sql<
          Array<{
            position_id: string;
            id: string;
            version: number;
            lifecycle_status: "draft" | "pending_approval" | "published" | "retired";
            active: boolean;
            config: RuleConfig;
            dictionary_version: string;
            created_at: Date;
          }>
        >`
        SELECT DISTINCT ON (rs.position_id) rs.position_id, rv.id, rv.version,
          rv.lifecycle_status, (rs.active_version_id = rv.id) AS active,
          rv.config, rv.dictionary_version, rv.created_at
        FROM rule_sets rs
        JOIN rule_versions rv ON rv.rule_set_id = rs.id
        WHERE (${positionScope}::uuid[] IS NULL OR rs.position_id = ANY(${positionScope}::uuid[]))
        ORDER BY rs.position_id, rv.version DESC
      `,
        this.sql.unsafe<TaskRow[]>(
          `${TASK_SELECT}
           WHERE ($1::uuid[] IS NULL OR t.position_id = ANY($1::uuid[]))
           ORDER BY t.created_at DESC, t.id DESC LIMIT $2 OFFSET $3`,
          [positionScope, taskLimit, taskOffset],
        ),
        this.sql<
          Array<{
            state_id: string;
            candidate_id: string;
            task_id: string;
            position_id: string;
            display_name: string;
            position_name: string;
            rule_decision: DashboardCandidate["ruleDecision"];
        salary_screening: DashboardCandidate["salaryScreening"];
        assessment: DashboardCandidate["assessment"];
            rule_confidence: number;
            review_status: DashboardCandidate["reviewStatus"];
            contact_status: DashboardCandidate["contactStatus"];
            state_version: number;
            resume_screening_status: DashboardCandidate["resumeScreeningStatus"];
            current_english_level: string | null;
            resume_screened_at: Date | null;
            resume_screening_error: string | null;
            resume_screening_error_code: ResumeScreeningErrorCode | null;
            resume_screening_next_attempt_at: Date | null;
            task_status: Task["status"];
            is_repeat: boolean;
            is_current: boolean;
            first_seen_at: Date;
            semantic_mode: SemanticEvaluationSummary["mode"];
            semantic_total: number;
            semantic_matched: number;
            semantic_not_matched: number;
            semantic_unknown: number;
            semantic_model_error: boolean;
            failed_rule_evidence: Array<{
              capabilityId: string;
              canonicalLabel: string;
              status: "negative" | "ambiguous";
              reasonCodes: string[];
            }>;
            source_evidence: string[];
            raw_fields: Record<string, string>;
            updated_at: Date;
          }>
        >`
        WITH visible_tasks AS (
          SELECT id, status
          FROM tasks
          WHERE (${positionScope}::uuid[] IS NULL OR position_id = ANY(${positionScope}::uuid[]))
          ORDER BY created_at DESC, id DESC
          LIMIT ${taskLimit} OFFSET ${taskOffset}
        ), candidate_source AS (
          SELECT cps.id AS state_id, c.id AS candidate_id,
            cps.latest_task_id AS task_id, c.display_name,
            p.id AS position_id, p.name AS position_name,
            cps.salary_screening,
        (SELECT jsonb_build_object('status', a.status, 'result', a.result, 'error', a.error, 'ruleVersionId', a.rule_version_id)
         FROM recruitment_assessments a WHERE a.candidate_position_state_id = cps.id AND cps.resume_screening_status = 'screened') AS assessment,
            cps.rule_decision, cps.rule_confidence,
            cps.review_status, cps.contact_status, cps.version AS state_version,
            cps.resume_screening_status, cps.current_english_level,
            cps.resume_screened_at, cps.resume_screening_error,
            cps.resume_screening_error_code, cps.resume_screening_next_attempt_at,
            visible_task.status AS task_status,
            cps.is_repeat, cps.is_current, c.created_at AS first_seen_at,
            semantic.mode AS semantic_mode,
            semantic.total AS semantic_total,
            semantic.matched AS semantic_matched,
            semantic.not_matched AS semantic_not_matched,
            semantic.unknown_count AS semantic_unknown,
            semantic.model_error AS semantic_model_error,
            failed_rules.evidence AS failed_rule_evidence,
            cs.source_evidence, cs.raw_fields, cps.updated_at
          FROM candidate_position_states cps
          JOIN visible_tasks visible_task ON visible_task.id = cps.latest_task_id
          JOIN candidates c ON c.id = cps.candidate_id
          JOIN positions p ON p.id = cps.position_id
          JOIN candidate_snapshots cs ON cs.id = cps.latest_snapshot_id
          LEFT JOIN LATERAL (
            SELECT
              CASE
                WHEN BOOL_OR(se.runtime_mode = 'active') THEN 'active'
                WHEN BOOL_OR(se.runtime_mode = 'shadow') THEN 'shadow'
                WHEN COUNT(*) > 0 THEN 'off'
                ELSE NULL
              END AS mode,
              COUNT(*)::int AS total,
              (COUNT(*) FILTER (WHERE se.result = 'matched'))::int AS matched,
              (COUNT(*) FILTER (WHERE se.result = 'not_matched'))::int AS not_matched,
              (COUNT(*) FILTER (WHERE se.result = 'unknown'))::int AS unknown_count,
              COALESCE(
                BOOL_OR(se.reason_codes ?| ARRAY[
                  'semantic_model_error',
                  'semantic_model_unavailable',
                  'semantic_model_missing_result'
                ]),
                false
              ) AS model_error
            FROM semantic_evaluations se
            WHERE se.candidate_position_state_id = cps.id
          ) semantic ON TRUE
          LEFT JOIN LATERAL (
            SELECT COALESCE(
              JSONB_AGG(
                JSONB_BUILD_OBJECT(
                  'capabilityId', evidence.capability_id,
                  'canonicalLabel', evidence.canonical_label,
                  'status', evidence.evidence_status,
                  'reasonCodes', evidence.reason_codes
                )
                ORDER BY evidence.canonical_label
              ),
              '[]'::jsonb
            ) AS evidence
            FROM (
              SELECT DISTINCT me.capability_id, me.canonical_label, me.evidence_status, me.reason_codes
              FROM match_evidence me
              WHERE me.candidate_position_state_id = cps.id
                AND me.evidence_status IN ('negative', 'ambiguous')
            ) evidence
          ) failed_rules ON TRUE
          WHERE (${positionScope}::uuid[] IS NULL OR cps.position_id = ANY(${positionScope}::uuid[]))
        ), ranked_candidates AS (
          SELECT candidate_source.*,
            ROW_NUMBER() OVER (
              PARTITION BY task_id, candidate_id
              ORDER BY
                CASE review_status WHEN 'approved' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
                CASE resume_screening_status WHEN 'screened' THEN 0 ELSE 1 END,
                updated_at DESC
            ) AS identity_rank
          FROM candidate_source
        )
        SELECT state_id, candidate_id, task_id, position_id, display_name, position_name, salary_screening, assessment,
          rule_decision, rule_confidence, review_status, contact_status,
          state_version, resume_screening_status, current_english_level,
          resume_screened_at, resume_screening_error,
          resume_screening_error_code, resume_screening_next_attempt_at,
          task_status,
          is_repeat, is_current, first_seen_at, semantic_mode,
          semantic_total, semantic_matched, semantic_not_matched,
          semantic_unknown, semantic_model_error, failed_rule_evidence,
          source_evidence, raw_fields,
          updated_at
        FROM ranked_candidates
        WHERE identity_rank = 1
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
          SELECT cps.candidate_id, cps.rule_decision,
            cps.resume_screening_status, cps.review_status
          FROM candidate_position_states cps
          WHERE cps.is_current
            AND (${positionScope}::uuid[] IS NULL OR cps.position_id = ANY(${positionScope}::uuid[]))
        ), candidate_metrics AS (
          SELECT candidate_id,
            BOOL_OR(
              rule_decision = 'matched' AND resume_screening_status = 'screened'
            ) AS has_match,
            BOOL_OR(
              review_status = 'pending'
                AND resume_screening_status IN ('screened', 'no_text', 'failed')
            ) AS has_pending_review
          FROM candidate_source
          GROUP BY candidate_id
        )
        SELECT
          COUNT(*)::int AS total_candidates,
          COUNT(*) FILTER (WHERE has_match)::int AS matched_candidates,
          COUNT(*) FILTER (WHERE has_pending_review)::int AS pending_review,
          (
            SELECT COUNT(DISTINCT attempt.contact_intent_id)::int
            FROM contact_attempts attempt
            JOIN contact_intents intent ON intent.id = attempt.contact_intent_id
            JOIN candidate_position_states contacted_state
              ON contacted_state.id = intent.candidate_position_state_id
            WHERE attempt.result = 'sent'
              AND intent.transport_mode = 'real'
              AND attempt.finished_at >= (
                date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai')
                AT TIME ZONE 'Asia/Shanghai'
              )
              AND (
                ${positionScope}::uuid[] IS NULL
                OR contacted_state.position_id = ANY(${positionScope}::uuid[])
              )
          ) AS contacted_today
        FROM candidate_metrics
      `,
      ]);
    const metrics = metricRows[0]!;
    return {
      metrics: {
        totalCandidates: metrics.total_candidates,
        matchedCandidates: metrics.matched_candidates,
        pendingReview: metrics.pending_review,
        contactedToday: metrics.contacted_today,
      },
      positions: positionScope === null
        ? positions
        : positions.filter((position) => positionScope.includes(position.id)),
      activeRules: activeRuleRows
        .filter((row) => positionScope === null || positionScope.includes(row.position_id))
        .map((row) => ({
        positionId: row.position_id,
        id: row.id,
        version: row.version,
        config: row.config,
        dictionaryVersion: row.dictionary_version,
        createdAt: iso(row.created_at),
      })),
      latestRules: latestRuleRows
        .filter((row) => positionScope === null || positionScope.includes(row.position_id))
        .map((row) => ({
        positionId: row.position_id,
        id: row.id,
        version: row.version,
        status: row.lifecycle_status,
        active: row.active,
        config: row.config,
        dictionaryVersion: row.dictionary_version,
        createdAt: iso(row.created_at),
      })),
      tasks: taskRows.map(mapTask),
      candidates: candidateRows.map((row) => ({
        stateId: row.state_id,
        candidateId: row.candidate_id,
        taskId: row.task_id,
        positionId: row.position_id,
        name: row.display_name,
        positionName: row.position_name,
        ruleDecision: row.rule_decision,
      salaryScreening: row.salary_screening ?? null,
      assessment: row.assessment ?? null,
        ruleConfidence: row.rule_confidence,
        reviewStatus: row.review_status,
        contactStatus: row.contact_status,
        stateVersion: row.state_version,
        resumeScreeningStatus: row.resume_screening_status,
        currentEnglishLevel: row.current_english_level,
        resumeScreenedAt: row.resume_screened_at ? iso(row.resume_screened_at) : null,
        resumeScreeningError: row.resume_screening_error,
        resumeScreeningErrorCode: row.resume_screening_error_code,
        resumeScreeningNextAttemptAt: row.resume_screening_next_attempt_at
          ? iso(row.resume_screening_next_attempt_at)
          : null,
        isRepeat: row.is_repeat,
        isCurrent: row.is_current,
        firstSeenAt: iso(row.first_seen_at),
        nextAction: candidateNextAction({
          taskStatus: row.task_status,
          resumeStatus: row.resume_screening_status,
          errorCode: row.resume_screening_error_code,
          reviewStatus: row.review_status,
          contactStatus: row.contact_status,
          nextAttemptAt: row.resume_screening_next_attempt_at,
        }),
        failedRuleLabels: summarizeFailedRuleLabels(row.failed_rule_evidence),
        missingRuleLabels: summarizeMissingRuleLabels(row.failed_rule_evidence),
        semanticSummary: {
          mode: row.semantic_mode,
          total: row.semantic_total,
          matched: row.semantic_matched,
          notMatched: row.semantic_not_matched,
          unknown: row.semantic_unknown,
          modelError: row.semantic_model_error,
        },
        evidence: row.source_evidence,
        fields: row.raw_fields,
        updatedAt: iso(row.updated_at),
      })),
    };
  }
}
