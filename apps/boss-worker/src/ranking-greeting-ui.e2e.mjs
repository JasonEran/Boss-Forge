// Isolated browser fixture. Every API request is intercepted; no BOSS messages.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const web = new URL('../../web/', import.meta.url).pathname;
const requireWeb = createRequire(path.join(web, 'package.json'));
const { createServer } = await import(requireWeb.resolve('vite'));
const { default: react } = await import(requireWeb.resolve('@vitejs/plugin-react'));
const { default: tailwind } = await import(requireWeb.resolve('@tailwindcss/postcss'));
const fixtureDir = await mkdtemp(path.join(web, '.ranking-greeting-fixture-'));
const output = new URL('../../../artifacts/ranking-greeting-20260908/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const task = { id: 'task', positionId: 'position', positionName: '海外运营专员', candidateCount: 26, createdAt: '2026-09-08T06:00:00Z', status: 'waiting_review', ruleVersion: 4 };
let candidates = Array.from({ length: 26 }, (_, index) => ({
  stateId: `state-${index}`, taskId: 'task', positionId: 'position', name: `候选人${String(index + 1).padStart(2, '0')}`, positionName: task.positionName,
  ruleDecision: 'matched', ruleConfidence: 0.98, stateVersion: 1, resumeScreeningStatus: 'screened', currentEnglishLevel: null, resumeScreenedAt: null, resumeScreeningError: null,
  failedRuleLabels: [], evidence: [], fields: { 经验: '海外内容运营', 薪资: '8–12K' },
  semanticSummary: { mode: 'off', total: 0, matched: 0, notMatched: 0, unknown: 0, modelError: false },
  reviewStatus: index === 0 ? 'pending' : index === 24 ? 'rejected' : index === 25 ? 'pending' : 'approved', contactStatus: 'not_contacted',
  assessment: { status: 'completed', result: { score: index === 25 ? 50 : 100 - index, recommendation: index === 25 ? 'below_threshold' : 'recommended', summary: '有海外内容运营实践，建议交流具体成果。' } },
}));
let intents = [{ candidateStateId: 'state-23', actionKind: 'greet', status: 'sent' }];
const body = '你好，我们正在招聘海外运营专员。你的经历与岗位很契合，方便进一步交流吗？';
await writeFile(path.join(fixtureDir, 'index.html'), '<html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="./fixture.tsx"></script></html>');
await writeFile(path.join(fixtureDir, 'fixture.tsx'), `import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CandidateInbox} from '../app/candidate-inbox';
import '../app/globals.css';
const initial = ${JSON.stringify({ candidates, intents })};
function Fixture(){ const [data,setData]=useState(initial);return <main className="mx-auto max-w-6xl p-3 sm:p-8"><CandidateInbox candidates={data.candidates} task={${JSON.stringify(task)}} canReview retryingId={null} onReview={()=>{}} onRetry={()=>{}} contact={{controlApi:location.origin,hrName:'陈经理',intents:data.intents,onChanged:async()=>setData(await (await fetch('/fixture-state')).json())}} /></main> }
createRoot(document.getElementById('root')).render(<Fixture/>);`);
const server = await createServer({ configFile: false, root: web, plugins: [react()], resolve: { alias: { '@': web } }, define: { 'process.env.NEXT_PUBLIC_CONTROL_API_URL': '""' }, css: { postcss: { plugins: [tailwind()] } }, server: { port: 3037, strictPort: true, host: '127.0.0.1' }, logLevel: 'warn' });
await server.listen();
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage();
const errors = []; const mutations = []; const previewSizes = []; const sendSizes = [];
let failSecondBatch = true;
let wrongPreview = false;
let greetingMissing = false;
let busyGreetingSaves = 0;
let savedGreetings = 0;
page.on('pageerror', error => errors.push(error.message));
await page.setRequestInterception(true);
page.on('request', async request => {
  const url = new URL(request.url());
  const respond = (result, status = 200) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(result) });
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return request.abort();
  if (url.pathname === '/fixture-state') return respond({ candidates, intents });
  if (!url.pathname.startsWith('/api/')) return request.continue();
  const payload = JSON.parse(request.postData() || '{}');
  if (request.method() === 'POST') mutations.push({ path: url.pathname, payload });
  if (url.pathname.endsWith('/boss-greeting')) {
    if (request.method() === 'POST') { assert.equal(payload.confirmUpdate, true); if (busyGreetingSaves-- > 0) return respond({code:'busy',message:'BOSS 正在处理其他操作。'},409); savedGreetings++; greetingMissing = false; return respond({ preview: { body: payload.body } }); }
    if (greetingMissing) return respond({ configured: false, preview: null });
    return respond({ preview: { body } });
  }
  if (url.pathname === '/api/message-templates') return respond({ templates: [] });
  if (url.pathname.endsWith('/reviews')) {
    const candidate = candidates.find(item => url.pathname.includes(item.stateId));
    assert.equal(payload.expectedVersion, candidate.stateVersion);
    candidate.reviewStatus = 'approved'; candidate.stateVersion += 1;
    return respond({ review: { resultingVersion: candidate.stateVersion } }, 201);
  }
  if (url.pathname === '/api/contact-batches/preview') {
    previewSizes.push(payload.stateIds.length);
    return respond({ realContact: true, previews: payload.stateIds.map(id => ({ preview: { candidateStateId: id, candidateName: candidates.find(item => item.stateId === id).name, positionId: 'position', taskId: wrongPreview ? 'wrong-task' : 'task', actionKind: 'greet', renderedMessage: body }, readiness: { ready: true, checks: [] }, approval: { token: 'fixture-only-' + id, expiresAt: new Date(Date.now() + 600000).toISOString() } })) });
  }
  if (url.pathname === '/api/contact-batches') {
    sendSizes.push(payload.stateIds.length);
    assert.equal(payload.actionKind, 'greet'); assert.equal(payload.confirmRealContact, true);
    assert.equal(Object.keys(payload.tokens).length, payload.stateIds.length);
    assert(payload.stateIds.every(id => !intents.some(item => item.candidateStateId === id)), 'must not resubmit accepted recipients');
    if (sendSizes.length === 2 && failSecondBatch) return respond({ message: '测试：第二批连接中断' }, 503);
    intents.push(...payload.stateIds.map(id => ({ candidateStateId: id, actionKind: 'greet', status: 'ready' })));
    return respond({ submitted: payload.stateIds.length, requested: payload.stateIds.length, results: payload.stateIds.map(id => ({ stateId: id, intentId: 'intent-' + id })) }, 201);
  }
  throw new Error(`Unexpected API request: ${url.pathname}`);
});
const click = async (label, dialog = false) => {
  const handle = await page.waitForFunction((text, within) => Array.from((within ? document.querySelector('[role="dialog"]') : document).querySelectorAll('button')).find(button => button.innerText.trim().startsWith(text) && !button.disabled), {}, label, dialog);
  await handle.asElement().click(); await handle.dispose();
};
const waitText = text => page.waitForFunction(text => document.body.innerText.includes(text), {}, text);
try {
  await page.setViewport({ width: 1440, height: 1100 });
  await page.goto(`http://127.0.0.1:3037/${path.basename(fixtureDir)}/index.html`, { waitUntil: 'networkidle0' });
  await click('规则通过 · AI 排名');
  await click('一键打招呼'); await waitText(body);
  assert.equal(await page.$$eval('[aria-label="本次招呼名单"] input:checked', items => items.length), 23);
  assert.equal(await page.$$eval('[aria-label="本次招呼名单"] input:disabled', items => items.length), 3);
  assert.equal(mutations.length, 0, 'opening the dialog must be read-only');
  await page.screenshot({ path: path.join(output, 'ranking-greeting-desktop.png') });
  await page.setViewport({ width: 375, height: 812 });
  await page.waitForFunction(() => document.querySelector('[role="dialog"]').getBoundingClientRect().bottom <= innerHeight);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.screenshot({ path: path.join(output, 'ranking-greeting-mobile.png') });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert(await page.$eval('[role="dialog"]', element => element.scrollWidth <= element.clientWidth));
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[role="dialog"]')).color.includes('0.985'));
  await page.screenshot({ path: path.join(output, 'ranking-greeting-dark.png') });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await page.setViewport({ width: 844, height: 390 });
  await page.waitForFunction(() => document.querySelector('[role="dialog"]').getBoundingClientRect().bottom <= innerHeight);
  assert(await page.$eval('[role="dialog"]', element => element.getBoundingClientRect().bottom <= innerHeight));
  await page.setViewport({ width: 1440, height: 1100 });
  await page.click('[role="dialog"] > div:nth-child(2) > label input');
  await click('通过所选审核并预览', true); await waitText('发送前确认');
  assert.deepEqual(previewSizes, [20, 3]);
  assert.equal(mutations.filter(item => item.path.endsWith('/reviews')).length, 1);
  assert.equal(sendSizes.length, 0, 'preview must not send');
  await page.screenshot({ path: path.join(output, 'ranking-greeting-confirm.png') });
  await click('确认并发送 23 人', true); await waitText('已确认入队 20 人');
  assert.deepEqual(sendSizes, [20, 3]);
  failSecondBatch = false;
  await click('全选可联系人', true);
  assert.equal(await page.$$eval('[aria-label="本次招呼名单"] input:checked', items => items.length), 3);
  wrongPreview = true;
  await click('预览 3 人的招呼语', true); await waitText('预览名单与当前任务不一致');
  assert.equal(await page.$$eval('button', items => items.filter(item => item.innerText.includes('确认并发送')).length), 0);
  wrongPreview = false;
  await click('预览 3 人的招呼语', true); await waitText('发送前确认');
  await page.click('[aria-label="本次招呼名单"] input:checked');
  assert.equal(await page.$$eval('button', items => items.filter(item => item.innerText.includes('确认并发送')).length), 0, 'changing recipients invalidates preview');
  await click('全选可联系人', true);
  await click('预览 3 人的招呼语', true); await waitText('发送前确认');
  await click('确认并发送 3 人', true); await waitText('已加入发送队列 3 人');
  assert.deepEqual(sendSizes, [20, 3, 3]);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  assert(await page.evaluate(() => document.activeElement?.textContent.includes('一键打招呼')), 'focus returns to the initiating action');
  await page.type('[aria-label="搜索候选人"]', '候选人26');
  await click('一键打招呼'); await waitText(body);
  assert.equal(await page.$$eval('[aria-label="本次招呼名单"] input', items => items.length), 1, 'search limits the recipient scope');
  assert.equal(await page.$$eval('[aria-label="本次招呼名单"] input:checked', items => items.length), 0);
  await page.keyboard.press('Escape');
  greetingMissing = true;
  await click('一键打招呼'); await waitText('该岗位还没有专属招呼语');
  assert.equal(await page.$('[role="alert"]'), null, 'first-time greeting setup is not a technical error');
  assert(!(await page.evaluate(() => document.body.innerText)).includes('相关数据没有更新'));
  assert((await page.$eval('[aria-label="参考招呼消息"]', el => el.value)).includes(task.positionName));
  assert.equal(mutations.filter(item => item.path.endsWith('/boss-greeting')).length, 0, 'missing greeting must not auto-apply a draft');
  busyGreetingSaves = 1;
  await click('应用参考消息到 BOSS', true);
  await waitText('正在等待空闲后应用招呼语');
  assert.equal(savedGreetings, 0);
  assert.equal(await page.$('[role="alert"]'), null);
  await page.screenshot({ path: path.join(output, 'ranking-greeting-waiting.png') });
  await waitText('已更新 BOSS 岗位招呼语');
  assert.equal(mutations.filter(item => item.path.endsWith('/boss-greeting')).length, 2);
  assert.equal(savedGreetings, 1, 'only the confirmed busy response may be retried; apply once when free');
  await page.screenshot({ path: path.join(output, 'ranking-greeting-reference-applied.png') });
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, wholeTableAcrossPages: 26, selected: 23, skipped: 3, readOnlyOpen: true, messageReference: true, explicitReview: true, batches: sendSizes, partialFailureStops: true, noDuplicateRecipients: true, stalePreviewRejected: true, selectionInvalidatesPreview: true, searchScope: true, mobile375: true, landscape: true, dark: true, escapeAndFocus: true, noRealMessages: true }));
} finally {
  await browser.close(); await server.close(); await rm(fixtureDir, { recursive: true, force: true });
}
