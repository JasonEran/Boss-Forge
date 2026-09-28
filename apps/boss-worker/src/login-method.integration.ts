import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import puppeteer from "puppeteer-core";
import { ensureBossAppLoginQr } from "./app-login.js";
import { ensureWechatLoginQr } from "./wechat-login.js";
import { readLoginPageFeedback } from "./login-page-feedback.js";

// Owned Chromium + intercepted documents. Never connects to BOSS, imports
// credentials, confirms a real login, or starts any recruiting worker.
const fixture = String.raw`<!doctype html><html><body><main></main><aside></aside><script>
window.actions = []; let serial = 0;
function render(mode, expired) {
  const root = document.querySelector('main');
  const src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><text x="10" y="40">' + mode + (++serial) + '</text></svg>');
  if (mode === 'sms') {
    root.innerHTML = '<button class="btn-sign-switch ewm-switch">APP扫码登录</button><a class="wx-login-btn" ka="wx_signin">微信登录</a>';
    root.querySelector('button').onclick = () => { actions.push('app'); render('app'); };
    root.querySelector('a').onclick = () => { actions.push('wechat'); render('wechat'); };
  } else if (mode === 'app') {
    root.innerHTML = '<button class="btn-sign-switch phone-switch">验证码</button><div class="scan-app-wrapper"><div class="qr-img-box"><img src="' + src + '"></div></div>';
    root.querySelector('button').onclick = () => { actions.push('phone'); render('sms'); };
  } else {
    root.innerHTML = '<div class="scan-wx-wrapper"><div class="mini-app-login"><img class="mini-qrcode" src="' + src + '"></div><a class="sms-login-btn">验证码</a></div>';
    root.querySelector('a').onclick = () => { actions.push('sms'); render('sms'); };
  }
  if (expired) {
    const overlay = document.createElement('div'); overlay.className = mode === 'app' ? 'invalid-box' : 'mini-overdue';
    overlay.innerHTML = '<p>请重新刷新二维码</p><button ka="refresh_' + (mode === 'app' ? 'app' : 'miniapp') + '_sao_qrcode">点击刷新</button>';
    root.querySelector(mode === 'app' ? '.qr-img-box' : '.scan-wx-wrapper').append(overlay);
    overlay.querySelector('button').onclick = () => { actions.push('refresh'); render(mode); };
  }
}
window.promptApp = () => {
  document.querySelector('aside').innerHTML = '<div class="dialog-container"><div class="dialog-body">为更好保障您的招聘安全，请使用BOSS直聘APP扫码登录</div><span ka="dialog_sure">去扫码</span></div>';
  document.querySelector('[ka="dialog_sure"]').onclick = () => { actions.push('go-app'); document.querySelector('aside').innerHTML = ''; render('app'); };
};
render(new URL(location.href).searchParams.get('mode') || 'wechat', new URL(location.href).searchParams.has('expired'));
</script></body></html>`;

