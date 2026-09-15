import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { buildBossArgv, type BossCommand } from "./command.js";
import { getBossCliInstallation } from "./installation.js";

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

const PASSTHROUGH_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "CHROME_PATH",
  "PUPPETEER_EXECUTABLE_PATH",
  "BOSS_RESUME_OCR",
  "BOSS_RESUME_CAPTURE_HOOK",
  "TENCENTCLOUD_SECRET_ID",
  "TENCENTCLOUD_SECRET_KEY",
  "TENCENTCLOUD_OCR_REGION",
  "BOSS_BAIDU_API_KEY",
  "BOSS_BAIDU_SECRET_KEY",
  "BOSS_BROWSER_HEADLESS",
  "BOSS_BROWSER_HEADLESS_LOGIN",
  "BOSS_BROWSER_QR_RELAY",
  "BOSS_BROWSER_USER_DATA_DIR",
  "BOSS_BROWSER_PROFILE_DIRECTORY",
  "BOSS_BROWSER_REMOTE_DEBUGGING_PORT",
  "BOSS_BROWSER_REMOTE_ONLY",
  "BOSS_BROWSER_VIEWPORT_WIDTH",
  "BOSS_BROWSER_VIEWPORT_HEIGHT",
  "BOSS_BROWSER_DISABLE_GPU",
  "BOSS_BROWSER_NO_SANDBOX",
  "BOSS_CLI_AGENT_BRAND",
  "BOSS_AGENT_SKILLS_DIR"
] as const;

export type BossCliRunResult = {
  command: BossCommand;
  argv: string[];
  version: string;
  entrypoint: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  stdout: string;
  stderr: string;
};

export type BossCliRunOptions = {
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  env?: Readonly<Record<string, string | undefined>>;
};

export class BossCliExecutionError extends Error {
  readonly result: BossCliRunResult;

  constructor(message: string, result: BossCliRunResult) {
    super(message);
    this.name = "BossCliExecutionError";
    this.result = result;
  }
}
function buildChildEnv(overrides: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = overrides[key] ?? process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export async function runBossCommand(
  command: BossCommand,
  options: BossCliRunOptions = {}
): Promise<BossCliRunResult> {
  const installation = await getBossCliInstallation();
  const argv = buildBossArgv(command);
  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("timeoutMs must be a positive integer.");
  }
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024) {
    throw new Error("maxOutputBytes must be an integer of at least 1024.");
  }

  return await new Promise<BossCliRunResult>((resolve, reject) => {
    const child = spawn(process.execPath, [installation.entrypoint, ...argv], {
      cwd: options.cwd ?? process.cwd(),
      env: buildChildEnv(options.env ?? {}),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let aborted = false;
    let outputExceeded = false;
    let settled = false;

    const terminate = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      const forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 2_000);
      forceTimer.unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timer.unref();

    const onAbort = (): void => {
      aborted = true;
      terminate();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const append = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        outputExceeded = true;
        terminate();
        return;
      }
      target.push(chunk);
    };

    child.stdout.on("data", (chunk: Buffer) => append(stdoutChunks, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderrChunks, chunk));

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });

    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const result: BossCliRunResult = {
        command,
        argv,
        version: installation.version,
        entrypoint: installation.entrypoint,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - started),
        exitCode,
        signal,
        timedOut,
        aborted,
        stdout: Buffer.concat(stdoutChunks).toString("utf8").trim(),
        stderr: Buffer.concat(stderrChunks).toString("utf8").trim()
      };

      if (outputExceeded) {
        reject(new BossCliExecutionError("boss-cli output exceeded the configured limit.", result));
        return;
      }
      if (timedOut) {
        reject(new BossCliExecutionError(`boss-cli timed out after ${timeoutMs}ms.`, result));
        return;
      }
      if (aborted) {
        reject(new BossCliExecutionError("boss-cli execution was aborted.", result));
        return;
      }
      if (exitCode !== 0) {
        reject(new BossCliExecutionError(`boss-cli exited with code ${String(exitCode)}.`, result));
        return;
      }
      resolve(result);
    });
  });
}
