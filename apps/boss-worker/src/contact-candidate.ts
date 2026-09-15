import type { ParsedCandidate } from "@boss-forge/contracts";
import type { ContactDispatchJob } from "@boss-forge/data";
import { selectUnambiguousCandidateTarget } from "./candidate-target.js";
import { readBoundBossContactCandidate, type BoundBossJob } from "./boss-jobs.js";

export function contactCandidateJob(job: ContactDispatchJob): BoundBossJob {
  if (!job.bossJobId || !job.bossJobKeyword ||
    (job.actionKind === "greet" && job.providerJobId !== job.bossJobId)) {
    throw new Error("BOSS_CONTACT_JOB_MISMATCH：联系岗位与原采集岗位未能核对一致，请重新预览后再联系。");
  }
  return { id: job.bossJobId, name: job.bossJobKeyword,
    allowNameFallback: job.bossJobNameUnique === true, filters: job.sourceBossFilters ?? null };
}

/** Contact targets require the original provider ID, never a replacement name/fingerprint. */
export async function findContactCandidateInBatches(expected: ParsedCandidate, input: {
  read: () => Promise<{ candidates: ParsedCandidate[]; ended: boolean }>;
  advance: () => Promise<void>;
  maxPages?: number;
  now?: () => number;
  scopeDescription?: string;
}): Promise<ParsedCandidate> {
  if (!expected.sourceLocator) throw new Error("BOSS_STABLE_LOCATOR_MISSING：候选人缺少原始 BOSS 标识，请重新采集。");
  const now = input.now ?? Date.now;
  const deadline = now() + 120_000;
  const seen = new Set<string>();
  for (let page = 0; page < (input.maxPages ?? 40); page++) {
    const { candidates, ended } = await input.read();
    for (const candidate of candidates) if (candidate.sourceLocator) seen.add(candidate.sourceLocator.value);
    try { return selectUnambiguousCandidateTarget(expected, candidates); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("BOSS_SOURCE_EXPIRED")) throw error;
    }
    if (ended) throw new Error(`BOSS_CONTACT_TARGET_UNAVAILABLE：已核对${input.scopeDescription ?? "原岗位和筛选条件"}并检查当前列表 ${seen.size} 人，仍未找到“${expected.name}”的原始 BOSS 标识。可见列表可能已更新，请重新采集后再联系；本次未发送。`);
    if (page + 1 >= (input.maxPages ?? 40) || now() >= deadline) break;
    await input.advance();
  }
  throw new Error(`BOSS_CONTACT_LOCATE_INCOMPLETE：已检查 ${seen.size} 人，本次定位达到时间或分页上限，尚不能确认“${expected.name}”不在列表中。请稍后重新预览并重试；本次未发送。`);
}

export async function refreshContactCandidateTarget(job: ContactDispatchJob): Promise<ParsedCandidate> {
  const candidate = await readBoundBossContactCandidate(contactCandidateJob(job), job.candidateSnapshot);
  // Validate the child process result as well as the live list before the write.
  return selectUnambiguousCandidateTarget(job.candidateSnapshot, [candidate]);
}
