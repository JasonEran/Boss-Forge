/** Account-day auto-greet cap (Asia/Shanghai). Independent of resume-view quotas. */
export const DEFAULT_AUTO_GREET_DAILY_LIMIT = 200;

/** Stable Chinese marker used by UI to show 已停用 for cap-stopped tasks. */
export const DAILY_AUTO_GREET_CAP_STOP_MARKER = "每日打招呼上限";

export function autoGreetDailyLimitFromEnvironment(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): number {
  const raw = env.BOSS_FORGE_AUTO_GREET_DAILY_LIMIT?.trim();
  if (!raw) return DEFAULT_AUTO_GREET_DAILY_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100_000) {
    throw new Error("BOSS_FORGE_AUTO_GREET_DAILY_LIMIT must be an integer from 1 to 100000.");
  }
  return value;
}

export function dailyAutoGreetCapStopMessage(limit: number): string {
  return `已达${DAILY_AUTO_GREET_CAP_STOP_MARKER}（${limit}），任务已自动停止`;
}

export function isDailyAutoGreetCapStopMessage(message: string | null | undefined): boolean {
  return Boolean(message && message.includes(DAILY_AUTO_GREET_CAP_STOP_MARKER));
}

/** How many more real greets may be enqueued before the account-day cap. */
export function remainingAutoGreetDailySlots(used: number, limit: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(limit)) return 0;
  return Math.max(0, Math.floor(limit) - Math.floor(used));
}
