import type { Frame, Page } from 'puppeteer-core';
import { screeningCandidateLimit } from '@boss-forge/contracts';
import { scrollRecommendationList } from './resume-list-recovery.js';
import { READ_RECOMMENDATION_STATE, readMatchingRecommendationCards, readRecommendationState, waitForRecommendationUpdate, type RecommendationState } from './boss-recommendation-readiness.js';

type Card = { geekId: string };
export type RecommendationBatch<T> = { cards: T[]; ended: boolean; pageNumber: number | null };
export type RecommendationCollection<T> = { cards: T[]; stopReason: 'limit' | 'exhausted'; loadedPages: number };

/** Accumulate unique people; neither a short page nor duplicate cards mean exhaustion. */
export async function collectRecommendationBatches<T extends Card>(input: {
  limit: number;
  /** Already admitted on this task — skip and keep scrolling for net-new only. */
  excludeGeekIds?: Iterable<string>;
  read: () => Promise<RecommendationBatch<T>>;
  advance: (batch: RecommendationBatch<T>) => Promise<void>;
  assertActive?: () => Promise<void>;
}): Promise<RecommendationCollection<T>> {
  const limit = screeningCandidateLimit(input.limit);
  const excluded = new Set(
    [...(input.excludeGeekIds ?? [])].map((id) => id.trim()).filter(Boolean)
  );
  const people = new Map<string, T>();
  let stagnantPages = 0;
  let knownOnlyPages = 0;
  for (let loadedPages = 0; ; loadedPages++) {
    await input.assertActive?.();
    const batch = await input.read();
    const before = people.size;
    let sawUnknownCard = false;
    for (const card of batch.cards) {
      if (!card.geekId?.trim()) throw new Error('BOSS_RECOMMEND_UNVERIFIED：候选人缺少可用于去重的标识。');
      if (excluded.has(card.geekId)) continue;
      sawUnknownCard = true;
      if (!people.has(card.geekId)) people.set(card.geekId, card);
      if (people.size >= limit) break;
    }
    await input.assertActive?.();
    if (people.size >= limit) return { cards: [...people.values()], stopReason: 'limit', loadedPages };
    if (batch.ended) return { cards: [...people.values()], stopReason: 'exhausted', loadedPages };
    if (people.size === before) {
      stagnantPages += 1;
      // Prior-chunk IDs still on screen are expected; keep paging instead of
      // treating them as progress toward the requested net-new headcount.
      if (!sawUnknownCard && batch.cards.length > 0) knownOnlyPages += 1;
    } else {
      stagnantPages = 0;
      knownOnlyPages = 0;
    }
    // When continuing a multi-wave task, pages of only already-admitted people
    // mean the visible list has not yet offered new resumes — exhaust cleanly
    // after genuine retries instead of throwing STALLED mid-target.
    if (excluded.size > 0 && knownOnlyPages >= 3) {
      return { cards: [...people.values()], stopReason: 'exhausted', loadedPages };
    }
    if (stagnantPages >= 3 || loadedPages >= 100) {
      if (excluded.size > 0) {
        return { cards: [...people.values()], stopReason: 'exhausted', loadedPages };
      }
      throw new Error(`BOSS_RECOMMEND_STALLED：连续加载未取得足够的新候选人，已读取 ${people.size} 位；尚未确认列表耗尽，请重试。`);
    }
    await input.advance(batch);
  }
}

/** Trigger native scrolling and verify the corresponding response and rendered page. */
export async function loadNextRecommendationPage(page: Page, frame: Frame, jobId: string, before: RecommendationState): Promise<void> {
  if (before.jobId !== jobId || before.hasMore !== true || before.pageNumber === null) {
    throw new Error('BOSS_RECOMMEND_UNVERIFIED：无法确认当前岗位的下一页，请刷新后重试。');
  }
  const update = await waitForRecommendationUpdate(page, async () => {
    // A prior read may leave the viewport at the bottom. Move up before scrolling
    // down so the provider receives a real new scroll event; never invoke its APIs.
    await scrollRecommendationList(frame, true);
    await scrollRecommendationList(frame, false);
  }, jobId, before.pageNumber + 1);
  await frame.waitForFunction(String.raw`(() => {
    const state = ${READ_RECOMMENDATION_STATE};
    const update = ${JSON.stringify(update)};
    return state && state.jobId === ${JSON.stringify(jobId)} && state.pageNumber >= ${before.pageNumber + 1}
      && update.geekIds.every(id => state.geekIds.includes(id))
      && (update.hasMore !== false || state.matchingEnded);
  })()`, { timeout: 15_000, polling: 100 });
}

export async function collectRecommendationCards<T extends Card>(page: Page, frame: Frame, jobId: string, readCards: () => Promise<T[]>, options: {
  candidateLimit: number;
  excludeGeekIds?: Iterable<string>;
  assertActive?: () => Promise<void>;
}): Promise<RecommendationCollection<T>> {
  let state: RecommendationState;
  return collectRecommendationBatches({
    limit: options.candidateLimit,
    ...(options.excludeGeekIds ? { excludeGeekIds: options.excludeGeekIds } : {}),
    ...(options.assertActive ? { assertActive: options.assertActive } : {}),
    read: async () => {
      state = await readRecommendationState(frame);
      if (state.jobId !== jobId) throw new Error('BOSS_RECOMMEND_UNVERIFIED：加载期间推荐岗位发生变化。');
      const cards = await readMatchingRecommendationCards(frame, readCards);
      return { cards, ended: state.matchingEnded, pageNumber: state.pageNumber };
    },
    advance: async () => {
      await options.assertActive?.();
      await loadNextRecommendationPage(page, frame, jobId, state);
      // Keep successive native page loads apart, including when a response is immediate.
      await new Promise(resolve => setTimeout(resolve, 1000));
    },
  });
}
