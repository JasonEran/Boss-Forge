/** Local browser regression: native auto-pagination and off-filter fallback cards. */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { readMatchingRecommendationCards, waitForRenderedRecommendation } from './boss-recommendation-readiness.js';

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setContent('<div class="card-list"></div>');
  const frame = page.mainFrame();
  const setRows = async (rows: unknown[], loading = false) => page.evaluate((rows, loading) => {
    Object.assign(document.querySelector('.card-list')!, { __vue__: { pageList: rows, $parent: { loading } } });
  }, rows, loading);
  const divider = { cardType: 'memo', type: 1, memo: '暂无符合牛人，为你推荐', emptyListText: '暂无符合牛人，更换筛选范围试试' };
  const original = { encryptGeekId: 'matching' };
  const extra = { encryptGeekId: 'fallback' };
  const reader = async () => [{ geekId: 'matching' }, { geekId: 'fallback' }, { geekId: '' }];

  await setRows([divider, extra]);
  await waitForRenderedRecommendation(frame, { geekIds: [], emptyConfirmationRequired: true });
  assert.deepEqual(await readMatchingRecommendationCards(frame, reader), [], 'Empty results must exclude the fallback tail');
  assert.deepEqual(await readMatchingRecommendationCards(frame, reader), [], 'Already-applied filters must also exclude fallback cards');

  await setRows([original, divider, extra]);
  await waitForRenderedRecommendation(frame, { geekIds: ['matching'] });
  assert.deepEqual(await readMatchingRecommendationCards(frame, reader), [{ geekId: 'matching' }]);

  await setRows([original, { cardType: 'advertisement' }, { encGeekId: 'second-page' }]);
  await waitForRenderedRecommendation(frame, { geekIds: ['matching'] });
  assert.deepEqual(await readMatchingRecommendationCards(frame, async () => [{ geekId: 'matching' }, { geekId: 'second-page' }]), [{ geekId: 'matching' }, { geekId: 'second-page' }]);

  await setRows([extra], true);
  const wait = waitForRenderedRecommendation(frame, { geekIds: ['matching'] });
  let done = false;
  void wait.then(() => { done = true; });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(done, false, 'Must wait while stale cards are loading');
  await setRows([extra]);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(done, false, 'A different rendered response must not satisfy readiness');
  await setRows([original, divider, extra]);
  await wait;
  await assert.rejects(readMatchingRecommendationCards(frame, async () => [{ geekId: 'fallback' }]), /BOSS_RECOMMEND_UNVERIFIED/);
  await assert.rejects(readMatchingRecommendationCards(frame, async () => { await setRows([extra]); return reader(); }), /正在更新/);

  await setRows([]);
  await waitForRenderedRecommendation(frame, { geekIds: [] });
  assert.deepEqual(await readMatchingRecommendationCards(frame, async () => []), []);
  console.log(JSON.stringify({ ok: true, emptyFallbackExcluded: true, sameFiltersExcluded: true, partialMatchesRetained: true, automaticPagination: true, staleResponseRejected: true, emptyWithoutFallback: true }));
} finally { await browser.close(); }
