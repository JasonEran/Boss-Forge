/** Loading/recovery time is not viewing time. Slow OCR may consume the dwell. */
export function remainingResumeDwellMs(loadedAt: number | null, now: number, seconds: number): number {
  return loadedAt === null ? 0 : Math.max(0, seconds * 1_000 - Math.max(0, now - loadedAt));
}

/** Call only after the complete capture is saved and no further page reads are needed. */
export async function releaseResumeBrowserAfterDwell(
  loadedAt: number,
  seconds: number,
  wait: (milliseconds: number) => Promise<void>,
  releaseBrowser: () => Promise<void>
): Promise<void> {
  await wait(remainingResumeDwellMs(loadedAt, Date.now(), seconds));
  await releaseBrowser();
}
