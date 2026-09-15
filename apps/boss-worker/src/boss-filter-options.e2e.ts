/** Disposable local DB + browser-control double; never connects to BOSS. */
import assert from 'node:assert/strict';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import puppeteer, { type ElementHandle } from 'puppeteer-core';
import { assertIsolatedTestDatabase } from '@boss-forge/data';
import { resumeViewPolicyFromEnvironment } from '@boss-forge/contracts';
import { startBossBrowserControlServer, bossBrowserControlSocketPath, BossBrowserControlError } from '@boss-forge/boss-cli-adapter';

assertIsolatedTestDatabase(process.env, { contactSideEffects: false });
const api = process.env.CONTROL_API_URL!;
const web = process.env.BOSS_UI_TEST_URL!;
const runtime = process.env.BOSS_FORGE_RUNTIME_DIR!;
assert(new URL(api).hostname === '127.0.0.1' && new URL(web).hostname === '127.0.0.1' && runtime.startsWith('/tmp/'));
await mkdir(runtime, { recursive: true });
const statusFile = join(runtime, 'boss-login-status.json');
await writeFile(statusFile, JSON.stringify({ state: 'authenticated', message: 'Test double', updatedAt: new Date().toISOString(), releaseId: 'unversioned', contactDispatchMode: 'disabled', resumePolicy: resumeViewPolicyFromEnvironment(process.env), verification: { browserAuthenticated: true, workerHeartbeatFresh: true } }));
let token = '';
async function request(path: string, body?: unknown) {
  const response = await fetch(api + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() as any };
}
let busy = false;
let keywords = ['英语读写', '店铺运营'];
let reads = 0;
const ipc = await startBossBrowserControlServer({ socketPath: bossBrowserControlSocketPath(runtime), accountId: 'boss-account-01',
  positions: async () => ({ complete: true, jobs: [{ id: 'e2e-amazon', name: '亚马逊运营', status: '开放中' }, { id: 'e2e-ai', name: 'AI工程师', status: '开放中' }] }),
  filterOptions: async ({ bossJobId, jobKeyword }) => {
    if (busy) throw new BossBrowserControlError('busy', 'Busy test');
    reads++;
    await new Promise(resolve => setTimeout(resolve, 350));
    return { bossJobId, bossJobName: jobKeyword, fetchedAt: new Date().toISOString(), fields: bossJobId === 'e2e-amazon' ? { major: ['电子商务类', '管理科学与工程类'], keyword1: keywords } : { major: ['计算机类'], keyword1: ['Python'] } };
  },
  greetingPreview: async () => { throw new Error('Not a contact test'); },
});
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
try {
  token = (await request('/api/auth/login', { email: 'admin@boss-forge.internal', password: 'ChangeMe-BossForge-Internal!' })).data.token;
  assert(token);
  const sync = await request('/api/boss/positions/sync', {}); assert.equal(sync.status, 200);
  const amazon = sync.data.positions.find((p: any) => p.bossJobId === 'e2e-amazon');
  const ai = sync.data.positions.find((p: any) => p.bossJobId === 'e2e-ai');
  assert.equal((await request(`/api/positions/${amazon.id}/boss-filter-options`, {})).data.fields.keyword1[0], '英语读写');
  assert.equal((await request(`/api/positions/${ai.id}/boss-filter-options`, {})).data.fields.keyword1[0], 'Python');
  busy = true;
  assert.equal((await request(`/api/positions/${amazon.id}/boss-filter-options`, {})).status, 409);
  busy = false;
  const page = await browser.newPage(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.evaluateOnNewDocument(value => sessionStorage.setItem('boss-forge.session-token', value), token);
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(`${web}/positions?position=${amazon.id}`, { waitUntil: 'networkidle0' });
  const click = async (label: string) => {
    const button = await page.waitForFunction(text => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.offsetWidth && b.innerText.trim() === text), {}, label);
    await (button.asElement() as ElementHandle<Element>).click(); await button.dispose();
  };
  await click('添加岗位规则');
  await click('一键获取 BOSS VIP 筛选');
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>('button')].some(b => b.disabled && b.innerText.includes('正在获取')));
  await click('英语读写'); await click('电子商务类');
  assert.equal(await page.$('input[aria-label="专业"]'), null);
  const pressed = async (label: string) => page.evaluate(text => [...document.querySelectorAll('button')].find(b => b.innerText.trim() === text)?.getAttribute('aria-pressed'), label);
  assert.equal(await pressed('英语读写'), 'true');
  await click('一键获取 BOSS VIP 筛选');
  await page.waitForFunction(() => !document.querySelector('section[aria-label="BOSS VIP 筛选配置"][aria-busy="true"]'));
  assert.equal(await pressed('英语读写'), 'true', 'Refresh must retain selections');
  keywords = ['店铺运营']; await click('一键获取 BOSS VIP 筛选');
  await page.waitForFunction(() => document.body.innerText.includes('英语读写（已失效，点击移除）'));
  await click('保存并立即生效');
  assert(await page.$('[role="dialog"]'), 'Stale selection blocks saving');
  await click('英语读写（已失效，点击移除）'); await click('店铺运营');
  const dir = process.env.BOSS_CAPTURE_TEST_OUTPUT || '/tmp/boss-filter-options-e2e'; await mkdir(dir, { recursive: true });
  await page.$eval('section[aria-label="BOSS VIP 筛选配置"]', el => el.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: join(dir, 'options-desktop.png') });
  await page.setViewport({ width: 390, height: 844 });
  await page.$eval('section[aria-label="BOSS VIP 筛选配置"]', el => el.scrollIntoView({ block: 'center' }));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(dir, 'options-mobile.png') });
  await click('保存并立即生效'); await page.waitForSelector('[role="dialog"]', { hidden: true });
  await click('编辑岗位规则');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.innerText.trim() === '店铺运营' && b.getAttribute('aria-pressed') === 'true'));
  assert.equal(await pressed('电子商务类'), 'true');
  assert.deepEqual(errors, []);
  assert(reads >= 5);
  console.log(JSON.stringify({ ok: true, exactJobApi: true, refreshRetainsSelection: true, staleSelectionBlocked: true, saveAndReopen: true, desktopAndMobile: true, noPageErrors: true }));
} finally { await browser.close(); await ipc.close(); await unlink(statusFile); }
