import { BossCliExecutionError } from "@boss-forge/boss-cli-adapter";

const MAX_ERROR_MESSAGE_LENGTH = 2_000;
const SECRET_ENVIRONMENT_KEYS = [
  "TENCENTCLOUD_SECRET_ID",
  "TENCENTCLOUD_SECRET_KEY",
  "BOSS_BAIDU_API_KEY",
  "BOSS_BAIDU_SECRET_KEY",
  "BOSS_FORGE_SEMANTIC_API_KEY"
] as const;

function normalizeDiagnostic(value: string): string {
  return value
    .replace(/\u001b\[[0-9;]*m/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function safeWorkerErrorMessage(
  error: unknown,
  environment: NodeJS.ProcessEnv = process.env
): string {
  const primary = error instanceof Error ? error.message : String(error);
  const diagnostic =
    error instanceof BossCliExecutionError
      ? normalizeDiagnostic(error.result.stderr)
      : "";
  let message = normalizeDiagnostic(
    diagnostic && !primary.includes(diagnostic) ? `${primary} ${diagnostic}` : primary
  );

  for (const key of SECRET_ENVIRONMENT_KEYS) {
    const secret = environment[key]?.trim();
    if (secret) message = message.replaceAll(secret, "[REDACTED]");
  }

  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}
