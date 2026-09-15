import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import {
  createDatabase,
  assertIsolatedTestDatabase,
  DepartmentAtsRepository,
  BossForgeRepository,
  CommunicationRepository,
  LifecycleRepository,
} from '../../../packages/data/src/index.ts';
import { lifecycleRoutes } from '../../control-api/src/lifecycle-routes.ts';
import { sendQueuedBossChat } from './boss-communication.ts';
assertIsolatedTestDatabase(process.env, { contactSideEffects: true });
const sql = createDatabase(),
  ats = new DepartmentAtsRepository(sql),
  repo = new BossForgeRepository(sql),
  chat = new CommunicationRepository(sql),
  life = new LifecycleRepository(sql);
const [u] = await sql`SELECT * FROM users WHERE role='admin' LIMIT 1`;
assert(u, 'Run the lifecycle integration fixture first');
const principal = {
  userId: u.id,
  departmentId: u.department_id,
  email: u.email,
  displayName: u.display_name,
  role: 'admin',
};
const suffix = randomUUID(),
  accountId = `lifecycle-ui-${suffix}`;
const interviewer = await ats.createUser(principal, {
  email: `ui-interviewer-${suffix}@example.com`,
  displayName: '本次验收面试官',
  role: 'interviewer',
  password: 'Lifecycle-Ui-Test-Only!',
});
const position = await repo.createPosition({
  bossAccountId: accountId,
  name: '海外业务运营（界面验收）',
  ownerName: principal.displayName,
});
await sql`UPDATE positions SET department_id=${principal.departmentId},owner_user_id=${principal.userId},boss_job_id='lifecycle-ui-job' WHERE id=${position.id}`;
await chat.saveInbox(accountId, {
  fetchedAt: new Date().toISOString(),
  conversations: [
    {
      geekId: `ui-geek-${suffix}`,
      candidateName: '林知夏（虚构验收）',
      bossJobId: 'lifecycle-ui-job',
      positionName: position.name,
      preview: '对岗位有兴趣',
      lastMessageAt: new Date().toISOString(),
      timeLabel: '刚刚',
      unreadCount: 1,
    },
  ],
});
const target = (await chat.targets(principal)).find(
  (t) => t.bossAccountId === accountId,
);
assert(target);
const web = new URL('../../web/', import.meta.url).pathname,
  requireWeb = createRequire(path.join(web, 'package.json'));
const { createServer } = await import(requireWeb.resolve('vite'));
const { default: react } = await import(
  requireWeb.resolve('@vitejs/plugin-react')
);
const { default: tailwind } = await import(
  requireWeb.resolve('@tailwindcss/postcss')
);
const dir = await mkdtemp(path.join(web, '.lifecycle-fixture-')),
  output = new URL(
    '../../../artifacts/recruitment-lifecycle-20260911/',
    import.meta.url,
  ).pathname;
