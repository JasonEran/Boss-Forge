import {
  BossCliExecutionError,
  SUPPORTED_BOSS_CLI_VERSIONS,
  commandRisk,
  getBossCliInstallation,
  parseBossOutput,
  runBossCommand,
  type BossCommand,
  type BossCliRunResult
} from "@boss-forge/boss-cli-adapter";
import { withAccountLock } from "./account-lock.js";
import { writeHeartbeat } from "./heartbeat.js";
import { effectiveOcrEnabled, resolveChromePath, workerBossEnvironment } from "./runtime.js";

type ParsedArgs = {
  positional: string[];
  options: Map<string, string | true>;
};

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const options = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--") continue;
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    if (!key) throw new Error("Invalid empty option.");
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options.set(key, next);
      index += 1;
    } else {
      options.set(key, true);
    }
  }
  return { positional, options };
}

function option(args: ParsedArgs, name: string): string | undefined {
  const value = args.options.get(name);
  if (value === true) throw new Error(`--${name} requires a value.`);
  return value;
}

function flag(args: ParsedArgs, name: string): boolean {
  return args.options.get(name) === true;
}

function requireOption(args: ParsedArgs, name: string): string {
  const value = option(args, name)?.trim();
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function printUsage(): void {
  console.log(`Boss-Forge M0 commands:
  pnpm m0:doctor
  pnpm m0:heartbeat
  pnpm m0 -- login
  pnpm m0 -- live positions
  pnpm m0 -- live recommend --job <岗位>
  pnpm m0 -- live search --keyword <关键词>
  pnpm m0 -- live preview --job <岗位> --candidate <姓名> --approve-preview

Safety:
  preview consumes the platform resume-view quota and requires --approve-preview.
  M0 does not expose any greeting or message-send command.
  OCR defaults to disabled (BOSS_RESUME_OCR=0).`);
}

async function login(): Promise<void> {
  const accountId = process.env.BOSS_FORGE_ACCOUNT_ID?.trim() || "boss-account-01";
  await withAccountLock(accountId, async () => {
    await writeHeartbeat({ state: "busy", activeAccountId: accountId });
    try {
      const result = await runBossCommand(
        { type: "login" },
        { timeoutMs: 20_000, env: workerBossEnvironment() }
      );
      console.log(
        JSON.stringify(
          {
            ok: true,
            accountId,
            message: "Chrome login page opened. Complete login manually in the browser.",
            execution: serializeResult(result)
          },
          null,
          2
        )
      );
    } finally {
      await writeHeartbeat({ state: "ready" });
    }
  });
}

async function doctor(): Promise<void> {
  const installation = await getBossCliInstallation();
  const chromePath = resolveChromePath();
  if (!(SUPPORTED_BOSS_CLI_VERSIONS as readonly string[]).includes(installation.version)) {
    throw new Error(`boss-cli ${installation.version} is not supported by the parser registry.`);
  }
  const help = await runBossCommand(
    { type: "help" },
    { timeoutMs: 10_000, env: workerBossEnvironment() }
  );
  const heartbeat = await writeHeartbeat({ state: "ready" });
  console.log(
    JSON.stringify(
      {
        ok: true,
        nodeVersion: process.version,
        bossCli: installation,
        bossCliHelpAvailable: help.stderr.includes("boss-cli") || help.stdout.includes("boss-cli"),
        chrome: { available: chromePath !== null, path: chromePath },
        ocrEnabled: effectiveOcrEnabled(),
        heartbeatPath: heartbeat.path
      },
      null,
      2
    )
  );
}

async function heartbeat(): Promise<void> {
  const result = await writeHeartbeat({ state: "ready" });
  console.log(JSON.stringify({ path: result.path, heartbeat: result.heartbeat }, null, 2));
}

function liveCommand(args: ParsedArgs): { preflight?: BossCommand; command: BossCommand } {
  const action = args.positional[1];
  switch (action) {
    case "positions":
      return { command: { type: "positions" } };
    case "recommend": {
      const jobKeyword = option(args, "job");
      return { command: jobKeyword ? { type: "recommend", jobKeyword } : { type: "recommend" } };
    }
    case "search": {
      const keyword = option(args, "keyword");
      return { command: keyword ? { type: "search", keyword } : { type: "search" } };
    }
    case "preview": {
      if (!flag(args, "approve-preview")) {
        throw new Error("preview requires the explicit --approve-preview flag because it consumes quota.");
      }
      const jobKeyword = requireOption(args, "job");
      return {
        preflight: { type: "recommend", jobKeyword },
        command: { type: "preview", candidateTarget: requireOption(args, "candidate") }
      };
    }
    case "greet":
      throw new Error(
        "M0 real greeting is permanently disabled; use the audited candidate preview and contact workflow."
      );
    default:
      throw new Error(`Unknown live action: ${action ?? "(missing)"}.`);
  }
}

function serializeResult(result: BossCliRunResult): Record<string, unknown> {
  return {
    argv: result.argv,
    version: result.version,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    stderr: result.stderr
  };
}

async function executeLive(args: ParsedArgs): Promise<void> {
  const accountId = process.env.BOSS_FORGE_ACCOUNT_ID?.trim() || "boss-account-01";
  const recipe = liveCommand(args);
  const risk = commandRisk(recipe.command);

  await withAccountLock(accountId, async () => {
    await writeHeartbeat({ state: "busy", activeAccountId: accountId });
    try {
      let preflight: BossCliRunResult | undefined;
      if (recipe.preflight) {
        preflight = await runBossCommand(recipe.preflight, {
          timeoutMs: 60_000,
          env: workerBossEnvironment()
        });
      }
      const result = await runBossCommand(recipe.command, {
        timeoutMs: recipe.command.type === "preview" ? 90_000 : 60_000,
        env: workerBossEnvironment()
      });
      const parsed = parseBossOutput(result.version, recipe.command, result.stdout);
      console.log(
        JSON.stringify(
          {
            ok: true,
            accountId,
            risk,
            preflight: preflight ? serializeResult(preflight) : null,
            execution: serializeResult(result),
            parsed
          },
          null,
          2
        )
      );
    } finally {
      await writeHeartbeat({ state: "ready" });
    }
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional[0];
  switch (command) {
    case undefined:
    case "help":
      printUsage();
      return;
    case "doctor":
      await doctor();
      return;
    case "heartbeat":
      await heartbeat();
      return;
    case "login":
      await login();
      return;
    case "live":
      await executeLive(args);
      return;
    default:
      throw new Error(`Unknown M0 command: ${command}. Run pnpm m0 -- help.`);
  }
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const details =
    error instanceof BossCliExecutionError
      ? {
          ...serializeResult(error.result),
          stdout: error.result.stdout
        }
      : null;
  await writeHeartbeat({ state: "degraded", lastError: message }).catch(() => undefined);
  console.error(JSON.stringify({ ok: false, error: message, details }, null, 2));
  process.exitCode = 1;
});
