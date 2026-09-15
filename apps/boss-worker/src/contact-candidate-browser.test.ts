import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "puppeteer-core";
import type { ParsedCandidate } from "@boss-forge/contracts";
import { locateContactCandidate } from "./contact-candidate-browser.js";
import { selectRecommendationJob } from "./boss-jobs-browser.js";
import { applyBossRecommendationFilters } from "./boss-filters-browser.js";
import { readMatchingRecommendationCards, readRecommendationState } from "./boss-recommendation-readiness.js";
import { loadNextRecommendationPage } from "./boss-recommendation-collection.js";
import { locateViewedContactCandidate } from "./contact-viewed-browser.js";

vi.mock("./boss-jobs-browser.js", () => ({ selectRecommendationJob: vi.fn() }));
vi.mock("./boss-filters-browser.js", () => ({ applyBossRecommendationFilters: vi.fn() }));
vi.mock("./boss-recommendation-readiness.js", () => ({ readRecommendationState: vi.fn(), readMatchingRecommendationCards: vi.fn() }));
vi.mock("./boss-recommendation-collection.js", () => ({ loadNextRecommendationPage: vi.fn() }));
vi.mock("./contact-viewed-browser.js", () => ({ locateViewedContactCandidate: vi.fn() }));
vi.mock("@boss-forge/boss-cli-adapter", async importOriginal => ({
  ...await importOriginal<object>(), getBossCliInstallation: async () => ({ version: "0.6.6" })
}));

describe("contact browser context", () => {
  const page = {} as Page;
  const frame = { context: "original job" };
  const job = { id: "original-job-id", name: "亚马逊运营", allowNameFallback: false,
    filters: { version: 1 as const, mode: "custom" as const, fields: { major: ["英语"] } } };
  const target: ParsedCandidate = { index: 106, name: "田歌", source: "recommend",
    sourceLocator: { kind: "boss_geek_id", value: "original-geek-id" }, fields: {}, evidence: [], raw: "" };
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(locateViewedContactCandidate).mockRejectedValue(new Error("BOSS_CONTACT_TARGET_UNAVAILABLE"));
    vi.mocked(selectRecommendationJob).mockResolvedValue({ frame, reader: {
      readRecommendList: vi.fn(), renderRecommendList: () => "- 106. 田歌｜BOSS候选人ID:original-geek-id｜信息:本科｜可打招呼"
    } } as never);
    vi.mocked(readRecommendationState).mockResolvedValue({ jobId: job.id, matchingEnded: true } as never);
    vi.mocked(readMatchingRecommendationCards).mockResolvedValue([]);
  });

  it("uses viewing history without refreshing recommendations when the original ID is retained there", async () => {
    vi.mocked(locateViewedContactCandidate).mockResolvedValue(target);
    expect(await locateContactCandidate(page, job, target)).toEqual(target);
    expect(selectRecommendationJob).not.toHaveBeenCalled();
    expect(loadNextRecommendationPage).not.toHaveBeenCalled();
  });

  it("restores the original job and filter plan before reading the exact target", async () => {
    const result = await locateContactCandidate(page, job, target);
    expect(result.sourceLocator).toEqual(target.sourceLocator);
    expect(selectRecommendationJob).toHaveBeenCalledWith(page, job);
    expect(applyBossRecommendationFilters).toHaveBeenCalledWith(page, frame, job.filters, job.id);
    expect(vi.mocked(applyBossRecommendationFilters).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(readMatchingRecommendationCards).mock.invocationCallOrder[0]!
    );
    expect(loadNextRecommendationPage).not.toHaveBeenCalled();
  });

  it("rejects a job switch during locating before reading or contacting a card", async () => {
    vi.mocked(readRecommendationState).mockResolvedValue({ jobId: "different-job" } as never);
    await expect(locateContactCandidate(page, job, target)).rejects.toThrow("BOSS_CONTACT_JOB_MISMATCH");
    expect(readMatchingRecommendationCards).not.toHaveBeenCalled();
    expect(loadNextRecommendationPage).not.toHaveBeenCalled();
  });
});
