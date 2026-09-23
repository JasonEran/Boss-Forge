/**
 * `candidate_limit` is the task budget. Collection still runs in chunks of
 * {@link SCREENING_CHUNK_SIZE} until that budget is met or the pool is exhausted.
 *
 * - auto-greet on: budget is successful greets (`contact_intents.status = sent`)
 * - auto-greet off: budget is screening passes (resume screened and `matched`)
 *
 * Failed resumes, `not_matched`, and other decisions do not count as passes.
 * The account-day greet cap is separate and only applies when auto-greet is on.
 */
export const DEFAULT_SCREENING_LIMIT = 20;
/**
 * Practical safety ceiling only — product UX is unlimited (no 200 cap).
 * Schedules/tasks may request any integer in 1…MAX.
 */
export const MAX_SCREENING_LIMIT = 100_000;
/** Timed and immediate filters process at most this many people per chunk. */
export const SCREENING_CHUNK_SIZE = 20;

export class ScreeningLimitError extends Error {}

export function screeningCandidateLimit(value: unknown = DEFAULT_SCREENING_LIMIT): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_SCREENING_LIMIT) {
    throw new ScreeningLimitError(`打招呼人数须为正整数（最大 ${MAX_SCREENING_LIMIT}）。`);
  }
  return value;
}

/** Next wave size when a task still needs more people after prior chunks. */
export function screeningChunkLimit(
  candidateLimit: number,
  alreadyCollected = 0
): number {
  const total = screeningCandidateLimit(candidateLimit);
  const remaining = Math.max(0, total - Math.max(0, alreadyCollected));
  return Math.min(SCREENING_CHUNK_SIZE, remaining);
}

/** Split a requested headcount into successive chunk sizes (e.g. 40 → [20, 20]). */
export function screeningChunkSizes(candidateLimit: number): number[] {
  const total = screeningCandidateLimit(candidateLimit);
  const sizes: number[] = [];
  let remaining = total;
  while (remaining > 0) {
    const size = Math.min(SCREENING_CHUNK_SIZE, remaining);
    sizes.push(size);
    remaining -= size;
  }
  return sizes;
}

/** Resume finished and the rule marked the person as a pass (筛通过). */
export function countsAsScreeningPass(input: {
  ruleDecision: string;
  resumeScreeningStatus: string;
}): boolean {
  return input.ruleDecision === "matched" && input.resumeScreeningStatus === "screened";
}

export function screeningPassCount(
  rows: readonly { ruleDecision: string; resumeScreeningStatus: string }[],
): number {
  return rows.filter(countsAsScreeningPass).length;
}

/**
 * Auto-greet tasks stop on successful greets. Screening-only tasks stop on
 * screening passes. The other counter never satisfies the budget.
 */
export function screeningBudgetMet(input: {
  autoGreet: boolean;
  candidateLimit: number;
  successfulGreets: number;
  screeningPasses: number;
}): boolean {
  const progress = input.autoGreet ? input.successfulGreets : input.screeningPasses;
  return progress >= input.candidateLimit;
}

export const GREET_TARGET_MET_WAIT_REASON = "已达到设定的成功打招呼人数。";
export const SCREENING_PASS_TARGET_MET_WAIT_REASON =
  "已达到设定的筛通过人数，已停止继续筛选。";

export function screeningBudgetWait(autoGreet: boolean): {
  code: "greet_target_met" | "screening_pass_target_met";
  message: string;
} {
  return autoGreet
    ? { code: "greet_target_met", message: GREET_TARGET_MET_WAIT_REASON }
    : {
        code: "screening_pass_target_met",
        message: SCREENING_PASS_TARGET_MET_WAIT_REASON,
      };
}
