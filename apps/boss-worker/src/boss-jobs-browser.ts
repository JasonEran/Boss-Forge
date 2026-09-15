import { readBossMajorCatalog } from "./boss-major-catalog.js";
import type { Frame, Page } from "puppeteer-core";
import { pathToFileURL } from "node:url";
import { getBossCliInstallation } from "@boss-forge/boss-cli-adapter";
import { collectBossJobCatalog, selectExactJobOption, type BoundBossJob, type JobOption, type BossJobPage } from "./boss-jobs.js";
import { applyBossRecommendationFilters, readFilterPanel, readBossVipFilterOptions } from "./boss-filters-browser.js";
import { readMatchingRecommendationCards, waitForRecommendationUpdate, waitForRenderedRecommendation } from "./boss-recommendation-readiness.js";
import { collectRecommendationCards } from './boss-recommendation-collection.js';

async function toolset() {
  const { packageRoot } = await getBossCliInstallation();
  return import(pathToFileURL(`${packageRoot}/dist/toolset/recommend.js`).href) as Promise<{
    ensureInRecommendPage(page: Page): Promise<Frame>;
    readRecommendList(frame: Frame): Promise<Array<{ geekId: string }>>;
    renderRecommendList(cards: unknown[]): string;
  }>;
}

const READ_JOB_PAGE_SCRIPT = String.raw`(() => {
  const text = (node) => (node?.textContent ?? "").replace(/\s+/gu, " ").trim();
  const rows = Array.from(document.querySelectorAll(".job-jobInfo-warp, .job-item-container"));
  // job_v2 renders IDs in each visible card's Vue 3 props, rather than DOM
  // attributes. Read that render tree only; no provider methods are called.
  const visibleRows = new Set(rows);
  const infoByRow = new Map();
  const stack = [document.querySelector('#app')?._vnode];
  const seen = new Set();
  while (stack.length && seen.size < 10000) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    const component = node.component;
    if (component) {
      const row = component.subTree?.el;
      if (visibleRows.has(row) && component.props?.jobInfo) infoByRow.set(row, component.props.jobInfo);
      stack.push(component.subTree);
    }
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  const jobs = rows.map(row => {
    const info = infoByRow.get(row);
    return {
      id: row.getAttribute("data-id")?.trim() || info?.encryptJobId || info?.encryptId || "",
      name: text(row.querySelector(".job-title a, .job-title .job-name")),
      status: text(row.querySelector(".job-status-wrapper .status-box")) || "未知",
    };
  });
  const totalText = text(document.querySelector(".total-num"));
  const totalMatch = totalText.match(/\d+/u);
  const total = totalMatch ? Number(totalMatch[0]) : null;
  return { jobs, total, ready: jobs.length > 0 || total === 0 };
})()`;

export async function readJobPage(frame: Frame): Promise<BossJobPage & { ready: boolean }> {
  // The self-contained string also survives serialization under tsx.
  return frame.evaluate(READ_JOB_PAGE_SCRIPT) as Promise<BossJobPage & { ready: boolean }>;
}

/** Only reads the job management list; never opens the provider's edit form. */
export async function readJobsFromBossPage(page: Page) {
  if (!new URL(page.url()).pathname.startsWith("/web/chat/job/list")) {
    await page.goto("https://www.zhipin.com/web/chat/job/list", { waitUntil: "domcontentloaded", timeout: 20_000 });
  }
  let frame: Frame | undefined;
  const until = Date.now() + 12_000;
  while (Date.now() < until && !frame) {
    for (const candidate of page.frames()) {
      try { if ((await readJobPage(candidate)).ready) { frame = candidate; break; } } catch { /* A navigation can detach an old iframe. */ }
    }
    if (!frame) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!frame) throw new Error("未读取到 BOSS 职位列表，请确认登录后重新同步。");
  const jobFrame = frame;
  return collectBossJobCatalog(() => readJobPage(jobFrame), async (snapshot) => {
    const next = await jobFrame.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(
        '.ui-page .next, .ui-pager .next, .ui-pager-next, .page-next, .pagination .next, [aria-label="下一页"], [title="下一页"]'
      ));
      const button = candidates.find((node) => node.getBoundingClientRect().width > 0);
      if (!button) return "absent";
      if (button.matches('[disabled], [aria-disabled="true"], .disabled, .is-disabled') || button.closest('.disabled, .is-disabled')) return "end";
      button.click();
      return "clicked";
    });
    if (next !== "clicked") return false;
    const previous = snapshot.jobs.map((job) => job.id).join("|");
    await jobFrame.waitForFunction(`(() => {
      const snapshot = ${READ_JOB_PAGE_SCRIPT};
      return snapshot.ready && snapshot.jobs.map(job => job.id).join("|") !== ${JSON.stringify(previous)};
    })()`, { timeout: 8000 });
    return true;
  });
}

