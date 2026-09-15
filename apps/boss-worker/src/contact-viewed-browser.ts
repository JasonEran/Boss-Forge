import type { Page, Frame } from "puppeteer-core";
import { pathToFileURL } from "node:url";
import type { ParsedCandidate } from "@boss-forge/contracts";
import { getBossCliInstallation, parseBossOutput } from "@boss-forge/boss-cli-adapter";
import { findContactCandidateInBatches } from "./contact-candidate.js";
import { scrollRecommendationList } from "./resume-list-recovery.js";
import { READ_RECOMMENDATION_STATE, readMatchingRecommendationCards, readRecommendationState, type RecommendationState } from "./boss-recommendation-readiness.js";

function viewedFrame(page: Page): Frame | undefined {
  return page.frames().find(frame => frame.url().includes("/web/frame/recommend/interaction"));
}

export async function viewedHistoryDomReady(frame: Frame, status?: string, jobId?: string): Promise<boolean> {
  return Boolean(await frame.evaluate(`(() => {
            const tab = document.querySelector('.tab-item[title="我看过"]');
            if (!tab || tab.getBoundingClientRect().width === 0) return false;
            if (!${Boolean(status)}) return true;
            const vm = document.querySelector('.card-list, .geek-list-wrap .geek-list')?.__vue__;
            const label = document.querySelector('.job-selecter-wrap .ui-dropmenu-label');
            return Number(vm?.status) === ${Number(status ?? 8)} && typeof vm.jobId === 'string'
              && label && label.getBoundingClientRect().width > 0
              && (!${Boolean(jobId)} || vm.jobId === ${JSON.stringify(jobId ?? "")});
          })()`).catch(() => false));
}

/** Provider-owned recent viewing history survives changes to recommendations. */
export async function retryViewedListRead<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await read(); }
    catch (error) {
      let transient = false;
      // Puppeteer wraps frame replacement in a selector error with the actual
      // "frame got detached" signal in cause rather than the top-level message.
      let cause: unknown = error;
      for (let depth = 0; depth < 4 && cause instanceof Error; depth++, cause = cause.cause) {
        if (cause.name === "TimeoutError" ||
          /detached frame|frame (?:got |was )?detached|execution context was destroyed|BOSS_VIEWED_LIST_UNAVAILABLE|No element found for selector: \.job-selecter/iu.test(cause.message)) transient = true;
      }
      if (attempt >= 1 || !transient) throw error;
      // A first entry can replace the iframe after its URL has already changed.
      // Reacquire that frame and its list once; this path has no external writes.
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
}

export async function locateViewedContactCandidate(page: Page, expected: ParsedCandidate): Promise<ParsedCandidate> {
  return retryViewedListRead(() => locateViewedContactCandidateAttempt(page, expected));
}

async function locateViewedContactCandidateAttempt(page: Page, expected: ParsedCandidate): Promise<ParsedCandidate> {
  const { packageRoot, version } = await getBossCliInstallation();
  const reader = await import(pathToFileURL(`${packageRoot}/dist/toolset/recommend.js`).href) as {
    readRecommendList(frame: Frame): Promise<Array<{geekId: string}>>;
    renderRecommendList(cards: unknown[]): string;
  };
  if (!viewedFrame(page)) await page.goto("https://www.zhipin.com/web/chat/interaction", { waitUntil: "domcontentloaded", timeout: 20_000 });
  const ready = async (status?: string, jobId?: string) => {
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      const frame = viewedFrame(page);
      if (frame) {
        const params = new URL(frame.url()).searchParams;
        if ((!status || params.get("status") === status) && (!jobId || params.get("jobid") === jobId)) {
          // The iframe URL can already say interaction-8 while its old
          // recommendation component (status=0) is still mounted. Require the
          // actual history component and menu, not only the new URL.
          const rendered = await viewedHistoryDomReady(frame, status, jobId);
          if (rendered) return frame;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error("BOSS_VIEWED_LIST_UNAVAILABLE：BOSS 我看过列表尚未就绪。");
  };
  let frame = await ready();
  if (new URL(frame.url()).searchParams.get("status") !== "8") {
    await frame.waitForSelector('.tab-item[title="我看过"]', { visible: true, timeout: 8000 });
    await frame.click('.tab-item[title="我看过"]');
    frame = await ready("8");
  }
  // A person can last have been viewed under another job. Search all history by
  // exact ID; the native send is separately bound to the approved job and body.
  // The tab URL changes before BOSS resolves its default job (often to -1).
  // Wait for rendered list state instead of clicking a still-initializing menu.
  const initialState = await readRecommendationState(frame);
  if (initialState.jobId !== "-1") {
    const dropdownOpen = await frame.$eval('.job-selecter-options .chat-job-search', node => node.getBoundingClientRect().width > 0).catch(() => false);
    if (!dropdownOpen) await frame.click('.job-selecter-wrap .ui-dropmenu-label');
    await frame.waitForSelector('.job-selecter-options .chat-job-search', {visible: true, timeout: 8000});
    await frame.$eval('.job-selecter-options .chat-job-search', node => {
      (node as HTMLInputElement).value = "";
      node.dispatchEvent(new Event("input", {bubbles: true}));
      node.dispatchEvent(new Event("change", {bubbles: true}));
    });
    await frame.waitForSelector('.job-selecter-options .job-item[value="-1"]', { visible: true, timeout: 8000 });
    await frame.$eval('.job-selecter-options .job-item[value="-1"]', node => (node as HTMLElement).click());
    frame = await ready("8", "-1");
  }
  let state: RecommendationState;
  return findContactCandidateInBatches(expected, {
    scopeDescription: "BOSS 我看过历史列表",
    read: async () => {
      state = await readRecommendationState(frame);
      const params = new URL(frame.url()).searchParams;
      if (params.get("status") !== "8" || state.jobId !== "-1") throw new Error("BOSS_VIEWED_LIST_UNAVAILABLE：历史列表的筛选范围发生变化。");
      const cards = await readMatchingRecommendationCards(frame, () => reader.readRecommendList(frame));
      const parsed = parseBossOutput(version, {type: "recommend"}, reader.renderRecommendList(cards));
      if (parsed.kind !== "candidates") throw new Error("BOSS_VIEWED_LIST_UNAVAILABLE：历史卡片未读取完成。");
      return {candidates: parsed.candidates, ended: state.matchingEnded};
    },
    advance: async () => {
      if (state.pageNumber === null || state.hasMore !== true) throw new Error("BOSS_VIEWED_LIST_UNAVAILABLE：无法确认历史列表是否还有下一页。");
      const before = state.pageNumber;
      await scrollRecommendationList(frame, true);
      await scrollRecommendationList(frame, false);
      await frame.waitForFunction(`(() => { const s = ${READ_RECOMMENDATION_STATE}; return s && s.jobId === '-1' && s.pageNumber > ${before}; })()`, {timeout: 15_000, polling: 100});
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  });
}