await mkdir(output, { recursive: true });
await writeFile(
  path.join(dir, 'index.html'),
  '<html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="./fixture.tsx"></script></html>',
);
await writeFile(
  path.join(dir, 'fixture.tsx'),
  `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{AuthGate}from'../app/auth-gate';import{LifecycleWorkspace}from'../app/lifecycle/lifecycle-workspace';import{LifecycleDialog}from'../app/lifecycle/lifecycle-dialog';import{Button}from'../components/ui/button';import'../app/globals.css';sessionStorage.setItem('boss-forge.session-token','isolated-lifecycle-ui');function Fixture(){const[open,setOpen]=useState(false),[draft,setDraft]=useState(null);return <AuthGate><main className="mx-auto max-w-6xl space-y-6 p-5"><h1 className="text-2xl font-semibold">招聘流程</h1><Button type="button" onClick={()=>setOpen(true)}>从测试会话建档</Button><LifecycleWorkspace/><LifecycleDialog open={open} onOpenChange={setOpen} conversationId="${target.id}" onCompose={setDraft}/>{draft?<output data-preview>{draft.body}</output>:null}</main></AuthGate>};createRoot(document.getElementById('root')).render(<Fixture/>);`,
);
const server = await createServer({
  configFile: false,
  root: web,
  plugins: [
    {
      name: 'isolated-fixture-api',
      configureServer(server) {
        server.middlewares.use(fixtureApi);
      },
    },
    react(),
  ],
  resolve: { alias: { '@': web } },
  define: {
    'process.env.NEXT_PUBLIC_CONTROL_API_URL': '"http://127.0.0.1:3041"',
  },
  css: { postcss: { plugins: [tailwind()] } },
  server: { port: 3041, host: '127.0.0.1', strictPort: true },
  logLevel: 'warn',
});
let mutations = 0;
async function fixtureApi(req, res, next) {
  if (!req.url?.startsWith('/api/')) return next();
  const send = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  if (req.url === '/api/auth/me') return send(res, 200, { user: principal });
  try {
    if (req.method !== 'GET') mutations++;
    if (
      await lifecycleRoutes({
        request: req,
        response: res,
        url: new URL(req.url, 'http://127.0.0.1:3041'),
        principal,
        repository: life,
        send,
        readJson: async (request) => {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          return JSON.parse(Buffer.concat(chunks).toString());
        },
      })
    )
      return;
    send(res, 404, { message: 'Only isolated recruitment routes are enabled' });
  } catch (error) {
    send(res, 403, { message: error.message });
  }
}
await server.listen();
const browser = await puppeteer.launch({
  executablePath:
    process.env.CHROME_PATH ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.emulateTimezone('Asia/Shanghai');
await page.setRequestInterception(true);
page.on('request', (req) => {
  const url = new URL(req.url());
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return req.abort();
  return req.continue();
});
const waitText = (text) =>
  page.waitForFunction(
    (t) => document.body.innerText.includes(t),
    { timeout: 15000 },
    text,
  );
const click = async (text) => {
  const h = await page.waitForFunction(
    (t) =>
      Array.from(document.querySelectorAll('button')).find(
        (b) =>
          b.textContent.trim() === t &&
          !b.disabled &&
          b.getBoundingClientRect().height > 0,
      ),
    { timeout: 15000 },
    text,
  );
  await h.asElement().click();
  await h.dispose();
};
const fill = (selector, value) =>
  page.$eval(
    selector,
    (el, v) => {
      Object.getOwnPropertyDescriptor(
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype,
        'value',
      ).set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    value,
  );
const local = (hours) =>
  new Date(Date.now() + hours * 3600_000)
    .toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })
    .replace(' ', 'T')
    .slice(0, 16);
const day = new Date().toLocaleDateString('sv-SE', {
  timeZone: 'Asia/Shanghai',
});
const shot = async (name) => {
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
    'No horizontal overflow',
  );
  await page.screenshot({ path: path.join(output, name), fullPage: true });
};
let id, offerId;
try {
  await page.setViewport({ width: 1440, height: 1060 });
  await page.goto(`http://127.0.0.1:3041/${path.basename(dir)}/index.html`, {
    waitUntil: 'networkidle2',
  });
  await click('从测试会话建档');
  await waitText('建立招聘档案');
  await click('建档并开始跟进');
  await waitText('人工审核');
  await fill(
    'form:has(select[name="review"]) textarea[name="note"]',
    '人工核实岗位相关经历，符合面试条件',
  );
  await click('保存人工审核结论');
  await waitText('沟通中');
  id = (
    await sql`SELECT id FROM recruitment_cases WHERE conversation_id=${target.id}`
  )[0].id;
  await fill('input[name="due"]', local(0.5));
  await fill(
    'form:has(input[name="due"]) textarea[name="note"]',
    '跟进面试确认',
  );
  await click('保存跟进安排');
  await click('面试');
  await fill('input[name="starts"]', local(2));
  await fill('input[name="ends"]', local(3));
  await fill('input[name="location"]', '线上会议：测试会议室');
  await page.click(`input[name="interviewer"][value="${interviewer.id}"]`);
  await click('保存面试安排');
  await waitText('预览面试邀请');
  await click('预览面试邀请');
  await waitText('发送前预览');
  assert.equal(
    (
      await sql`SELECT count(*)::int AS n FROM communication_messages WHERE conversation_id=${target.id} AND sender_id IS NOT NULL`
    )[0].n,
    0,
  );
  await shot('interview-desktop.png');
  await click('填入聊天发送');
  await page.waitForSelector('[data-preview]');
  assert(
    (await page.$eval('[data-preview]', (e) => e.textContent)).includes(
      '请回复确认',
    ),
  );
  await click('从测试会话建档');
  await waitText('负责人：');
  await click('Offer');
  await fill('input[name="salary"]', '12000');
  await fill('input[name="months"]', '13');
  await fill('input[name="start"]', day);
  await fill('input[name="expires"]', local(48));
  await fill('textarea[name="terms"]', '工作地点上海，具体安排双方确认');
  await click('保存 Offer 草稿');
  await waitText('提交 Offer 审批');
  await click('提交 Offer 审批');
  await waitText('待审批');
  await page.select('select[name="action"]', 'approve');
  await fill(
    'form:has(select[name="action"]) textarea[name="note"]',
    '预算已核实，批准此录用邀请',
  );
  await click('保存 Offer 操作');
  await waitText('已批准 · 待发送');
  await click('预览录用邀请');
  await waitText('税前月薪 12000.00');
  await shot('offer-preview-desktop.png');
  await page.setViewport({ width: 375, height: 812 });
  await shot('offer-preview-mobile.png');
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await shot('offer-preview-mobile-dark.png');
  await page.setViewport({ width: 812, height: 375 });
  await page.emulateMediaFeatures([
    { name: 'prefers-reduced-motion', value: 'reduce' },
  ]);
  await shot('offer-preview-landscape.png');
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await page.setViewport({ width: 1440, height: 1060 });
  await page.keyboard.press('Escape');
  const offer = (await life.detail(principal, id)).offers[0];
  offerId = offer.id;
  const draft = await life.delivery(principal, id, {
    kind: 'offer',
    recordId: offer.id,
    version: offer.version,
  });
  for (const [scopeType, scopeId] of [
    ['global', 'global'],
    ['department', principal.departmentId],
    ['position', position.id],
  ])
    await ats.setContactControl(principal, {
      scopeType,
      scopeId,
      enabled: true,
      approvalRequired: false,
      emergencyStop: false,
      policy: { testOnly: true },
    });
  const queued = await chat.createOutgoing(
    principal,
    target.id,
    draft.body,
    randomUUID(),
    { ...draft.delivery, caseId: id },
  );
  await sendQueuedBossChat(queued.id, accountId, {
    repository: chat,
    open: async () => {},
    send: async (geekId, body) => ({
      schemaVersion: 1,
      kind: 'contact-provider-receipt',
      actionKind: 'message',
      candidateId: geekId,
      bodySha256: createHash('sha256').update(body).digest('hex'),
      clientMid: 'ui-client',
      serverMid: 'ui-server',
      providerConversationId: 'ui-native-thread',
      acceptedAt: new Date().toISOString(),
    }),
  });
  await click('从测试会话建档');
  await waitText('负责人：');
  await click('Offer');
  await waitText('已发送 · 待答复');
  await page.select('select[name="action"]', 'accept');
  await fill(
    'form:has(select[name="action"]) textarea[name="note"]',
    '候选人已明确回复接受，测试记录',
  );
  await click('保存 Offer 操作');
  await waitText('候选人已接受');
  await click('入职');
  await waitText('确认入职日期');
  assert.equal(
    await page.$eval('form:has(input[name="date"]) button', (b) => b.disabled),
    true,
  );
  for (let i = 0; i < 3; i++) {
    const form = await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('form')).find((f) =>
        Array.from(f.querySelectorAll('button')).some(
          (b) => b.textContent.trim() === '确认此项完成',
        ),
      ),
    );
    await form.asElement().$eval('input[name="note"]', (el) => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      ).set.call(el, '已核实（虚构验收）');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const button = await form.asElement().$('button');
    await button.click();
    await page.waitForFunction(
      (expected) =>
        Array.from(document.querySelectorAll('button')).filter(
          (b) => b.textContent.trim() === '重新标记待完成',
        ).length === expected,
      { timeout: 15000 },
      i + 1,
    );
    await form.dispose();
  }
  await fill('input[name="date"]', day);
  await fill(
    'form:has(input[name="date"]) textarea[name="note"]',
    '已实际到岗（虚构验收）',
  );
  await click('确认已入职');
  await waitText('实际入职：');
  await shot('onboarding-completed.png');
  assert.equal((await life.detail(principal, id)).application.stage, 'hired');
  assert.deepEqual(errors, []);
  const result = {
    ok: true,
    realDatabase: true,
    filingReviewFollowup: true,
    interviewPreviewWithoutSend: true,
    offerApprovalAndPreview: true,
    acceptanceAfterSyntheticReceipt: true,
    requiredOnboardingChecklist: true,
    desktop1440: true,
    mobile375: true,
    dark: true,
    landscape: true,
    reducedMotion: true,
    noPageErrors: true,
    mutations,
    realBossMessages: 0,
  };
  await writeFile(
    path.join(output, 'lifecycle-ui-results.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} catch (error) {
  await page.screenshot({
    path: path.join(output, 'lifecycle-failure.png'),
    fullPage: true,
  });
  console.error(await page.$eval('body', (e) => e.innerText));
  throw error;
} finally {
  await browser.close();
  await server.close();
  await rm(dir, { recursive: true, force: true });
  await sql.end();
}
