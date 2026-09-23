import { randomUUID } from "node:crypto";
import {
  screeningBudgetMet,
  screeningBudgetWait,
} from "@boss-forge/contracts";
import type { Database } from "./client.js";
import type { Task } from "./types.js";

const TASK_ALIAS = /^[a-z_][a-z0-9_]*$/;
const WAIT_REASON_COLUMN = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

/** Wait codes that mean "this task will not collect or screen further." */
export const SCREENING_TERMINAL_WAIT_CODES = [
  "screening_pool_exhausted",
  "greet_target_met",
  "screening_pass_target_met",
] as const;

/** Budget met. Pool exhaustion is separate: already-queued resumes may still finish. */
export const SCREENING_BUDGET_MET_WAIT_CODES = [
  "greet_target_met",
  "screening_pass_target_met",
] as const;

export function screeningTerminalWaitExcludedSql(waitReasonCodeColumn: string): string {
  if (!WAIT_REASON_COLUMN.test(waitReasonCodeColumn)) {
    throw new Error("Invalid wait reason column.");
  }
  const list = SCREENING_TERMINAL_WAIT_CODES.map((code) => `'${code}'`).join(", ");
  return `COALESCE(${waitReasonCodeColumn}, '') NOT IN (${list})`;
}

export function screeningBudgetMetWaitExcludedSql(waitReasonCodeColumn: string): string {
  if (!WAIT_REASON_COLUMN.test(waitReasonCodeColumn)) {
    throw new Error("Invalid wait reason column.");
  }
  const list = SCREENING_BUDGET_MET_WAIT_CODES.map((code) => `'${code}'`).join(", ");
  return `COALESCE(${waitReasonCodeColumn}, '') NOT IN (${list})`;
}

/**
 * True while the task still owes work against `candidate_limit`.
 * Auto-greet compares successful greets. Screening-only compares passes
 * (`matched` + resume `screened`). Failed and not_matched rows are omitted.
 */
export function screeningBudgetStillOpenSql(taskAlias: string): string {
  if (!TASK_ALIAS.test(taskAlias)) throw new Error("Invalid task alias.");
  return `(
    CASE
      WHEN ${taskAlias}.auto_greet THEN (
        SELECT count(*)::int FROM contact_intents sent_budget
        WHERE sent_budget.task_id = ${taskAlias}.id
          AND sent_budget.action_kind = 'greet'
          AND sent_budget.status = 'sent'
      ) < ${taskAlias}.candidate_limit
      ELSE (
        SELECT count(*)::int FROM candidate_position_states pass_budget
        WHERE pass_budget.latest_task_id = ${taskAlias}.id
          AND pass_budget.rule_decision = 'matched'
          AND pass_budget.resume_screening_status = 'screened'
      ) < ${taskAlias}.candidate_limit
    END
  )`;
}

/**
 * Park a task once its budget is met. Queued and in-flight resume claims are
 * released so an already-overshot task does not open another resume, including
 * after a worker restart. Returns true when the budget is met (including when
 * it was already sealed).
 */
export async function applyScreeningBudgetSeal(
  transaction: Database,
  taskId: string,
): Promise<boolean> {
  const tasks = await transaction<
    Array<{
      status: Task["status"];
      candidate_limit: number;
      auto_greet: boolean;
      wait_reason_code: string | null;
    }>
  >`
    SELECT status, candidate_limit, auto_greet, wait_reason_code
    FROM tasks WHERE id = ${taskId} FOR UPDATE
  `;
  const task = tasks[0];
  if (!task) return false;
  if (task.wait_reason_code === "screening_pool_exhausted") return false;
  if (
    task.wait_reason_code === "greet_target_met" ||
    task.wait_reason_code === "screening_pass_target_met"
  ) {
    return true;
  }
  if (!["queued", "running", "screening", "waiting_review", "completed"].includes(task.status)) {
    return false;
  }
  const counts = await transaction<Array<{ sent: number; passes: number }>>`
    SELECT
      (
        SELECT count(*)::int FROM contact_intents
        WHERE task_id = ${taskId}
          AND action_kind = 'greet'
          AND status = 'sent'
      ) AS sent,
      (
        SELECT count(*)::int FROM candidate_position_states
        WHERE latest_task_id = ${taskId}
          AND rule_decision = 'matched'
          AND resume_screening_status = 'screened'
      ) AS passes
  `;
  const successfulGreets = Number(counts[0]?.sent ?? 0);
  const screeningPasses = Number(counts[0]?.passes ?? 0);
  if (
    !screeningBudgetMet({
      autoGreet: task.auto_greet,
      candidateLimit: task.candidate_limit,
      successfulGreets,
      screeningPasses,
    })
  ) {
    return false;
  }
  const wait = screeningBudgetWait(task.auto_greet);
  // Release every resume that has not finished. A processing row left by a
  // restarted worker would otherwise keep status=screening and block the account.
  await transaction`
    UPDATE candidate_position_states
    SET resume_screening_status = 'not_requested',
      resume_screening_claimed_by = NULL,
      resume_screening_claimed_at = NULL,
      updated_at = now()
    WHERE latest_task_id = ${taskId}
      AND resume_screening_status IN ('queued', 'processing')
  `;
  const nextStatus = task.status === "completed" ? "completed" : "waiting_review";
  await transaction`
    UPDATE tasks
    SET status = ${nextStatus},
      finished_at = COALESCE(finished_at, now()),
      claimed_by = NULL,
      claim_token = NULL,
      claimed_at = NULL,
      wait_reason_code = ${wait.code},
      wait_reason = ${wait.message},
      next_run_at = NULL,
      last_progress_at = now(),
      version = version + 1
    WHERE id = ${taskId}
      AND status IN ('queued', 'running', 'screening', 'waiting_review', 'completed')
  `;
  await transaction`
    INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
    VALUES (
      ${randomUUID()}, 'system:screening-budget', 'task.screening_budget.met',
      'task', ${taskId},
      ${transaction.json({
        autoGreet: task.auto_greet,
        candidateLimit: task.candidate_limit,
        successfulGreets,
        screeningPasses,
        reasonCode: wait.code,
        status: nextStatus,
      })}
    )
  `;
  return true;
}
