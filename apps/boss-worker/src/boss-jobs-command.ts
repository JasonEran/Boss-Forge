import { pathToFileURL } from "node:url";
import type { Page } from "puppeteer-core";
import { getBossCliInstallation } from "@boss-forge/boss-cli-adapter";
import { readJobsFromBossPage, readRecommendationForJob, readRecommendationFilterOptions } from "./boss-jobs-browser.js";
import type { BoundBossJob, RecommendationCollectionOptions } from "./boss-jobs.js";
import { createDatabase } from '@boss-forge/data';
import type { ParsedCandidate } from '@boss-forge/contracts';
import { locateContactCandidate } from './contact-candidate-browser.js';

async function main() {
  // Keep dependency diagnostics out of the structured result stream.
  console.log = (...args: unknown[]) => console.error(...args);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    type: "positions" | "recommend" | "filter-options" | "contact-target"; job?: BoundBossJob; collection?: RecommendationCollectionOptions; candidate?: ParsedCandidate;
  };
  const { packageRoot } = await getBossCliInstallation();
  const session = await import(pathToFileURL(`${packageRoot}/dist/common/boss_session_page.js`).href) as {
    withBossSessionPage<T>(callback: (page: Page) => Promise<T>): Promise<T>;
  };
  const task = input.collection?.task;
  const sql = task ? createDatabase() : null;
  const assertActive = async () => {
    if (!sql || !task) return;
    const rows = await sql`SELECT id FROM tasks WHERE id = ${task.id} AND status = 'running' AND claim_token = ${task.claimToken}`;
    if (!rows[0]) throw new Error('BOSS_COLLECTION_CANCELLED：采集任务已取消或已被重新领取，本次停止加载。');
  };
  let output: string;
  try { output = await session.withBossSessionPage(async (page) => {
    if (input.type === "positions") return JSON.stringify(await readJobsFromBossPage(page));
    if (input.type === "contact-target" && input.job?.id && input.job.name && input.candidate?.sourceLocator) {
      return JSON.stringify(await locateContactCandidate(page, input.job, input.candidate));
    }
    if (input.type === "filter-options" && input.job?.id && input.job.name) return JSON.stringify(await readRecommendationFilterOptions(page, input.job));
    if (input.type === "recommend" && input.job?.id && input.job.name) return readRecommendationForJob(page, input.job,
      input.collection ? {
        candidateLimit: input.collection.candidateLimit,
        ...(input.collection.excludeGeekIds?.length
          ? { excludeGeekIds: input.collection.excludeGeekIds }
          : {}),
        assertActive
      } : undefined);
    throw new Error("无效的 BOSS 岗位读取请求。");
  }); } finally { await sql?.end(); }
  process.stdout.write(output, () => process.exit(0));
}
main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.message : String(error), () => process.exit(1));
});
