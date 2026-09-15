/** Loading/recovery time is not viewing time. Slow OCR may consume the dwell. */
export function remainingResumeDwellMs(loadedAt: number | null, now: number, seconds: number): number {
  return loadedAt === null ? 0 : Math.max(0, seconds * 1_000 - Math.max(0, now - loadedAt));
}
