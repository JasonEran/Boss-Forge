const DAILY_HARD_LIMIT = 200;

export type ResumeViewPolicy = {
  timezone: "Asia/Shanghai";
  dwellMinSeconds: number;
  dwellTargetSeconds: number;
  dwellMaxSeconds: number;
  dailyRecommendedLimit: number;
  dailyLimit: number;
  dailyHardLimit: number;
  hourlyLimit: number;
  continuousBatchSize: number;
  breakMinutes: number;
  workdayStartHour: number;
  workdayEndHour: number;
  stopOnRiskControl: true;
  contactQuotaSeparated: true;
  /** When false, filtering ignores daily/hourly/workday/rhythm caps. */
  quotasEnabled: boolean;
};

export type ResumeViewPolicyState =
  | "ready"
  | "outside_working_hours"
  | "daily_hard_limit_reached"
  | "daily_quota_reached"
  | "hourly_quota_reached";

export type ResumeViewUsage = {
  viewsToday: number;
  absoluteViewsToday: number;
  viewsLastHour: number;
};

function integerSetting(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(environment[name]);
  const value = Number.isInteger(parsed) ? parsed : fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function quotasEnabledFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>
): boolean {
  const raw = environment.BOSS_FORGE_RESUME_QUOTAS_ENABLED?.trim().toLowerCase();
  if (!raw) return false;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function resumeViewPolicyFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>
): ResumeViewPolicy {
  const quotasEnabled = quotasEnabledFromEnvironment(environment);
  const dwellMinSeconds = integerSetting(
    environment,
    "BOSS_FORGE_RESUME_DWELL_MIN_SECONDS",
    10,
    5,
    300
  );
  const dwellTargetSeconds = integerSetting(
    environment,
    "BOSS_FORGE_RESUME_DWELL_TARGET_SECONDS",
    10,
    dwellMinSeconds,
    300
  );
  const dwellMaxSeconds = integerSetting(
    environment,
    "BOSS_FORGE_RESUME_DWELL_MAX_SECONDS",
    10,
    dwellTargetSeconds,
    300
  );
  const workdayStartHour = integerSetting(
    environment,
    "BOSS_FORGE_RESUME_WORKDAY_START_HOUR",
    quotasEnabled ? 9 : 0,
    0,
    22
  );
  const workdayEndHour = integerSetting(
    environment,
    "BOSS_FORGE_RESUME_WORKDAY_END_HOUR",
    quotasEnabled ? 18 : 24,
    workdayStartHour + 1,
    24
  );
  return {
    timezone: "Asia/Shanghai",
    dwellMinSeconds,
    dwellTargetSeconds,
    dwellMaxSeconds,
    dailyRecommendedLimit: 120,
    dailyLimit: integerSetting(
      environment,
      "BOSS_FORGE_RESUME_DAILY_LIMIT",
      quotasEnabled ? 120 : DAILY_HARD_LIMIT,
      1,
      DAILY_HARD_LIMIT
    ),
    dailyHardLimit: DAILY_HARD_LIMIT,
    hourlyLimit: integerSetting(
      environment,
      "BOSS_FORGE_RESUME_HOURLY_LIMIT",
      quotasEnabled ? 50 : 50,
      1,
      50
    ),
    continuousBatchSize: integerSetting(
      environment,
      "BOSS_FORGE_RESUME_BATCH_SIZE",
      quotasEnabled ? 20 : 10_000,
      15,
      quotasEnabled ? 25 : 10_000
    ),
    breakMinutes: integerSetting(
      environment,
      "BOSS_FORGE_RESUME_BREAK_MINUTES",
      quotasEnabled ? 10 : 0,
      0,
      60
    ),
    workdayStartHour,
    workdayEndHour,
    stopOnRiskControl: true,
    contactQuotaSeparated: true,
    quotasEnabled
  };
}

export function shanghaiDayStart(now: Date): Date {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
  return new Date(`${date}T00:00:00+08:00`);
}

export function shanghaiHour(now: Date): number {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    hourCycle: "h23"
  }).format(now);
  return Number(hour);
}

export function resumeViewingAllowedAt(now: Date, policy: ResumeViewPolicy): boolean {
  if (!policy.quotasEnabled) return true;
  const hour = shanghaiHour(now);
  return hour >= policy.workdayStartHour && hour < policy.workdayEndHour;
}

/** Canonical state shared by API and Worker so the UI describes real execution. */
export function resumeViewPolicyState(
  now: Date,
  policy: ResumeViewPolicy,
  usage: ResumeViewUsage
): ResumeViewPolicyState {
  if (!policy.quotasEnabled) return "ready";
  if (usage.absoluteViewsToday >= policy.dailyHardLimit) {
    return "daily_hard_limit_reached";
  }
  if (!resumeViewingAllowedAt(now, policy)) return "outside_working_hours";
  if (usage.viewsToday >= policy.dailyLimit) return "daily_quota_reached";
  if (usage.viewsLastHour >= policy.hourlyLimit) return "hourly_quota_reached";
  return "ready";
}

/** Next work-window opening in the fixed Asia/Shanghai (UTC+8) timezone. */
export function nextResumeViewingAt(now: Date, policy: ResumeViewPolicy): Date {
  const shanghaiOffsetMs = 8 * 60 * 60 * 1_000;
  const local = new Date(now.getTime() + shanghaiOffsetMs);
  const hour = local.getUTCHours();
  const dayOffset = hour < policy.workdayStartHour ? 0 : 1;
  return new Date(
    Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate() + dayOffset,
      policy.workdayStartHour - 8,
      0,
      0,
      0
    )
  );
}

export function resumeDwellSeconds(
  policy: ResumeViewPolicy,
  resumeCharacterCount: number
): number {
  if (resumeCharacterCount <= 500) return policy.dwellMinSeconds;
  if (resumeCharacterCount <= 1_500) return policy.dwellTargetSeconds;
  return policy.dwellMaxSeconds;
}
