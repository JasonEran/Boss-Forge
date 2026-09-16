/** Local UI/API regression test. Never starts a BOSS worker. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import puppeteer, { type ElementHandle } from 'puppeteer-core';
import { assertIsolatedTestDatabase, createDatabase } from '@boss-forge/data';
assertIsolatedTestDatabase(process.env, { contactSideEffects: false });
const api = 'http://127.0.0.1:3152';
const web = 'http://127.0.0.1:3052';
const sql = createDatabase();
const [position] = await sql`UPDATE positions SET boss_job_id = 'limit-ui-job', boss_job_keyword = name, boss_job_status = '开放中' RETURNING id`;
const login = await fetch(api + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'limit@example.invalid', password: 'LocalLimitTest!123' }) });
const { token } = await login.json() as { token: string }; assert(token);
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH!, headless: true });
const errors: string[] = [];
try {
  const page = await browser.newPage(); page.on('pageerror', e => errors.push(String(e)));
  page.on('dialog', dialog => void dialog.accept());
  await page.evaluateOnNewDocument(value => sessionStorage.setItem('boss-forge.session-token', value), token);
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(`${web}/tasks?position=${position!.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#screening-count');
  assert.equal(await page.$eval('#screening-count', e => (e as HTMLInputElement).value), '20');
  const click = async (label: string) => {
    const handle = await page.waitForFunction(text => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.offsetWidth && b.innerText.trim() === text), {}, label);
    await (handle.asElement() as ElementHandle<Element>).click(); await handle.dispose();
  };
  const fill = async (selector: string, value: string) => {
    await page.click(selector, { count: 3 }); await page.keyboard.press('Backspace'); await page.type(selector, value);
  };
  await fill('#screening-count', '100001');
  assert.equal(await page.$eval('#screening-count', e => e.getAttribute('aria-invalid')), 'true');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.innerText.startsWith('开始筛选'))!.disabled), true);
  await fill('#screening-count', '7');
  const createdResponse = page.waitForResponse(r => r.url() === api + '/api/tasks' && r.request().method() === 'POST');
  await click('开始筛选 · 7 人');
  const created = await (await createdResponse).json(); assert.equal(created.task.candidateLimit, 7);
  await page.waitForFunction(() => document.body.innerText.includes('本次上限 7 人'));
  await mkdir('artifacts/screening-limit-20260907', { recursive: true });
  await page.screenshot({ path: 'artifacts/screening-limit-20260907/desktop.png' });
  await page.setViewport({ width: 375, height: 812 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'artifacts/screening-limit-20260907/mobile.png' });
  const stoppedResponse = page.waitForResponse(r => r.url().endsWith(`/api/tasks/${created.task.id}/cancel`) && r.request().method() === 'POST');
  await click('停止本次筛选');
  assert.equal((await (await stoppedResponse).json()).task.status, 'cancelled');
  await click('定时筛选'); await page.waitForSelector('#schedule-screening-count');
  await fill('#schedule-screening-count', '11');
  const scheduleResponse = page.waitForResponse(r => r.url() === api + '/api/schedules' && r.request().method() === 'POST');
  await click('保存定时任务');
  assert.equal((await (await scheduleResponse).json()).schedule.candidateLimit, 11);
  // 385 is allowed now (old 200 product cap removed); only absurd ceilings are rejected.
  const large = await fetch(api + '/api/tasks', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ positionId: position!.id, source: 'recommend', candidateLimit: 385 }) });
  assert.equal(large.status, 201);
  assert.equal(((await large.json()) as { task: { candidateLimit: number } }).task.candidateLimit, 385);
  const invalid = await fetch(api + '/api/tasks', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ positionId: position!.id, source: 'recommend', candidateLimit: 100_001 }) });
  assert.equal(invalid.status, 400);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, default: 20, selected: 7, scheduled: 11, large385: true, invalidInputBlocked: true, invalidApiRejected: true, stopped: true, mobile375: true, pageErrors: 0 }));
} finally { await browser.close(); await sql.end(); }
