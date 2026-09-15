import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getBossCliInstallation } from "@boss-forge/boss-cli-adapter";
import { bossJobCatalogSchema, bossFilterOptionsSnapshotSchema, type BossJob, type BossRecommendationFilterPlan, type ParsedCandidate } from "@boss-forge/contracts";
import { workerBossEnvironment } from "./runtime.js";

export type BoundBossJob = { id: string; name: string; allowNameFallback: boolean; filters?: BossRecommendationFilterPlan | null };
export type RecommendationCollectionOptions = { candidateLimit: number; task?: { id: string; claimToken: string | null } };
export type JobOption = { id: string; name: string; label: string; disabled: boolean; index: number; current?: boolean };
const normalize = (value: string) => value.replace(/\s+/gu, "").toLocaleLowerCase("zh-CN");

export function selectExactJobOption(options: JobOption[], job: BoundBossJob): JobOption {
  const byId = options.filter((option) => option.id === job.id);
  // Older BOSS dropdowns expose no ID: only a unique, full name is acceptable.
  // Never fall back to a name when the dropdown exposes a different job ID.
  const matches = byId.length ? byId : options.filter((option) =>
    job.allowNameFallback && !option.id && normalize(option.name) === normalize(job.name));
  if (matches.length !== 1) throw new Error(matches.length > 1
    ? "BOSS_JOB_AMBIGUOUS：推荐列表里存在同名岗位，暂时无法唯一识别，请重新同步岗位。"
    : "BOSS_JOB_NOT_FOUND：推荐列表中未找到绑定的 BOSS 岗位，请确认岗位已开放并重新同步。");
  if (matches[0]!.disabled) throw new Error("BOSS_JOB_UNAVAILABLE：该 BOSS 岗位当前不可筛选，请检查岗位状态。");
  return matches[0]!;
}

export type BossJobPage = { jobs: BossJob[]; total: number | null };
export async function collectBossJobCatalog(readPage: () => Promise<BossJobPage>, advance: (page: BossJobPage) => Promise<boolean>) {
  const jobs = new Map<string, BossJob>();
  let expectedTotal: number | null = null;
  for (let batch = 0; batch < 30; batch++) {
    const snapshot = await readPage();
    if (snapshot.jobs.some((job) => !job.id || !job.name)) throw new Error("BOSS 岗位缺少 ID 或名称，原有岗位未更改。");
    if (expectedTotal !== null && snapshot.total !== null && expectedTotal !== snapshot.total) {
      throw new Error("同步期间 BOSS 岗位列表发生变化，请重新同步。");
    }
    expectedTotal ??= snapshot.total;
    for (const job of snapshot.jobs) jobs.set(job.id, job);
    if (expectedTotal !== null && jobs.size === expectedTotal) {
      return bossJobCatalogSchema.parse({ jobs: [...jobs.values()], complete: true });
    }
    if (!(await advance(snapshot))) {
      return bossJobCatalogSchema.parse({ jobs: [...jobs.values()], complete: false });
    }
  }
  throw new Error("岗位列表超过本次读取范围，原有岗位未更改，请稍后重试。");
}

async function runJobBrowserCommand(input: { type: "positions" } | { type: "contact-target"; job: BoundBossJob; candidate: ParsedCandidate } | { type: "recommend" | "filter-options"; job: BoundBossJob; collection?: RecommendationCollectionOptions }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./boss-jobs-command.ts", import.meta.url))], {
      env: { ...process.env, ...workerBossEnvironment(), BOSS_BROWSER_REMOTE_ONLY: "1" },
      stdio: ["pipe", "pipe", "pipe"], shell: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | null = null;
    const timeout = setTimeout(() => { failure = new Error("BOSS 岗位或官方筛选读取超时，请稍后重试。"); child.kill("SIGKILL"); }, input.type === "contact-target" ? 180_000 : input.type === 'recommend' && input.collection ? 300_000 : 90_000);
    const collect = (buffers: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) { failure = new Error("BOSS 岗位响应过大。"); child.kill("SIGKILL"); }
      else buffers.push(chunk);
    };
    child.stdout.on("data", collect(stdout)); child.stderr.on("data", collect(stderr));
    child.stdin.on("error", () => undefined);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(Buffer.concat(stderr).toString("utf8").slice(-2000) || "BOSS 岗位读取失败。"));
      else resolve(Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.end(JSON.stringify(input));
  });
}
export async function readBossJobCatalog() {
  return bossJobCatalogSchema.parse(JSON.parse(await runJobBrowserCommand({ type: "positions" })));
}
export async function readBossFilterOptions(job: BoundBossJob) {
  return bossFilterOptionsSnapshotSchema.parse(JSON.parse(await runJobBrowserCommand({ type: 'filter-options', job })));
}
export async function readBoundBossRecommendation(job: BoundBossJob, collection?: RecommendationCollectionOptions) {
  const installation = await getBossCliInstallation();
  return { version: installation.version, stdout: await runJobBrowserCommand({ type: "recommend", job, ...(collection ? { collection } : {}) }) };
}

export async function readBoundBossContactCandidate(job: BoundBossJob, candidate: ParsedCandidate): Promise<ParsedCandidate> {
  return JSON.parse(await runJobBrowserCommand({ type: "contact-target", job, candidate })) as ParsedCandidate;
}
