import { constants, accessSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export function runtimeDirectory(): string {
  const configured = process.env.BOSS_FORGE_RUNTIME_DIR?.trim();
  return resolve(configured || resolve(process.cwd(), ".boss-forge", "runtime"));
}

export async function ensureRuntimeDirectory(): Promise<string> {
  const directory = runtimeDirectory();
  await mkdir(directory, { recursive: true });
  return directory;
}

function explicitlyEnabled(value: string | undefined): boolean {
  return ["1", "true"].includes((value ?? "0").trim().toLowerCase());
}

export function resumePreviewEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return explicitlyEnabled(environment.BOSS_FORGE_RESUME_PREVIEW_ENABLED);
}

export function effectiveOcrEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return explicitlyEnabled(environment.BOSS_RESUME_OCR);
}

export type ResumeOcrProvider = "boss" | "tencent";

export function resumeOcrProvider(): ResumeOcrProvider {
  return process.env.BOSS_FORGE_OCR_PROVIDER?.trim().toLowerCase() === "tencent"
    ? "tencent"
    : "boss";
}

const CHROME_EXECUTABLE_NAMES = new Set([
  "Google Chrome for Testing",
  "Google Chrome",
  "Chromium",
  "chrome",
  "chrome.exe"
]);

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findChromeRecursively(directory: string, depth: number): string | null {
  if (depth < 0) return null;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && CHROME_EXECUTABLE_NAMES.has(entry.name) && isExecutable(path)) {
      return path;
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findChromeRecursively(join(directory, entry.name), depth - 1);
    if (found) return found;
  }
  return null;
}

export function resolveChromePath(): string | null {
  const explicit =
    process.env.CHROME_PATH?.trim() || process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
  if (explicit) return isExecutable(explicit) ? resolve(explicit) : null;
  const browserRoot = resolve(
    process.env.BOSS_FORGE_BROWSER_ROOT?.trim() ||
      resolve(process.cwd(), ".boss-forge", "browsers")
  );
  return findChromeRecursively(browserRoot, 7);
}

export function workerBossEnvironment(): Readonly<Record<string, string>> {
  const chromePath = resolveChromePath();
  return {
    ...(resumeOcrProvider() === "tencent" ? { BOSS_RESUME_CAPTURE_HOOK: new URL("./resume-canvas-expansion.mjs", import.meta.url).href } : {}),
    // Tencent OCR runs after boss-cli returns the resume screenshot. Keeping
    // boss-cli OCR enabled here makes it attempt its built-in Baidu provider
    // first and abort before the Tencent fallback can run.
    BOSS_RESUME_OCR:
      resumeOcrProvider() === "tencent"
        ? "0"
        : process.env.BOSS_RESUME_OCR?.trim() || "0",
    ...(chromePath ? { CHROME_PATH: chromePath } : {})
  };
}
