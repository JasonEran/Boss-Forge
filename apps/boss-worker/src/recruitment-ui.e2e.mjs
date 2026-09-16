import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const origin = 'http://localhost:3031';
const api = 'http://localhost:3311';
const output = new URL('../../../artifacts/recruitment-20260908/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const fixture = JSON.parse((await readFile('/tmp/recruitment-feature-integration.log', 'utf8')).trim().split('\n').at(-1));
const login = await fetch(api + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'integration-admin@example.invalid', password: 'IntegrationOnly!123' }) });
assert.equal(login.status, 200);
const auth = await login.json();
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'] });
const errors = [];
const page = await browser.newPage();
page.on('pageerror', error => errors.push(error.message));
await page.evaluateOnNewDocument(token => sessionStorage.setItem('boss-forge.session-token', token), auth.token);
const query = `?position=${fixture.positionId}&task=${fixture.taskId}`;
async function clickText(text) {
  const element = await page.waitForSelector(`::-p-text(${text})`, { timeout: 20000 });
  await element.click();
}
try {
  await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 });
  await page.goto(origin + '/' + query, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.innerText.includes('招聘目的与目标'));
  await page.screenshot({ path: output + 'overview-desktop.png', fullPage: true });
  await page.goto(origin + '/positions' + query, { waitUntil: 'networkidle0' });
  await clickText('编辑岗位规则');
  await page.waitForSelector('[role="dialog"]');
  await page.waitForFunction(() => document.querySelector('[role="dialog"] textarea')?.value.includes('跨境电商'));
  await page.screenshot({ path: output + 'position-goals-desktop.png' });
  assert.equal(await page.$eval('input[type="number"][max="1000000"]', el => el.value), '12000');
  await page.keyboard.press('Escape');
  await page.goto(origin + '/candidates' + query, { waitUntil: 'networkidle0' });
  await clickText('规则通过 · AI 排名');
  await page.screenshot({ path: output + 'ai-ranking-desktop.png', fullPage: true });
  await clickText('低分复核');
  assert(await page.$eval('section[aria-label="候选人工作名单"]', el => el.innerText.includes('50')));
  await page.click('section[aria-label="候选人工作名单"] tbody button');
  await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.innerText.includes('AI 岗位匹配分析'));
  await page.screenshot({ path: output + 'ai-review-desktop.png' });
  await page.keyboard.press('Escape');
  await page.goto(origin + '/contacts' + query, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.innerText.includes('快捷招呼 / 消息模板'));
  await page.click('fieldset[aria-label="联系动作"] button:last-child');
  await page.waitForFunction(() => document.querySelector('fieldset[aria-label="联系动作"] button:last-child')?.getAttribute('aria-pressed') === 'true');
  await page.screenshot({ path: output + 'batch-contacts-desktop.png', fullPage: true });
  const count = await page.$$eval('section[aria-label="批量联系工作区"] input[type="checkbox"]:not(:disabled)', elements => elements.length);
  assert(count >= 1);
  await page.click('section[aria-label="批量联系工作区"] input[type="checkbox"]:not(:disabled)');
  await clickText('预览 1 人的消息');
  await page.waitForFunction(() => document.body.innerText.includes('发送前确认'), { timeout: 25000 });
  await page.screenshot({ path: output + 'batch-preview-desktop.png', fullPage: true });
  assert(await page.$eval('body', el => el.innerText.includes('模拟发送')));
  // No real transport is running in the isolated database. This validates the
  // exact same submit path without messaging anyone on BOSS.
  await clickText('确认并模拟 1 人');
  await page.waitForFunction(() => document.body.innerText.includes('已加入发送队列'), { timeout: 25000 });
  await page.reload({ waitUntil: 'networkidle0' });
  await clickText('取消待发送');
  await page.waitForFunction(() => document.body.innerText.includes('已取消 1 条'), { timeout: 25000 });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.screenshot({ path: output + 'batch-contacts-mobile.png', fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile must not overflow horizontally');
  await page.goto(origin + '/positions' + query, { waitUntil: 'networkidle0' });
  await clickText('编辑岗位规则');
  await page.screenshot({ path: output + 'position-goals-mobile.png' });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, desktop: true, mobile: true, salaryUpperBoundVisible: true, aiRankingAndReview: true, batchPreview: true, fakeSubmit: true, persistentQueueAndCancellation: true, noRealMessages: true }));
} finally {
  await browser.close();
  await fetch(api + '/api/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${auth.token}` } });
}
