import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
const web = new URL('../../web/', import.meta.url).pathname;
const requireWeb = createRequire(path.join(web, 'package.json'));
const { createServer } = await import(requireWeb.resolve('vite'));
const { default: react } = await import(
  requireWeb.resolve('@vitejs/plugin-react')
);
const { default: tailwind } = await import(
  requireWeb.resolve('@tailwindcss/postcss')
);
const dir = await mkdtemp(path.join(web, '.communication-fixture-'));
const output = new URL(
  '../../../artifacts/new-features-audit-20260911/communication-ui/',
  import.meta.url,
).pathname;
await mkdir(output, { recursive: true });
await writeFile(
  path.join(dir, 'index.html'),
  '<html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="./fixture.tsx"></script></html>',
);
await writeFile(
  path.join(dir, 'fixture.tsx'),
  `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{CommunicationPage}from'../app/communication/communication-client';import{DashboardProvider}from'../app/dashboard-state';import'../app/globals.css';sessionStorage.setItem('boss-forge.session-token','isolated-ui-fixture');function Fixture(){const[chat,setChat]=useState(true);return <DashboardProvider><button data-fixture-toggle type='button' style={{position:'fixed',left:220,top:0,zIndex:200}} onClick={()=>setChat(!chat)}>{chat?'测试切回筛选':'测试进入沟通'}</button>{chat?<CommunicationPage/>:<p>筛选页面</p>}</DashboardProvider>};createRoot(document.getElementById('root')).render(<Fixture/>);`,
);
const server = await createServer({
  configFile: false,
  root: web,
  plugins: [react()],
  resolve: { alias: { '@': web } },
  define: {
    'process.env.NEXT_PUBLIC_CONTROL_API_URL': '"http://127.0.0.1:3039"',
  },
  css: { postcss: { plugins: [tailwind()] } },
  server: { port: 3039, host: '127.0.0.1', strictPort: true },
  logLevel: 'warn',
});
await server.listen();
const browser = await puppeteer.launch({
  executablePath:
    process.env.CHROME_PATH ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage();
const errors = [];
const sends = [];
const onlineReads = [];
const analysisStates={},captureTimes={};let analyzeRetries=0;
const resumeAccepts=[];let attachmentAvailable=false;let attachmentReads=0;
const pdfObjects=['<</Type /Catalog /Pages 2 0 R>>','<</Type /Pages /Kids [3 0 R] /Count 1>>','<</Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources <</Font <</F1 4 0 R>>>> /Contents 5 0 R>>','<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>'];
const pdfStream='BT /F1 24 Tf 72 740 Td (Resume preview test) Tj ET';pdfObjects.push(`<</Length ${pdfStream.length}>>\nstream\n${pdfStream}\nendstream`);
let pdf='%PDF-1.7\n';const offsets=[0];pdfObjects.forEach((obj,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`;});const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<</Size ${offsets.length} /Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
const resumePdf=Buffer.from(pdf);

let failSend = false;
let stale = false;
const leases = new Set();
let browserReady = false;
const modeActions = [];
let liveSyncs = 0;
const quickReplies = [],
  wechatRequests = [],
  threadReads = [];
let inboxFailures = 0;
const wechatActions = {},
  resumeActions = {},
  resumeRequests = [];
page.on('pageerror', (error) => errors.push(error.message));
const conversations = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    candidateName: '林知夏',
    positionName: '海外内容运营',
    positionId: 'position-1',
    lastMessage: '好的，明天下午三点我有时间。',
    lastMessageAt: '2026-09-10T01:35:00.000Z',
    unreadCount: 2,
    syncedAt: '2026-09-10T01:35:00.000Z',
    canReply: true,
    replyBlockedReason: null,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    candidateName: '陈思远',
    positionName: 'AI 自动化工程师',
    positionId: 'position-2',
    lastMessage: '谢谢，我整理一下项目说明发给你。',
    lastMessageAt: '2026-09-10T01:28:00.000Z',
    unreadCount: 0,
    syncedAt: '2026-09-10T01:28:00.000Z',
    canReply: true,
    replyBlockedReason: null,
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    candidateName: '周予安',
    positionName: '亚马逊运营',
    positionId: 'position-3',
    lastMessage: '已收到，谢谢。',
    lastMessageAt: '2026-09-09T09:15:00.000Z',
    unreadCount: 0,
    syncedAt: '2026-09-09T09:15:00.000Z',
    canReply: false,
    replyBlockedReason: '此候选人已设为禁止联系。',
  },
];
const message = (id, body, direction, minute, status = 'sent') => ({
  id,
  body,
  direction,
  kind: 'text',
  sentAt: `2026-09-10T01:${minute}:00.000Z`,
  receivedAt: `2026-09-10T01:${minute}:00.000Z`,
  status,
  error: null,
});
const histories = {
  [conversations[0].id]: [
    message(
      'm1',
      '你好，知夏。我看了你的英文内容作品，想和你聊聊海外内容运营这个岗位。',
      'outbound',
      '20',
    ),
    message(
      'm2',
      '你好！我最近也在关注海外内容方向的机会。\n方便介绍一下团队现在重点做哪些市场吗？',
      'inbound',
      '24',
    ),
    message(
      'm3',
      '目前以欧美市场为主，我们希望把内容策划、英文输出和渠道复盘连起来做。\n如果方便，明天下午三点可以先线上聊一下。',
      'outbound',
      '30',
    ),
    message('m4', '好的，明天下午三点我有时间。', 'inbound', '35'),
  ],
  [conversations[1].id]: [
    message('b1', '谢谢，我整理一下项目说明发给你。', 'inbound', '28'),
  ],
  [conversations[2].id]: [message('c1', '已收到，谢谢。', 'inbound', '15')],
};
const connection = { connected: true, canSend: true, message: 'BOSS 已连接' };
const thread = (id) => ({
  conversation: conversations.find((c) => c.id === id),
  messages: histories[id],
  attachmentAvailable,
  hasOlder: false,
  before: histories[id][0]?.id ?? null,
  historyLimited: true,
  wechat: wechatActions[id]
    ? { state: 'pending', reason: '微信交换已申请，等待对方确认。' }
    : { state: 'available', reason: '通过 BOSS 发起微信交换。' },
  wechatAction: wechatActions[id] ?? null,
  resume: {
    state: resumeActions[id] ? 'pending' : 'available',
    reason: resumeActions[id] ? '简历请求已发出，等待对方回复。' : '',
  },
  resumeAction: resumeActions[id] ?? null,
  contacts:
    id === conversations[0].id
      ? [
          {
            kind: 'wechat',
            value: 'fixture_wx_01',
            providerMessageId: 'contact-fixture',
          },
        ]
      : [],
});
await page.setRequestInterception(true);
page.on('request', async (req) => {
  const u = new URL(req.url());
  if (['chrome-extension:', 'chrome:', 'data:'].includes(u.protocol))return req.continue();
  if (
    u.protocol === 'blob:' &&
    req.url().startsWith('blob:http://127.0.0.1:3039/')
  )
    return req.continue();
  if (!['localhost', '127.0.0.1'].includes(u.hostname)) return req.abort();
  if (u.pathname.includes('/assets/')) {
    assert.equal(req.headers().authorization, 'Bearer isolated-ui-fixture');
    return req.respond({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        'base64',
      ),
    });
  }
  if (!u.pathname.startsWith('/api/')) return req.continue();
  if (
    req.method() === 'POST' &&
    u.pathname.startsWith('/api/communication/') &&
    (u.pathname.endsWith('/sync') ||
      u.pathname.endsWith('/messages') ||
      u.pathname.endsWith('/wechat') ||
      u.pathname.endsWith('/request-resume') || u.pathname.endsWith('/accept-resume') || u.pathname.endsWith('/attachment-resume'))
  ) {
    assert(browserReady, 'No live request before handoff');
    assert(
      leases.has(req.headers()['x-boss-communication-lease']),
      'Live requests require this page lease',
    );
    liveSyncs++;
  }
  if (u.pathname.endsWith('/attachment-resume')) {attachmentReads++;return req.respond({status:200,contentType:'application/pdf',body:resumePdf});}
  if(/online-resume\/0$/.test(u.pathname))return req.respond({status:200,contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')});
  const online = u.pathname.match(/conversations\/([^/]+)\/online-resume(\/analyze)?$/);
  if (online) {
    const id=online[1], c=conversations.find(c=>c.id===id);
    if(req.method()==='POST') {
      if(online[2]){analyzeRetries++;analysisStates[id]='pending';}
      else{assert(leases.has(req.headers()['x-boss-communication-lease']));onlineReads.push(id);analysisStates[id]='pending';captureTimes[id]=new Date().toISOString();}
    }
    const analyzed=analysisStates[id]==='ready',state=analysisStates[id]??'pending';
    return req.respond({status:online[2]?202:200,contentType:'application/json',body:JSON.stringify({conversationId:id,positionId:c.positionId,positionName:c.positionName,ruleVersion:2,qualification:{status:analyzed||id===conversations[1].id?'positive':'unknown',reason:analyzed?'已识别到符合证据':'未识别到符合证据'},resume:onlineReads.includes(id)?{captureId:'test-capture',capturedAt:captureTimes[id],text:analyzed?'教育经历：英语专业本科，已通过英语专业八级。':'',textStatus:state,analysisVersion:analyzed?5:state==='unavailable'?3:analyzeRetries?4:1,complete:true,parts:[{index:0,width:1,height:1}]}:null,requirements:[{id:'tem8',label:'英语专业八级（TEM-8）',group:'全部条件',status:analyzed?'positive':'unknown',evidence:analyzed?['已通过英语专业八级']:[],explanation:analyzed?'识别到专八持证表述':'岗位要求尚未识别',question:'你好，是否已通过英语专业八级？'}]})});
  }
  let status = 200,
    body = {};
  if (u.pathname === '/api/auth/me')
    body = {
      user: {
        userId: 'fixture',
        departmentId: 'fixture',
        email: 'fixture@example.com',
        displayName: '招聘负责人',
        role: 'admin',
      },
    };
  else if (u.pathname === '/api/workspace/activity') {
    if (req.method() === 'POST') {
      const input = JSON.parse(req.postData());
      modeActions.push(input.action);
      if (input.action === 'enter') leases.add(input.leaseId);
      if (input.action === 'leave') leases.delete(input.leaseId);
      body = {
        active: leases.has(input.leaseId),
        ready: browserReady,
        screeningPaused: leases.size > 0,
      };
    } else body = { screeningPaused: leases.size > 0 };
  } else if (u.pathname === '/api/dashboard')
    body = {
      tasks: [],
      positions: [],
      candidates: [],
      contactIntents: [],
      activeRules: [],
      latestRules: [],
      runtime: {
        consistent: true,
        workerHeartbeatFresh: true,
        browserAuthenticated: true,
      },
    };
  else if (
    ['/api/communication/conversations', '/api/communication/sync'].includes(
      u.pathname,
    )
  ) {
    if (u.pathname.endsWith('/sync') && inboxFailures > 0) {
      inboxFailures--;
      status = 409;
      body = { message: '列表暂不可用，将自动重试。' };
    } else
      body = {
        conversations,
        connection,
        syncedAt: new Date().toISOString(),
        coverageLimited: false,
      };
  } else if (u.pathname.startsWith('/api/communication/quick-replies')) {
    const id = u.pathname.split('/')[4];
    if (req.method() === 'GET') body = { quickReplies };
    else if (req.method() === 'DELETE') {
      quickReplies.splice(
        quickReplies.findIndex((p) => p.id === id),
        1,
      );
      body = { ok: true };
    } else {
      const input = JSON.parse(req.postData()),
        item = {
          id: id ?? '44444444-4444-4444-8444-444444444444',
          body: input.body,
          updatedAt: new Date().toISOString(),
        };
      const index = quickReplies.findIndex((p) => p.id === item.id);
      if (index >= 0) quickReplies.splice(index, 1, item);
      else quickReplies.push(item);
      body = { quickReply: item };
    }
  } else {
    const match = u.pathname.match(
      /\/conversations\/([^/]+)(?:\/(sync|messages|read|wechat|request-resume|accept-resume))?$/,
    );
    if (match) {
      const [, id, action] = match;
      if (action === 'read') {
        conversations.find((c) => c.id === id).unreadCount = 0;
        body = { ok: true };
      } else if (action === 'accept-resume') {
        const input=JSON.parse(req.postData());assert.equal(input.confirmed,true);assert(input.messageId);
        const m=histories[id].find(m=>m.id===input.messageId);assert(m?.resumeOffer?.state==='pending');
        resumeAccepts.push({id,messageId:input.messageId,key:req.headers()['idempotency-key']});
        m.resumeOffer={state:'handled',action:{id:'accept-1',status:'sent',error:null}};
        attachmentAvailable=true;body=thread(id);status=202;
      } else if (action === 'request-resume') {
        const input = JSON.parse(req.postData());
        assert.equal(input.confirmed, true);
        resumeRequests.push({ id, key: req.headers()['idempotency-key'] });
        resumeActions[id] = {
          id: '66666666-6666-4666-8666-666666666666',
          status: 'sent',
          error: null,
        };
        body = thread(id);
        status = 202;
      } else if (action === 'wechat') {
        const input = JSON.parse(req.postData());
        assert.equal(input.confirmed, true);
        wechatRequests.push({ id, key: req.headers()['idempotency-key'] });
        wechatActions[id] = {
          id: '55555555-5555-4555-8555-555555555555',
          status: 'sent',
          error: null,
        };
        body = thread(id);
        status = 202;
      } else if (action === 'messages') {
        const input = JSON.parse(req.postData());
        sends.push({
          id,
          body: input.body,
          key: req.headers()['idempotency-key'],
        });
        if (failSend) {
          status = 409;
          body = { message: '连接暂不可用，草稿已保留。' };
        } else {
          const outgoing = message(
            `sent-${sends.length}`,
            input.body,
            'outbound',
            '40',
          );
          histories[id].push(outgoing);
          body = { ...thread(id), outgoingId: outgoing.id };
          status = 202;
        }
      } else {
        if (action === 'sync') threadReads.push(id);
        body = structuredClone(thread(id));
        if (stale && id === conversations[0].id)
          await new Promise((resolve) => setTimeout(resolve, 900));
      }
    }
  }
  await req
    .respond({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
    .catch(() => {});
});
const click = async (label) => {
  const button = await page.waitForFunction(
    (label) =>
      Array.from(document.querySelectorAll('button')).find(
        (b) =>
          (b.getAttribute('aria-label') === label ||
            b.textContent.trim() === label) &&
          !b.disabled &&
          b.getBoundingClientRect().width > 0,
      ),
    { timeout: 15000 },
    label,
  );
  await button.asElement().click();
  await button.dispose();
};
const waitText = (text) =>
  page.waitForFunction(
    (text) => document.body.innerText.includes(text),
    { timeout: 15000 },
    text,
  );
const setValue = async (selector, value) =>
  page.$eval(
    selector,
    (el, value) => {
      Object.getOwnPropertyDescriptor(
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype,
        'value',
      ).set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    value,
  );
try {
  await page.setViewport({ width: 1440, height: 1060 });
  await page.goto(`http://127.0.0.1:3039/${path.basename(dir)}/index.html`, {
    waitUntil: 'networkidle2',
  });
  await waitText('等待当前简历保存');
  assert.equal(liveSyncs, 0);
  browserReady = true;
  await waitText('筛选已暂停');
  await click('与林知夏沟通');
  await waitText('你好！我最近也在关注');
  await page.waitForSelector('section[aria-label="聊天内容"] [aria-label="岗位条件：不符合"]');
  assert.equal(await page.$('aside[aria-label="会话列表"] [aria-label="岗位条件：不符合"]'),null);
  assert.equal(onlineReads.length,0,'Badge checks saved data without opening BOSS');
  await click('与林知夏沟通');
  await waitText('你好！我最近也在关注');
  assert(await page.$('[aria-label="岗位条件：不符合"]'),'Clicking the active conversation retains the badge');
  await page.screenshot({path:path.join(output,'personal-chat-red-badge.png'),fullPage:true});
  await click('与陈思远沟通');
  await page.waitForFunction(()=>document.querySelector('section[aria-label="聊天内容"] h2')?.textContent==='陈思远' && !document.querySelector('[aria-label="岗位条件：不符合"]'));
  await click('与林知夏沟通');
  await page.waitForSelector('[aria-label="岗位条件：不符合"]');
  // Fixed-height workspace leaves the majority of the viewport to actual messages.
  await page.setViewport({width:1366,height:768});
  const dimensions=await page.evaluate(()=>({log:document.querySelector('[role="log"]').getBoundingClientRect().height,overflow:document.documentElement.scrollHeight>innerHeight+1}));
  assert(dimensions.log>=330, JSON.stringify(dimensions));assert.equal(dimensions.overflow,false);
  await page.click('details summary');await click('AI 自动化工程师');
  assert.equal(await page.$('[aria-label="与林知夏沟通"]'),null);
  assert(await page.$('[aria-label="与陈思远沟通"]'));await click('全部岗位');await page.click('details summary');
  await click('在线简历');await waitText('从 BOSS 读取');assert.equal(onlineReads.length,0);
  await click('从 BOSS 读取');await waitText('已保存在线简历');await waitText('正在后台识别并分析岗位要求');await page.waitForFunction(()=>[...document.querySelectorAll('img[alt^="在线简历"]')].some(i=>i.complete&&i.naturalWidth>0));assert.deepEqual(onlineReads,[conversations[0].id]);
  await page.click('[aria-label="候选人资料视图"] button:last-child');await waitText('岗位要求尚未识别');
  await page.screenshot({path:path.join(output,'candidate-requirements-desktop.png'),fullPage:true});
  await page.setViewport({width:375,height:850});await page.waitForSelector('[role="dialog"]');await page.screenshot({path:path.join(output,'candidate-requirements-mobile.png'),fullPage:true});await page.setViewport({width:1366,height:768});await page.waitForSelector('aside[aria-label="候选人资料"]');
  await click('插入确认问题');assert.equal(sends.length,0);assert.match(await page.$eval('#communication-draft',e=>e.value),/是否已通过/);
  await setValue('#communication-draft','');
  await click('在线简历');await waitText('正在后台识别并分析岗位要求');
  analysisStates[conversations[0].id]='unavailable';await waitText('重试分析');
  await click('重试分析');await waitText('正在后台识别并分析岗位要求');assert.equal(analyzeRetries,1);assert.equal(onlineReads.length,1,'Retry analyzes the existing screenshot');
  analysisStates[conversations[0].id]='ready';await waitText('简历分析已完成');
  await page.waitForFunction(()=>!document.querySelector('[aria-label="岗位条件：不符合"]'));
  await page.click('[aria-label="候选人资料视图"] button:last-child');await waitText('有符合证据');
  await page.screenshot({path:path.join(output,'analysis-completed.png'),fullPage:true});
  await click('收起候选人资料');
  await page.setViewport({width:1440,height:1060});
  assert.equal(
    await page.$eval('button[type="submit"]', (b) => b.disabled),
    true,
  );
  await page.type('#communication-draft', '明天见！');
  await click('常用语');
  await waitText('我的常用语');
  await page.type('#quick-reply-body', '方便时可以发一份作品集。');
  await click('保存常用语');
  await waitText('已保存 1/50 条');
  await click('编辑这条常用语');
  await setValue('#quick-reply-body', '可以发一份作品集吗？');
  await click('保存修改');
  await click('可以发一份作品集吗？');
  await page.waitForFunction(
    () =>
      document.querySelector('#communication-draft')?.value ===
      '明天见！\n可以发一份作品集吗？',
  );
  assert.equal(sends.length, 0, 'Inserting a private quick reply never sends');
  await click('常用语');
  await waitText('可以发一份作品集吗？');
  await click('删除这条常用语');
  await waitText('还没有常用语');
  await page.keyboard.press('Escape');
  await setValue('#communication-draft', '明天见！');
  const unopenedReads = threadReads.filter(
    (id) => id === conversations[1].id,
  ).length;
  conversations[1].lastMessage = '未打开会话的新回复：作品已经整理好了。';
  conversations[1].unreadCount = 3;
  await waitText('未打开会话的新回复');
  await waitText('1 个未读会话');
  assert.equal(
    threadReads.filter((id) => id === conversations[1].id).length,
    unopenedReads,
    'Unread list updates without opening another chat',
  );
  assert.equal(
    await page.$eval('#communication-draft', (e) => e.value),
    '明天见！',
  );
  assert.match(
    await page.$eval('body', (e) => e.innerText),
    /\d{2}:\d{2}:\d{2} 同步/,
  );
  await page.$eval(
    '[data-fixture-toggle]',
    (node) => (node.style.visibility = 'hidden'),
  );
  await page.screenshot({
    path: path.join(output, 'communication-desktop.png'),
    fullPage: true,
  });
  await page.$eval(
    '[data-fixture-toggle]',
    (node) => (node.style.visibility = 'visible'),
  );
  await click('测试切回筛选');
  await waitText('筛选页面');
  await page.waitForFunction(
    () => !document.querySelector('#communication-draft'),
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(leases.size, 0);
  const pausedSyncs = liveSyncs;
  await new Promise((resolve) => setTimeout(resolve, 5500));
  assert.equal(liveSyncs, pausedSyncs, 'Leaving communication stops all syncs');
  await click('测试进入沟通');
  await waitText('筛选已暂停');
  await click('与林知夏沟通');
  await page.waitForFunction(
    () => document.querySelector('#communication-draft')?.value === '明天见！',
  );
  await page.$eval(
    '[data-fixture-toggle]',
    (node) => (node.style.display = 'none'),
  );
  await click('与陈思远沟通');
  await waitText('谢谢，我整理一下项目说明');
  assert.equal(await page.$eval('#communication-draft', (e) => e.value), '');
  await click('与林知夏沟通');
  await page.waitForFunction(
    () => document.querySelector('#communication-draft')?.value === '明天见！',
  );
  await page.$eval('#communication-draft', (el) =>
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
      }),
    ),
  );
  assert.equal(sends.length, 0, 'IME confirmation must not send');
  failSend = true;
  await click('发送');
  await waitText('草稿已保留');
  assert.equal(
    await page.$eval('#communication-draft', (e) => e.value),
    '明天见！',
  );
  failSend = false;
  await click('发送');
  await page.waitForFunction(
    () => document.querySelector('#communication-draft')?.value === '',
  );
  assert.equal(sends.length, 2);
  assert.equal(
    sends[0].key,
    sends[1].key,
    'network retry must reuse the same message identity',
  );
  assert.equal(sends[1].id, conversations[0].id);
  histories[conversations[0].id].push(
    message('new-incoming', '新回复：期待明天的交流。', 'inbound', '45'),
  );
  inboxFailures = 1;
  await waitText('新回复：期待明天的交流。');
  assert.equal(
    inboxFailures,
    0,
    'A failing inbox refresh does not block the selected chat',
  );
  await click('交换微信');
  await waitText('向 林知夏 申请交换微信');
  assert.equal(wechatRequests.length, 0);
  await click('取消');
  assert.equal(
    wechatRequests.length,
    0,
    'Cancelling never requests a WeChat exchange',
  );
  await click('交换微信');
  await click('通过 BOSS 申请交换微信');
  await waitText('微信已申请');
  assert.equal(wechatRequests.length, 1);
  assert.equal(wechatRequests[0].id, conversations[0].id);
  assert(wechatRequests[0].key);
  assert(
    await page.evaluate(
      () =>
        Array.from(document.querySelectorAll('button')).find(
          (b) => b.textContent.trim() === '微信已申请',
        ).disabled,
    ),
  );
  stale = true;
  await click('与陈思远沟通');
  await waitText('谢谢，我整理一下项目说明');
  await click('与林知夏沟通');
  await click('与陈思远沟通');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert(
    !(
      await page.$eval('[aria-label="聊天内容"]', (el) => el.innerText)
    ).includes('期待明天的交流'),
    'late responses must never appear in a different conversation',
  );
  stale = false;
  await click('与周予安沟通');
  await waitText('此候选人已设为禁止联系');
  await page.type('#communication-draft', '草稿');
  assert.equal(
    await page.$eval('button[type="submit"]', (b) => b.disabled),
    true,
  );
  await click('与林知夏沟通');
  await page.setViewport({ width: 375, height: 900 });
  await page.waitForFunction(() => {
    const log = document.querySelector('[role="log"]');
    return log && log.scrollHeight - log.scrollTop - log.clientHeight < 4;
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: path.join(output, 'communication-mobile.png'),
    fullPage: true,
  });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await click('常用语');
  await waitText('我的常用语');
  await page.type('#quick-reply-body', '这周方便安排一次线上沟通吗？');
  await click('保存常用语');
  await waitText('已保存 1/50 条');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: path.join(output, 'communication-quick-replies-mobile.png'),
    fullPage: true,
  });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.keyboard.press('Escape');
  await click('返回会话列表');
  await page.type('input[aria-label="搜索姓名"]', '不存在');
  await waitText('没有找到匹配会话');
  await page.$eval('input[aria-label="搜索姓名"]', (el) => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    ).set.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('与陈思远沟通');
  await page.type('#communication-draft', '移动端草稿');
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.emulateMediaFeatures([
    { name: 'prefers-reduced-motion', value: 'reduce' },
  ]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: path.join(output, 'communication-dark.png'),
    fullPage: true,
  });
  await page.setViewport({ width: 900, height: 375 });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.setViewport({ width: 1440, height: 1060 });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await click('与林知夏沟通');
  await click('在线简历');
  await waitText('微信：fixture_wx_01');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value) => {
          window.__copiedContact = value;
        },
      },
    });
  });
  await click('微信：fixture_wx_01');
  await waitText('已复制');
  assert.equal(
    await page.evaluate(() => window.__copiedContact),
    'fixture_wx_01',
  );
  await click('收起候选人资料');
  await click('求简历');
  await waitText('索取简历');
  assert.equal(resumeRequests.length, 0);
  await click('取消');
  assert.equal(resumeRequests.length, 0);
  await click('求简历');
  await click('通过 BOSS 索取简历');
  await waitText('已申请简历');
  assert.equal(resumeRequests.length, 1);
  // Previously captured screenshots resume their deferred analysis when opened.
  analysisStates[conversations[0].id]='skipped';
  await click('与陈思远沟通');await waitText('谢谢，我整理一下项目说明');
  await click('与林知夏沟通');await click('在线简历');
  await waitText('正在后台识别并分析岗位要求');assert.equal(analyzeRetries,2);assert.equal(onlineReads.length,1);
  analysisStates[conversations[0].id]='ready';await waitText('简历分析已完成');await click('收起候选人资料');
  histories[conversations[0].id].push({
    ...message('image-fixture', '[图片]', 'inbound', '49'),
    kind: 'image',
    assets: [{ index: 0, kind: 'image', name: '验收图片' }],
  });
  await waitText('预览图片');
  await click('预览图片');
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll('img')).some(
      (i) => i.alt === '验收图片' && i.complete && i.naturalWidth > 0,
    ),
  );
  await page.keyboard.press('Escape');
  await setValue('#communication-draft', '保留的普通聊天草稿');
  await page.evaluate(
    (conversationId) =>
      sessionStorage.setItem(
        'boss-forge.lifecycle-incoming:fixture:fixture',
        JSON.stringify({
          conversationId,
          body: '经过审批的录用邀请（虚构验收）',
          delivery: {
            caseId: '77777777-7777-4777-8777-777777777777',
            kind: 'offer',
            recordId: '88888888-8888-4888-8888-888888888888',
            version: 3,
          },
        }),
      ),
    conversations[0].id,
  );
  await page.$eval(
    '[data-fixture-toggle]',
    (node) => (node.style.display = 'block'),
  );
  await page.$eval(
    '[data-fixture-toggle]',
    (node) => (node.style.visibility = 'visible'),
  );
  await click('测试切回筛选');
  await click('测试进入沟通');
  await page.waitForFunction(
    () => document.querySelector('#communication-draft')?.readOnly === true,
  );
  assert.equal(
    await page.$eval('#communication-draft', (e) => e.value),
    '经过审批的录用邀请（虚构验收）',
  );
  await click('取消邀请草稿，恢复原消息');
  assert.equal(
    await page.$eval('#communication-draft', (e) => e.value),
    '保留的普通聊天草稿',
  );
  await click('与林知夏沟通');
  histories[conversations[0].id].push({...message('resume-offer','对方想发送附件简历给您，您是否同意','inbound','59'),kind:'card',resumeOffer:{state:'pending'}});
  await waitText('同意接收简历');
  await click('同意接收简历');await waitText('通过 BOSS 同意接收');assert.equal(resumeAccepts.length,0);
  await page.screenshot({path:path.join(output,'resume-consent-confirmation.png'),fullPage:true});
  await click('通过 BOSS 同意接收');await waitText('已同意接收简历');assert.equal(resumeAccepts.length,1);assert.equal(resumeAccepts[0].messageId,'resume-offer');
  await click('查看附件简历');await page.waitForSelector('iframe[title="林知夏的附件简历"]');assert.equal(attachmentReads,1);
  await page.waitForSelector('a[download="林知夏-附件简历.pdf"]');assert(await page.$eval('iframe[title="林知夏的附件简历"]',e=>e.getBoundingClientRect().width>600));
  await page.waitForFunction(()=>{const f=document.querySelector('iframe[title="林知夏的附件简历"]');return f?.contentDocument?.readyState==='complete';});
  await new Promise(resolve=>setTimeout(resolve,800));
  await page.screenshot({path:path.join(output,'attachment-preview-desktop.png'),fullPage:true});
  await page.setViewport({width:375,height:850});await page.screenshot({path:path.join(output,'attachment-preview-mobile.png'),fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(errors, []);
  const result = {
    resumeConsentRequiresConfirmation:true,attachmentPreviewAndDownload:true,imageBeforeAnalysis:true,analysisUpdatesAutomatically:true,analysisRetryWithoutRecapture:true,legacyCaptureAnalysisResumes:true,
    resumeNativeConfirmation: true,
    sharedContactCopy: true,
    authenticatedImagePreview: true,
    businessDraftFrozenAndRestored: true,

    ok: true,
    desktop1440: true,
    mobile375: true,
    landscape: true,
    darkMode: true,
    draftsAcrossConversations: true,
    liveIncomingRefresh: true,
    unopenedInboxUpdates: true,
    inboxFailureDoesNotBlockThread: true,
    quickReplyCrudAndAppend: true,
    wechatRequiresConfirmation: true,
    wechatPendingDisabled: true,
    staleConversationResponseRejected: true,
    imeEnterDoesNotSend: true,
    failedDraftPreserved: true,
    idempotencyKeyReused: true,
    doNotContactDisabled: true,
    noPageErrors: true,
    personalRedBadgeForUnknown:true,positiveConversationNotMarked:true,badgeUsesCachedResumeOnly:true,activeConversationBadgeRetained:true,
    messageAreaAt1366x768: dimensions.log,
    jobButtonsFilter:true,onlineResumeReadBoundToConversation:true,qualificationDraftDoesNotSend:true,
    realMessagesSent: 0,
    realWechatRequests: 0,
    waitsForCurrentResume: true,
    pausesSyncOnLeaving: true,
    draftsSurvivePageSwitch: true,
    modeActions,
  };
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} catch (error) {
  await page.screenshot({
    path: path.join(output, 'communication-failure.png'),
    fullPage: true,
  });
  console.error(
    JSON.stringify({
      errors,
      body: (await page.$eval('body', (el) => el.innerText)).slice(0, 3500),
    }),
  );
  throw error;
} finally {
  await browser.close();
  await server.close();
  await rm(dir, { recursive: true, force: true });
}