const runtime = await mkdtemp(join(tmpdir(), 'boss-login-method-test-'));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=0'],
});
let relay: ChildProcess | undefined;
try {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.resourceType() === 'document') void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture });
    else if (request.url().startsWith('data:')) void request.continue();
    else void request.abort();
  });
  async function load(query: string) {
    await page.goto('https://www.zhipin.com/web/user/?' + query);
  }
  const cases = [
    { query: 'mode=wechat', refresh: false, actions: ['sms', 'app'] },
    { query: 'mode=sms', refresh: false, actions: ['app'] },
    { query: 'mode=app', refresh: false, actions: [] },
    { query: 'mode=app', refresh: true, actions: ['phone', 'app'] },
    { query: 'mode=app&expired=1', refresh: true, actions: ['refresh'] },
  ];
  for (const test of cases) {
    await load(test.query);
    await ensureBossAppLoginQr(page, test.refresh);
    assert.deepEqual(await page.evaluate('actions'), test.actions);
    assert.equal((await readLoginPageFeedback(page, 'wechat')).loginMethod, 'boss_app');
  }
  await load('mode=app');
  await ensureWechatLoginQr(page);
  assert.deepEqual(await page.evaluate('actions'), ['phone', 'wechat']);
  await page.evaluate('promptApp()');
  const prompt = await readLoginPageFeedback(page, 'wechat');
  assert.equal(prompt.appLoginRequired, true, JSON.stringify(prompt));
  assert.match(prompt.message, /BOSS 直聘 App/);
  assert.deepEqual(await page.evaluate('actions'), ['phone', 'wechat']);
  await ensureBossAppLoginQr(page, true);
  assert.deepEqual(await page.evaluate('actions'), ['phone', 'wechat', 'go-app']);

  await page.goto('https://www.zhipin.com/web/passport/verify');
  await ensureBossAppLoginQr(page, true);
  assert.deepEqual(await page.evaluate('actions'), []);

  await load('mode=wechat&expired=1');
  assert.match((await readLoginPageFeedback(page, 'wechat')).message, /已过期/);
  await load('mode=wechat');
  const port = new URL(browser.wsEndpoint()).port;
  function startRelay() {
    relay = spawn(process.execPath, ['--import', 'tsx', 'apps/boss-worker/src/login-relay.ts'], {
      env: { ...process.env, BOSS_BROWSER_REMOTE_DEBUGGING_PORT: port, BOSS_FORGE_RUNTIME_DIR: runtime,
        BOSS_FORGE_RELEASE_ID: 'isolated-login-test', BOSS_FORGE_CONTACT_DISPATCH_MODE: 'disabled' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    relay.stdout?.on('data', chunk => process.stdout.write(chunk));
    relay.stderr?.on('data', chunk => process.stderr.write(chunk));
  }
  async function stopRelay() {
    const child = relay;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await exited;
  }
  async function waitStatus(predicate: (value: Record<string, unknown>) => boolean) {
    const deadline = Date.now() + 20_000;
    let value: Record<string, unknown> = {};
    while (Date.now() < deadline) {
      value = await readFile(join(runtime, 'boss-login-status.json'), 'utf8').then(JSON.parse).catch(() => ({}));
      if (predicate(value)) return value;
      await delay(100);
    }
    throw new Error('Status timed out: ' + JSON.stringify(value));
  }
  async function switchMode(loginMethod: 'wechat' | 'boss_app') {
    await writeFile(join(runtime, 'boss-login-refresh-request.json'), JSON.stringify({ requestId: randomUUID(), requestedAt: new Date().toISOString(), loginMethod }));
    return waitStatus(value => value.state === 'awaiting_scan' && value.loginMethod === loginMethod && value.appLoginRequired === false);
  }
  startRelay();
  const original = await waitStatus(value => value.state === 'awaiting_scan');
  await page.evaluate('promptApp()');
  const prompted = await waitStatus(value => value.appLoginRequired === true);
  assert.notEqual(prompted.imageUpdatedAt, original.imageUpdatedAt);
  assert.equal(prompted.state, 'awaiting_scan');
  await switchMode('boss_app');
  assert.equal(await readFile(join(runtime, 'boss-login-method.json'), 'utf8'), '"boss_app"');
  await stopRelay();
  startRelay();
  await waitStatus(value => value.state === 'awaiting_scan' && value.loginMethod === 'boss_app');
  await switchMode('wechat');
  await page.evaluate(`document.querySelector('aside').innerHTML = '<div class="dialog-container"><div class="dialog-body">请完成安全验证</div></div>'`);
  await waitStatus(value => value.state === 'risk_controlled');
  const riskActions = await page.evaluate('actions');
  await writeFile(join(runtime, 'boss-login-refresh-request.json'), JSON.stringify({ requestId: randomUUID(), requestedAt: new Date().toISOString(), loginMethod: 'boss_app' }));
  await delay(1200);
  assert.deepEqual(await page.evaluate('actions'), riskActions);
  await stopRelay();
  console.log(JSON.stringify({ ok: true, cases: cases.length + 9, realBossRequests: 0, realContactExecuted: false }));
} finally {
  relay?.kill('SIGTERM');
  await browser.close();
  await rm(runtime, { recursive: true, force: true });
}
