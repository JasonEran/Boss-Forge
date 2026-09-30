/** Isolated Chromium fixture. Every page request is intercepted; no BOSS traffic. */
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { inspectBossBrowserSession } from "./session-health.js";

const browser = await puppeteer.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on("request", request => {
    void request.respond({ status: 200, contentType: "text/html", body: '<html><body><div class="user-name">Fixture Recruiter</div></body></html>' });
  });
  await page.goto("https://www.zhipin.com/web/chat/recommend");
  const port = Number(new URL(browser.wsEndpoint()).port);
  for (let i = 0; i < 3; i++) assert.equal((await inspectBossBrowserSession(port)).state, "authenticated");
  await page.goto("https://www.zhipin.com/web/user/safe/verify");
  assert.equal((await inspectBossBrowserSession(port)).state, "risk_controlled");
  await page.goto("https://www.zhipin.com/web/user/");
  assert.equal((await inspectBossBrowserSession(port)).state, "login_required");
  console.log(JSON.stringify({ ok: true, authenticatedProbes: 3, riskFailsClosed: true, loginRequiredDetected: true, realGreetingExecuted: false }));
} finally { await browser.close(); }
