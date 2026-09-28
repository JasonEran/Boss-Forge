import assert from 'node:assert/strict';
import puppeteer from '../../../boss-worker/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
const origin = process.env.BOSS_UI_TEST_ORIGIN || 'http://127.0.0.1:3310';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1080 });
let status = {
  state: 'awaiting_scan',
  message: '请使用微信扫一扫，打开 BOSS 直聘小程序并确认登录。',
  imageAvailable: true,
  imageUpdatedAt: '2026-09-28T12:00:00.000Z',
  loginMethod: 'wechat',
  runtimeConsistent: true,
  contactDispatchMode: 'disabled',
  sideEffectsMode: 'preview_only',
};
const errors = [];
const posts = [];
let imageCount = 0;
let serial = 0;
page.on('pageerror', (e) => errors.push(e.message));
await page.evaluateOnNewDocument(() =>
  sessionStorage.setItem('boss-forge.session-token', 'isolated-fixture'),
);
await page.setRequestInterception(true);
page.on('request', (r) => {
  const url = new URL(r.url());
  if (url.pathname.startsWith('/api/')) {
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization,content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'cache-control': 'no-store',
    };
    if (r.method() === 'OPTIONS')
      return void r.respond({ status: 204, headers });
    let value = {};
    if (url.pathname === '/api/auth/me')
      value = {
        user: {
          userId: 'fixture',
          departmentId: 'fixture',
          email: 'fixture@example.invalid',
          displayName: '测试管理员',
          role: 'admin',
        },
      };
    else if (url.pathname === '/api/boss-login/status') value = status;
    else if (url.pathname === '/api/boss-login/refresh') {
      const data = JSON.parse(r.postData() || '{}');
      posts.push(data);
      status = {
        ...status,
        loginMethod: data.loginMethod || status.loginMethod,
        appLoginRequired: false,
        message:
          data.loginMethod === 'boss_app'
            ? '请使用 BOSS 直聘 App 扫码并确认登录。'
            : '请使用微信扫一扫。',
        imageUpdatedAt: new Date(
          Date.parse('2026-09-28T12:00:00Z') + ++serial * 1000,
        ).toISOString(),
      };
      value = { requestId: 'fixture' };
    } else if (url.pathname === '/api/boss-login/image') {
      imageCount++;
      return void new Promise((resolve) => setTimeout(resolve, 4500)).then(() =>
        r.respond({
          status: 200,
          headers,
          contentType: 'image/svg+xml',
          body: `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="698"><rect width="1100" height="698" fill="#f5f6f7"/><rect x="430" y="190" width="240" height="240" fill="white" stroke="#cbd5e1"/><text x="550" y="315" text-anchor="middle" font-family="sans-serif" font-size="24">${status.loginMethod === 'boss_app' ? 'BOSS App' : 'WeChat'} test QR</text></svg>`,
        }),
      );
    }
    return void r.respond({
      status: 200,
      headers,
      contentType: 'application/json',
      body: JSON.stringify(value),
    });
  }
  if (url.origin === origin) void r.continue();
  else void r.abort();
});
try {
  await page.goto(origin + '/boss-login');
  await page.waitForSelector('[data-testid="boss-login-app"]', {
    timeout: 15000,
  });
  await page.waitForSelector('img[alt*="微信小程序"]');
  await page.click('[data-testid="boss-login-app"]');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="boss-login-app"]')
        ?.getAttribute('aria-pressed') === 'true' &&
      document.querySelector('img[alt*="App 登录"]'),
  );
  assert.equal(posts.at(-1).loginMethod, 'boss_app');
  assert.equal(
    imageCount,
    2,
    'slow images must not be restarted by status polling',
  );
  await page.click('[data-testid="boss-login-wechat"]');
  await page.waitForSelector('img[alt*="微信小程序"]');
  assert.equal(posts.at(-1).loginMethod, 'wechat');
  const before = imageCount;
  status = {
    ...status,
    appLoginRequired: true,
    message: 'BOSS 要求此账号使用 BOSS 直聘 App 扫码登录。',
    imageUpdatedAt: '2026-09-28T12:05:00Z',
  };
  await page.waitForFunction(
    () => document.body.innerText.includes('需要 App 扫码'),
    { timeout: 10000 },
  );
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="boss-login-wechat"]')?.disabled ===
      true,
  );
  assert.ok(imageCount > before, 'poll must update changed screenshots');
  await page.setViewport({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  status = {
    ...status,
    state: 'risk_controlled',
    appLoginRequired: false,
    imageAvailable: false,
    message: '请完成安全验证。',
  };
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="boss-login-app"]')?.disabled ===
      true,
    { timeout: 10000 },
  );
  assert.equal(await page.$('img[alt*="登录二维码"]'), null);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, posts, imageCount, errors }));
} finally {
  await browser.close();
}
