import type { Page } from "puppeteer-core";
import type { ParsedCandidate } from "@boss-forge/contracts";
import { getBossCliInstallation, parseBossOutput } from "@boss-forge/boss-cli-adapter";
import type { BoundBossJob } from "./boss-jobs.js";
import { selectRecommendationJob } from "./boss-jobs-browser.js";
import { applyBossRecommendationFilters } from "./boss-filters-browser.js";
import { findContactCandidateInBatches } from "./contact-candidate.js";
import { loadNextRecommendationPage } from "./boss-recommendation-collection.js";
import { readMatchingRecommendationCards, readRecommendationState, type RecommendationState } from "./boss-recommendation-readiness.js";
import { locateViewedContactCandidate } from "./contact-viewed-browser.js";

/** Read-only locating under the worker's account lock; leaves the exact card loaded for greet. */
export async function locateContactCandidate(page: Page, job: BoundBossJob, expected: ParsedCandidate): Promise<ParsedCandidate> {
  try { return await locateViewedContactCandidate(page, expected); }
  catch (error) {
    if (!(error instanceof Error) || !/BOSS_CONTACT_TARGET_UNAVAILABLE|BOSS_CONTACT_LOCATE_INCOMPLETE|BOSS_VIEWED_LIST_UNAVAILABLE/u.test(error.message)) throw error;
  }
  const { version } = await getBossCliInstallation();
  const { reader, frame } = await selectRecommendationJob(page, job);
  if (job.filters) await applyBossRecommendationFilters(page, frame, job.filters, job.id);
  let state: RecommendationState;
  return findContactCandidateInBatches(expected, {
    read: async () => {
      state = await readRecommendationState(frame);
      if (state.jobId !== job.id) throw new Error("BOSS_CONTACT_JOB_MISMATCH：定位期间 BOSS 岗位发生变化，本次未发送。");
      const cards = await readMatchingRecommendationCards(frame, () => reader.readRecommendList(frame));
      const parsed = parseBossOutput(version, { type: "recommend" }, reader.renderRecommendList(cards));
      if (parsed.kind !== "candidates") throw new Error("BOSS_CONTACT_LIST_UNREADABLE：未取得可核对的推荐列表，本次未发送。");
      return { candidates: parsed.candidates, ended: state.matchingEnded };
    },
    advance: async () => {
      await loadNextRecommendationPage(page, frame, job.id, state);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  });
}
