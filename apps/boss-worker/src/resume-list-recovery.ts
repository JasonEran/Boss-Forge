import puppeteer, { type Frame } from "puppeteer-core";
import { pathToFileURL } from "node:url";
import { getBossCliInstallation, parseBossOutput } from "@boss-forge/boss-cli-adapter";
import type { ParsedCandidate } from "@boss-forge/contracts";
import { selectUnambiguousCandidateTarget } from "./candidate-target.js";

const missingTarget = /BOSS_SOURCE_EXPIRED|BOSS_TARGET_MISSING/u;

/** Search bounded, currently rendered list batches; never click a candidate. */
export async function findResumeCandidateInPages(
  expected: ParsedCandidate,
  readPage: () => Promise<ParsedCandidate[]>,
  advance: () => Promise<boolean>,
  maxPages = 6,
): Promise<ParsedCandidate | null> {
  for (let page = 0; page < maxPages; page++) {
    const current = await readPage();
    try {
      return selectUnambiguousCandidateTarget(expected, current, {
        allowExpiredLocatorFingerprintFallback: true
      });
    } catch (error) {
      if (!(error instanceof Error) || !missingTarget.test(error.message)) throw error;
    }
    if (page + 1 === maxPages || !(await advance())) break;
  }
  return null;
}

type RecommendReader = {
  readRecommendList(frame: Frame): Promise<unknown[]>;
  renderRecommendList(cards: unknown[]): string;
};

/** Scroll one loaded batch; BODY overflow can be propagated to the viewport. */
export async function scrollRecommendationList(frame: Frame, toTop: boolean): Promise<boolean> {
  return frame.evaluate((top) => {
    const list = document.querySelector(".card-list, .geek-list, .candidate-card-wrap");
    let parent: Element | null = list;
    while (parent && !(parent.scrollHeight > parent.clientHeight + 20 &&
      /auto|scroll/u.test(getComputedStyle(parent).overflowY))) parent = parent.parentElement;
    let root = parent ?? document.scrollingElement;
    // On the live BOSS page BODY reports overflow:scroll and a large scrollHeight,
    // but its scrollTop stays zero. The viewport is actually scrolled by HTML.
    if (root === document.body || root === document.documentElement) {
      root = document.scrollingElement ?? root;
    }
    if (!root) return false;
    const before = root.scrollTop;
    root.scrollTop = top ? 0 : root.scrollHeight;
    root.dispatchEvent(new Event("scroll", { bubbles: true }));
    return root.scrollTop !== before;
  }, toTop);
}

/** Called while the worker owns the account lock, after restoring its job. */
export async function recoverResumeCandidateInRecommendation(
  expected: ParsedCandidate,
  jobKeyword: string | null,
): Promise<ParsedCandidate | null> {
  const installation = await getBossCliInstallation();
  const reader = await import(pathToFileURL(
    `${installation.packageRoot}/dist/toolset/recommend.js`
  ).href) as RecommendReader;
  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${process.env.BOSS_BROWSER_REMOTE_DEBUGGING_PORT || "9222"}`,
    defaultViewport: null,
    protocolTimeout: 15_000
  });
  try {
    const pages = await browser.pages();
    const frame = pages.flatMap((page) => page.frames()).find((item) =>
      item.url().includes("/web/frame/recommend")
    );
    if (!frame) throw new Error("当前不在推荐列表页，请恢复 BOSS 登录和岗位列表后重试。");
    const expectedJob = jobKeyword?.replace(/\s+/gu, "").toLocaleLowerCase() ?? "";
    const readPage = async () => {
      const currentJob = await frame.evaluate(() =>
        document.querySelector(".job-selecter-wrap .ui-dropmenu-label")?.textContent ?? ""
      );
      if (expectedJob && !currentJob.replace(/\s+/gu, "").toLocaleLowerCase().includes(expectedJob)) {
        throw new Error("BOSS_TASK_CONTEXT_MISMATCH：当前 BOSS 岗位与采集岗位不一致，请重新定位后再精筛。");
      }
      const cards = await reader.readRecommendList(frame);
      const parsed = parseBossOutput(installation.version, { type: "recommend" }, reader.renderRecommendList(cards));
      if (parsed.kind !== "candidates") throw new Error("推荐列表读取失败。");
      return parsed.candidates;
    };
    const scroll = (top: boolean) => scrollRecommendationList(frame, top);
    // A previous preview can leave the list scrolled. Start at its beginning,
    // then load more cards without refreshing or replacing the recommendation.
    await scroll(true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    let stationary = 0;
    return await findResumeCandidateInPages(expected, readPage, async () => {
      const moved = await scroll(false);
      stationary = moved ? 0 : stationary + 1;
      if (stationary > 1) return false;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return true;
    });
  } finally {
    await browser.disconnect();
  }
}
