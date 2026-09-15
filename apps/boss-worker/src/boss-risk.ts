import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureRuntimeDirectory } from "./runtime.js";

export const BOSS_RISK_DISPLAY_MESSAGE =
  "检测到 BOSS 风控或安全验证，Worker 已自动停止。请先在 BOSS 官方页面完成验证并确认账号恢复，再重新启动 Worker。";

const RISK_PATTERNS = [
  /\/web\/common\/security\//iu,
  /\/web\/user\/safe\//iu,
  /\/web\/passport\//iu,
  /blocktip/iu,
  /captcha/iu,
  /安全验证|人机验证|滑块验证|访问异常|行为异常|账号异常|风控/iu,
  /security verification|risk control|account verification/iu
];

function diagnosticText(value: unknown, depth = 0): string[] {
  if (depth > 3 || value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (value instanceof Error) {
    const record = value as unknown as Record<string, unknown>;
    return [
      value.name,
      value.message,
      ...diagnosticText(value.cause, depth + 1),
      ...diagnosticText(record.stdout, depth + 1),
      ...diagnosticText(record.stderr, depth + 1),
      ...diagnosticText(record.result, depth + 1)
    ];
  }
  if (typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  return [
    ...diagnosticText(record.message, depth + 1),
    ...diagnosticText(record.stdout, depth + 1),
    ...diagnosticText(record.stderr, depth + 1),
    ...diagnosticText(record.result, depth + 1),
    ...diagnosticText(record.cause, depth + 1)
  ];
}

export function isBossRiskSignal(value: unknown): boolean {
  const text = diagnosticText(value).join("\n");
  return RISK_PATTERNS.some((pattern) => pattern.test(text));
}

export class BossRiskControlledError extends Error {
  constructor(cause?: unknown) {
    super(BOSS_RISK_DISPLAY_MESSAGE, { cause });
    this.name = "BossRiskControlledError";
  }
}

export async function writeBossRiskStatus(): Promise<void> {
  const runtime = await ensureRuntimeDirectory();
  const statusPath = join(runtime, "boss-login-status.json");
  const temporaryPath = `${statusPath}.${process.pid}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify({
      state: "risk_controlled",
      message: BOSS_RISK_DISPLAY_MESSAGE,
      updatedAt: new Date().toISOString(),
      imageUpdatedAt: null
    }, null, 2)}\n`,
    { mode: 0o600 }
  );
  await rename(temporaryPath, statusPath);
}

export async function bossRiskStatusActive(statusPath: string): Promise<boolean> {
  try {
    const status: unknown = JSON.parse(await readFile(statusPath, "utf8"));
    return Boolean(
      status &&
        typeof status === "object" &&
        !Array.isArray(status) &&
        (status as Record<string, unknown>).state === "risk_controlled"
    );
  } catch {
    return false;
  }
}
