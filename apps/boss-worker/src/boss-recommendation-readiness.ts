import type { Frame, Page } from "puppeteer-core";

export type RecommendationUpdate = { geekIds: string[]; emptyConfirmationRequired?: boolean; pageNumber?: number; hasMore?: boolean };

// CardList includes a memo divider followed by recommendations outside the
// selected conditions. Read the rendered source, including when filters are
// already applied and no new request is made. Never collect the fallback tail.
export const READ_RECOMMENDATION_STATE = String.raw`(() => {
  const vm = document.querySelector('.card-list, .geek-list-wrap .geek-list')?.__vue__;
  if (!Array.isArray(vm?.pageList) || vm.$parent?.loading === true || vm.$parent?.loadding === true) return null;
  const ancestors = []; let owner = vm;
  for (let i = 0; i < 5 && owner; i++, owner = owner.$parent) ancestors.push(owner);
  if (ancestors.some(item => item.loading$ === true)) return null;
  const pager = ancestors.find(item => Number.isInteger(item.page$)) ?? ancestors.find(item => Number.isInteger(item.page));
  const more = ancestors.find(item => typeof item.hasMore$ === 'boolean') ?? ancestors.find(item => typeof item.hasMore === 'boolean');
  const hasMore = typeof vm.$parent?.finished === 'boolean' ? !vm.$parent.finished : (more?.hasMore$ ?? more?.hasMore ?? null);
  const id = item => item?.encryptGeekId || item?.encGeekId;
  const ids = rows => rows.map(id).filter(value => typeof value === 'string' && value.length > 0);
  const divider = vm.pageList.findIndex(item => item &&
    ((item.cardType === 'memo' && [0, 1].includes(item.type)) ||
      (item.type === 'memo' && item.encryptGeekId === -1)));
  const matchingRows = divider < 0 ? vm.pageList : vm.pageList.slice(0, divider);
  const matchingGeekIds = ids(matchingRows);
  return {
    geekIds: ids(vm.pageList), matchingGeekIds,
    emptyConfirmed: divider >= 0 && matchingGeekIds.length === 0,
    matchingEnded: divider >= 0 || hasMore === false, hasMore,
    pageNumber: pager?.page$ ?? pager?.page ?? null,
    jobId: typeof vm.jobId === 'string' ? vm.jobId : null,
  };
})()`;

export type RecommendationState = {
  geekIds: string[]; matchingGeekIds: string[]; emptyConfirmed: boolean;
  matchingEnded: boolean; hasMore: boolean | null; pageNumber: number | null; jobId: string | null;
};

export async function readRecommendationState(frame: Frame): Promise<RecommendationState> {
  await frame.waitForFunction(`Boolean(${READ_RECOMMENDATION_STATE})`, { timeout: 15_000, polling: 100 });
  const state = await frame.evaluate(READ_RECOMMENDATION_STATE) as RecommendationState | null;
  if (!state) throw new Error('BOSS_RECOMMEND_UNVERIFIED：推荐列表正在更新，请稍后重试。');
  return state;
}

/** Wait for the first page requested by this action, not unrelated chat traffic. */
export async function waitForRecommendationUpdate(page: Page, action: () => Promise<void>, expectedJobId?: string, requestedPage = 1): Promise<RecommendationUpdate> {
  const controller = new AbortController();
  const responsePromise = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.origin === new URL(page.url()).origin && url.pathname === "/wapi/zpjob/rec/geek/list"
      && Number(url.searchParams.get("page") ?? 1) === requestedPage;
  }, { timeout: 20_000, signal: controller.signal });
  // Clicking can fail before the pending response wait completes.
  void responsePromise.catch(() => {});
  try {
    await action();
    const response = await responsePromise;
    const body = await response.json() as { code?: number; zpData?: {
      encryptJobId?: string; hasMore?: boolean; page?: number;
      geekList?: Array<{ encryptGeekId?: string; encGeekId?: string }> | null;
    } };
    const data = body.zpData;
    // BOSS omits geekList on a successful empty first page, then loads fallback
    // cards itself. An omitted list is only provisional until the UI confirms it.
    const omittedList = data?.geekList == null && data?.page === requestedPage && typeof data?.hasMore === 'boolean';
    if (!response.ok() || body.code !== 0 || !data || (!Array.isArray(data.geekList) && !omittedList)) {
      throw new Error("BOSS_RECOMMEND_UNVERIFIED：推荐列表接口未成功返回，本次未采集候选人。");
    }
    if (expectedJobId && data.encryptJobId !== expectedJobId) {
      throw new Error("BOSS_RECOMMEND_UNVERIFIED：推荐列表岗位与所选岗位不一致，请重新选择岗位。");
    }
    if (data.page !== undefined && data.page !== requestedPage) throw new Error('BOSS_RECOMMEND_UNVERIFIED：推荐分页响应与请求不一致。');
    const metadata = {
      ...(data.page !== undefined ? { pageNumber: data.page } : {}),
      ...(typeof data.hasMore === 'boolean' ? { hasMore: data.hasMore } : {}),
    };
    if (omittedList) return { geekIds: [], emptyConfirmationRequired: true, ...metadata };
    return { geekIds: data.geekList!.map(item => item.encryptGeekId || item.encGeekId).filter((id): id is string => typeof id === "string" && id.length > 0), ...metadata };
  } finally { controller.abort(); }
}

/** BOSS can append more pages automatically when the first contains < 15 cards. */
export async function waitForRenderedRecommendation(frame: Frame, update: RecommendationUpdate): Promise<void> {
  await frame.waitForFunction(String.raw`(() => {
    const state = ${READ_RECOMMENDATION_STATE};
    if (!state) return false;
    const update = ${JSON.stringify(update)};
    if (update.emptyConfirmationRequired) return state.emptyConfirmed || state.geekIds.length === 0;
    if (!update.geekIds.length) return state.geekIds.length === 0 || state.emptyConfirmed;
    return update.geekIds.every((id, index) => state.geekIds[index] === id);
  })()`, { timeout: 15_000, polling: 100 });
}

export async function readMatchingRecommendationCards<T>(frame: Frame, readCards: () => Promise<T[]>): Promise<T[]> {
  await frame.waitForFunction(`Boolean(${READ_RECOMMENDATION_STATE})`, { timeout: 15_000, polling: 100 });
  const before = await frame.evaluate(READ_RECOMMENDATION_STATE) as RecommendationState | null;
  const cards = await readCards();
  const after = await frame.evaluate(READ_RECOMMENDATION_STATE) as RecommendationState | null;
  if (!before || !after || JSON.stringify(before.matchingGeekIds) !== JSON.stringify(after.matchingGeekIds)) {
    throw new Error('BOSS_RECOMMEND_UNVERIFIED：推荐列表正在更新，请稍后重试。');
  }
  const allowed = new Set(after.matchingGeekIds);
  const matching = cards.filter(card => card && typeof card === 'object' && 'geekId' in card
    && typeof card.geekId === 'string' && allowed.has(card.geekId));
  if (allowed.size > 0 && matching.length === 0) {
    throw new Error('BOSS_RECOMMEND_UNVERIFIED：候选人卡片尚未读取完成，请稍后重试。');
  }
  return matching;
}
