import type { ChildProcess } from "node:child_process";

export type SessionChildExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
};

export type M1CanaryCompletion = {
  mode: "normal" | "collection-only" | "resume-only";
  recordedResumeAttempts: number;
  maxResumeAttempts: number | null;
};

type Environment = Readonly<Record<string, string | undefined>>;

function strictResumeAttemptLimit(value: string | undefined): number | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  return /^(?:[1-9]|1\d|20)$/u.test(normalized)
    ? Number(normalized)
    : null;
}

export function parseM1CanaryCompletionLine(
  line: string
): M1CanaryCompletion | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const event = parsed as Record<string, unknown>;
  if (event.ok !== true || event.event !== "m1.canary.completed") return null;
  if (
    event.mode !== "normal" &&
    event.mode !== "collection-only" &&
    event.mode !== "resume-only"
  ) {
    return null;
  }
  if (
    !Number.isInteger(event.recordedResumeAttempts) ||
    Number(event.recordedResumeAttempts) < 0
  ) {
    return null;
  }
  if (
    event.maxResumeAttempts !== null &&
    (!Number.isInteger(event.maxResumeAttempts) ||
      Number(event.maxResumeAttempts) < 1 ||
      Number(event.maxResumeAttempts) > 20)
  ) {
    return null;
  }
  return {
    mode: event.mode,
    recordedResumeAttempts: Number(event.recordedResumeAttempts),
    maxResumeAttempts:
      event.maxResumeAttempts === null ? null : Number(event.maxResumeAttempts)
  };
}

export function isConfiguredM1CanaryCompletion(
  completion: M1CanaryCompletion | null,
  environment: Environment
): boolean {
  if (completion === null) return false;
  const configuredMode = environment.BOSS_FORGE_M1_MODE?.trim() || "normal";
  if (
    configuredMode !== "normal" &&
    configuredMode !== "collection-only" &&
    configuredMode !== "resume-only"
  ) {
    return false;
  }
  if (completion.mode !== configuredMode) return false;

  const configuredLimitValue =
    environment.BOSS_FORGE_CANARY_MAX_RESUME_ATTEMPTS?.trim();
  const configuredLimit = strictResumeAttemptLimit(configuredLimitValue);
  if (configuredLimitValue) {
    return (
      configuredLimit !== null &&
      configuredMode !== "collection-only" &&
      completion.maxResumeAttempts === configuredLimit &&
      completion.recordedResumeAttempts === configuredLimit
    );
  }
  return (
    configuredMode === "collection-only" &&
    completion.maxResumeAttempts === null &&
    completion.recordedResumeAttempts === 0
  );
}

/** A successful child exit is expected only when its completion event exactly
 * matches an explicitly finite M1 canary inherited by the supervisor. */
export function isExpectedM1CanaryExit(
  result: SessionChildExit,
  completion: M1CanaryCompletion | null,
  environment: Environment
): boolean {
  return (
    result.code === 0 &&
    result.signal === null &&
    result.error === null &&
    isConfiguredM1CanaryCompletion(completion, environment)
  );
}

/** Resolve every child termination path so the supervisor can always publish
 * a fail-closed status and stop the sibling worker. */
export async function waitForSessionChildExit(
  child: ChildProcess,
  onSettled: () => void = () => undefined
): Promise<SessionChildExit> {
  return new Promise<SessionChildExit>((resolve) => {
    let settled = false;
    const finish = (result: SessionChildExit): void => {
      if (settled) return;
      settled = true;
      onSettled();
      resolve(result);
    };
    child.once("error", (error) => {
      finish({
        code: null,
        signal: null,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    // `close` follows stdout/stderr closure, so the supervisor has observed a
    // final completion event before it classifies a zero exit as expected.
    child.once("close", (code, signal) => {
      finish({ code, signal, error: null });
    });
  });
}

export function sessionChildExitMessage(result: SessionChildExit): string {
  if (result.error) return `Worker 启动失败（${result.error}），请查看服务日志后重新启动。`;
  if (result.signal) {
    return `Worker 被信号 ${result.signal} 终止，请检查内存和服务日志后重新启动。`;
  }
  return `Worker 异常停止（退出码 ${result.code ?? 1}），请查看服务日志后重新启动。`;
}