const READ_JOB_OPTIONS_SCRIPT = String.raw`(() => {
    const text = (node) => (node?.textContent ?? "").replace(/\s+/gu, " ").trim();
    const getId = (node) => {
      for (const key of ["value", "data-id", "data-jobid", "data-job-id", "data-enc-job-id"]) {
        const value = node.getAttribute(key); if (value) return value;
      }
      const vm = node.__vue__;
      const props = vm?.$props;
      for (const item of [props, props?.job, props?.item, vm?.job, vm?.item]) {
        if (!item || typeof item !== "object") continue;
        const job = item;
        for (const key of ["encJobId", "encryptJobId", "jobId"]) {
          if (typeof job[key] === "string" && job[key]) return job[key];
        }
      }
      return "";
    };
    return Array.from(document.querySelectorAll(".job-selecter-options .job-list .job-item")).map((node, index) => ({
      id: getId(node),
      name: text(node.querySelector(".job-name, .job-title, .label") ?? node),
      label: text(node.querySelector(".label") ?? node),
      disabled: node.matches('.disabled, .is-disabled, [aria-disabled="true"]'), current: node.matches('.curr'), index,
    }));
  })()`;

export async function readJobOptions(frame: Frame): Promise<JobOption[]> {
  return frame.evaluate(READ_JOB_OPTIONS_SCRIPT) as Promise<JobOption[]>;
}

/** Reacquire a replaced frame for list operations; never repeat a resume click. */
export async function retryRecommendationContext<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= 2 || !/frame got detached|detached frame|execution context was destroyed|cannot find context with specified id/iu.test(message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
}

export async function readRecommendationForJob(page: Page, job: BoundBossJob, collection?: { candidateLimit: number; assertActive?: () => Promise<void> }): Promise<string> {
  return retryRecommendationContext(() => readRecommendationForJobAttempt(page, job, collection));
}

async function readRecommendationForJobAttempt(page: Page, job: BoundBossJob, collection?: { candidateLimit: number; assertActive?: () => Promise<void> }): Promise<string> {
  await collection?.assertActive?.();
  const { reader, frame, selected } = await selectRecommendationJob(page, job);
  if (job.filters) await applyBossRecommendationFilters(page, frame, job.filters, job.id);
  if (collection) {
    const result = await collectRecommendationCards(page, frame, job.id, () => reader.readRecommendList(frame), collection);
    console.error(JSON.stringify({ event: 'boss.recommend.collection', candidateCount: result.cards.length, candidateLimit: collection.candidateLimit, stopReason: result.stopReason, loadedPages: result.loadedPages }));
    return `当前岗位：${selected.label}\n${reader.renderRecommendList(result.cards)}`;
  }
  const cards = await readMatchingRecommendationCards(frame, () => reader.readRecommendList(frame));
  return `当前岗位：${selected.label}\n${reader.renderRecommendList(cards)}`;
}

