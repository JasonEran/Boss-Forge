/** Counts people admitted to a task, including failures and non-matches. */
export const DEFAULT_SCREENING_LIMIT = 20;
export const MAX_SCREENING_LIMIT = 200;

export class ScreeningLimitError extends Error {}

export function screeningCandidateLimit(value: unknown = DEFAULT_SCREENING_LIMIT): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_SCREENING_LIMIT) {
    throw new ScreeningLimitError(`筛选人数须为 1–${MAX_SCREENING_LIMIT} 的整数。`);
  }
  return value;
}
