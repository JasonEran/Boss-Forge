import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { ensureWechatLoginQr } from "./wechat-login.js";

// Isolated native Chromium fixture: every document is intercepted and there is
// no live BOSS traffic, cookie import, phone verification or candidate contact.
const fixture = String.raw`<!doctype html><html><body><main></main><script>
window.actions = []; let serial = 0;
function render(mode, expired) {
  const root = document.querySelector('main');
  if (mode === 'app') {
    root.innerHTML = '<div class="qr-img-box"><img alt="App code"></div><button class="btn-sign-switch phone-switch">验证码登录/注册</button>';
    root.querySelector('button').onclick = () => { actions.push('phone'); render('sms'); };
  } else if (mode === 'sms') {
    root.innerHTML = '<a href="#" class="wx-login-btn" ka="wx_signin">微信登录/注册</a>';
    root.querySelector('a').onclick = event => {
      event.preventDefault(); actions.push('wechat');
      if (new URL(location.href).searchParams.has('redirect')) {
        history.replaceState(null, '', '/web/chat/job/list'); root.innerHTML = '已登录'; return;
      }
      render('wechat');
    };
  } else {
    serial++;
    const src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="280" height="280"><text x="10" y="40">fixture ' + serial + '</text></svg>');
    root.innerHTML = '<div class="scan-wx-wrapper"><div class="mini-app-login"><img class="mini-qrcode" src="' + src + '"></div><a href="#" class="sms-login-btn">验证码登录/注册</a></div>';
    root.querySelector('a').onclick = event => { event.preventDefault(); actions.push('sms'); render('sms'); };
    if (expired) {
      const overlay = document.createElement('div'); overlay.className = 'mini-overdue';
      overlay.innerHTML = '<button ka="refresh_miniapp_sao_qrcode">点击刷新</button>';
      root.firstChild.appendChild(overlay);
      overlay.querySelector('button').onclick = () => {
        actions.push('refresh'); overlay.textContent = '刷新中';
        setTimeout(() => render('wechat'), 80);
      };
    }
  }
}
const params = new URL(location.href).searchParams;
render(params.get('mode') || 'app', params.has('expired'));
</script></body></html>`;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
});
try {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on("request", request => {
    if (request.resourceType() === "document") {
      void request.respond({ status: 200, contentType: "text/html", body: fixture });
    } else if (request.url().startsWith("data:")) {
      void request.continue();
    } else {
      void request.abort();
    }
  });
  const cases = [
    { name: "App QR switches to WeChat", path: "/web/user/?mode=app", refresh: false, actions: ["phone", "wechat"] },
    { name: "SMS enters WeChat", path: "/web/user/?mode=sms", refresh: false, actions: ["wechat"] },
    { name: "existing WeChat code is reused", path: "/web/user/?mode=wechat", refresh: false, actions: [] },
    { name: "expired WeChat code refreshes once", path: "/web/user/?mode=wechat&expired=1", refresh: false, actions: ["refresh"] },
    { name: "manual refresh stays in WeChat", path: "/web/user/?mode=wechat", refresh: true, actions: ["sms", "wechat"] },
    { name: "manual expired refresh requests once", path: "/web/user/?mode=wechat&expired=1", refresh: true, actions: ["refresh"] },
    { name: "login redirect returns for verification", path: "/web/user/?mode=sms&redirect=1", refresh: false, actions: ["wechat"] },
    { name: "authenticated page is preserved", path: "/web/chat/job/list", refresh: true, actions: [] },
    { name: "verification page is preserved", path: "/web/passport/verify", refresh: true, actions: [] }
  ];
  for (const test of cases) {
    await page.goto("https://www.zhipin.com" + test.path);
    await ensureWechatLoginQr(page, test.refresh);
    const actions = await page.evaluate("window.actions");
    assert.deepEqual(actions, test.actions, test.name);
    if (page.url().includes("/web/user")) {
      assert.equal(await page.$eval(".mini-qrcode", element => (element as HTMLImageElement).naturalWidth), 280);
      assert.equal(await page.$(".qr-img-box"), null);
    }
    console.log(JSON.stringify({ ok: true, test: test.name }));
  }
} finally {
  await browser.close(); // This fixture owns its isolated browser, never production.
}