export async function selectRecommendationJob(
  page: Page,
  job: BoundBossJob,
  options: { reader?: Awaited<ReturnType<typeof toolset>>; waitForCandidates?: boolean } = {},
) {
  const reader = options.reader ?? await toolset();
  let frame = await reader.ensureInRecommendPage(page);
  const dropdownOpen = await frame.$eval(".job-selecter-options .chat-job-search", (node) => node.getBoundingClientRect().width > 0).catch(() => false);
  if (!dropdownOpen) await frame.click(".job-selecter-wrap .ui-dropmenu-label");
  await frame.waitForSelector(".job-selecter-options .chat-job-search", { visible: true, timeout: 8000 });
  await frame.evaluate((name) => {
    const input = document.querySelector<HTMLInputElement>(".job-selecter-options .chat-job-search");
    if (!input) throw new Error("未找到 BOSS 岗位搜索框。");
    input.value = name;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, job.name);
  // Chat polling and analytics can keep BOSS busy after the dropdown is ready.
  // Wait for the search to render instead of waiting for the entire site to idle.
  await frame.waitForFunction(String.raw`(() => {
    const name = ${JSON.stringify(job.name)};
    const normalize = (value) => value.replace(/\s+/gu, "").toLocaleLowerCase();
    const input = document.querySelector(".job-selecter-options .chat-job-search");
    const rows = ${READ_JOB_OPTIONS_SCRIPT};
    return input?.value === name && rows.some(row => row.id === ${JSON.stringify(job.id)} ||
      (${JSON.stringify(job.allowNameFallback)} && !row.id && normalize(row.name) === normalize(name)));
  })()`, { timeout: 8000, polling: 100 }).catch(async (error: unknown) => {
    // Report a genuinely missing/closed job rather than an unexplained spinner.
    if (error instanceof Error && error.name === "TimeoutError") selectExactJobOption(await readJobOptions(frame), job);
    throw error;
  });
  const jobOptions = await readJobOptions(frame);
  const selected = selectExactJobOption(jobOptions, job);
  const currentLabel = await frame.$eval(".job-selecter-wrap .ui-dropmenu-label", (node) => (node.textContent ?? "").replace(/\s+/gu, " ").trim());
  if (selected.current || (job.allowNameFallback && currentLabel === selected.label && jobOptions.filter((option) => option.label === selected.label).length === 1)) {
    await frame.click(".job-selecter-wrap .ui-dropmenu-label");
  } else {
    // Search can render again after the initial read. Resolve the selected ID
    // inside the click operation rather than trusting a previous row index.
    const select = () => frame.evaluate(String.raw`(() => {
      const selected = ${JSON.stringify(selected)};
      const matches = (${READ_JOB_OPTIONS_SCRIPT}).filter(row => selected.id
        ? row.id === selected.id : !row.id && row.label === selected.label);
      if (matches.length !== 1 || matches[0].disabled) throw new Error('BOSS 岗位列表已变化，请重试。');
      const node = document.querySelectorAll('.job-selecter-options .job-list .job-item')[matches[0].index];
      if (!node) throw new Error('BOSS 岗位列表已变化，请重试。');
      node.click();
    })()`) as Promise<void>;
    // Candidate collection still waits for the refreshed list; option reads only
    // need the selected job and its panel, not candidate/network activity.
    const update = options.waitForCandidates !== false
      ? await waitForRecommendationUpdate(page, select, job.id)
      : await select();
    frame = await reader.ensureInRecommendPage(page);
    await frame.waitForFunction((label) => (document.querySelector(".job-selecter-wrap .ui-dropmenu-label")?.textContent ?? "")
      .replace(/\s+/gu, " ").trim() === label, { timeout: 8000 }, selected.label);
    if (update) await waitForRenderedRecommendation(frame, update);
  }
  return { reader, frame, selected };
}

/** Explicit refresh gets current provider definitions; no filter is applied or résumé opened. */
export async function readRecommendationFilterOptions(page: Page, job: BoundBossJob) {
  // The initial entry can replace recommendFrame too, before the explicit reload.
  await retryRecommendationContext(async () => (await toolset()).ensureInRecommendPage(page));
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
  return retryRecommendationContext(async () => {
    const { frame, selected } = await selectRecommendationJob(page, job, { waitForCandidates: false });
    const wasOpen = Boolean(await frame.$('.filter-panel'));
    try {
      if (!wasOpen) await frame.$eval('.filter-label-wrap', node => (node as HTMLElement).click());
      await frame.waitForSelector('.filter-panel .check-box .option', { visible: true, timeout: 8000 });
      if (await frame.$('.filter-panel .vip-folded')) await frame.$eval('.filter-panel .vip-folded', node => (node as HTMLElement).click());
      const catalog = await frame.$('.filter-panel .operate-btn.major') ? await readBossMajorCatalog(frame, selected.id) : undefined;
      return readBossVipFilterOptions(await readFilterPanel(frame, selected.id), selected.id, selected.label, catalog);
    } finally {
      if (!wasOpen && await frame.$('.filter-panel').catch(() => null)) await frame.$eval('.filter-label-wrap', node => (node as HTMLElement).click()).catch(() => {});
    }
  });
}
