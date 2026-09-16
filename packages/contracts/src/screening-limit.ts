/** Counts people admitted to a task, including failures and non-matches. */
export const DEFAULT_SCREENING_LIMIT = 20;
export const MAX_SCREENING_LIMIT = 200;
/** Timed and immediate filters process at most this many people per chunk. */
export const SCREENING_CHUNK_SIZE = 20;

export class ScreeningLimitError extends Error {}

export function screeningCandidateLimit(value: unknown = DEFAULT_SCREENING_LIMIT): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_SCREENING_LIMIT) {
    throw new ScreeningLimitError(`筛选人数须为 1–${MAX_SCREENING_LIMIT} 的整数。`);
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
