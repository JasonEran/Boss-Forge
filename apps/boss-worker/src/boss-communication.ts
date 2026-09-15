import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { Page } from 'puppeteer-core';
import {
  bossChatOnlineResumeSchema,
  resumeViewPolicyFromEnvironment, resumeViewPolicyState, shanghaiDayStart,
  bossChatInboxSchema,
  bossChatSnapshotSchema,
  bossChatTargetSchema,
  realContactEnabled,
  contactDispatchModeFromEnvironment,
  type BossChatSnapshot,
  communicationSince,
  COMMUNICATION_INBOX_LIMIT,
} from '@boss-forge/contracts';
import {
  readResumeArtifact,
  BossBrowserControlError,
  getBossCliInstallation,
  parseBossContactProviderReceipt,
  type BossMessageProviderReceipt,
} from '@boss-forge/boss-cli-adapter';
import { prepareChatResumeLayout } from './chat-resume-layout.js';
import { chatAssetsScript } from './boss-chat-assets.js';
import { wechatCapabilityScript } from './boss-wechat.js';
import {
  BossForgeRepository,
  CommunicationRepository,
  M2Repository,
  createDatabase,
} from '@boss-forge/data';

async function browserTools() {
  const { packageRoot } = await getBossCliInstallation();
  const module = (path: string) =>
    import(pathToFileURL(`${packageRoot}/dist/${path}.js`).href);
  const session = (await module('common/boss_session_page')) as {
    withBossSessionPage<T>(action: (page: Page) => Promise<T>): Promise<T>;
  };
  const chat = (await module('toolset/chat')) as {
    runOpenCandidateChat(
      page: Page,
      target: string,
      exact: boolean,
    ): Promise<string>;
    readChatRowCandidateId(element: Element): string;
  };
  const list = (await module('toolset/list')) as {
    ensureChatListReady(page: Page): Promise<void>;
  };
  const send = (await module('toolset/send')) as {
    runSendChatMessage(options: {
      text: string;
      expectedCandidateTarget: string;
    }): Promise<string>;
  };
  return { session, chat, list, send };
}

/** Read the same observable state that backs BOSS's message list and delivery receipts. */
export function chatSnapshotScript(geekId: string): string {
  bossChatTargetSchema.parse(geekId);
  return `(() => {
    const visible = el => {const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden'};
    const hosts=Array.from(document.querySelectorAll('.conversation-message')).filter(visible);
    if(hosts.length!==1)throw new Error('CHAT_NOT_READY');
    const vm=hosts[0].__vue__, conversation=vm?.conversation$, list=vm?.list$;
    const id = value => value==null?'':String(value);
    const geekId=id(conversation?.encryptUid||conversation?.encryptGeekId);
    if(geekId!==${JSON.stringify(geekId)})throw new Error('CHAT_TARGET_MISMATCH');
    const providerConversationId=id(conversation?.uniqueId)||[id(conversation?.friendId||conversation?.uid),id(conversation?.friendSource)].filter(Boolean).join('-');
    if(!providerConversationId||!Array.isArray(list))throw new Error('CHAT_STATE_UNAVAILABLE');
    const contacts=[];
    const messages=list.slice(-500).flatMap(m=>{
      const self=m.isSelf===true||m.isSelf===1;
      const acknowledged=[1,2].includes(Number(m.status));
      const historyMid=m.received===true&&acknowledged?m.mid:'';
      const providerMessageId=id(m.serverMid||(self?historyMid:m.mid));
      let time=Number(m.time); if(time>0&&time<100000000000)time*=1000;
      if(!providerMessageId||!Number.isFinite(time)||time<=0||time>8640000000000000)return [];
      const type=String(m.type||'');
      const kind=Number(m.messageType)===4||Number(m.bizType)===21050004?'system':type==='text'?'text':/image|picture|photo/i.test(type)?'image':/file|resume/i.test(type)?'file':/system|notice/i.test(type)?'system':'card';
      const body=typeof m.text==='string'&&m.text?m.text:({image:'[图片]',file:'[附件]',card:'[互动卡片]',system:'[系统消息]',text:'[空消息]'})[kind];
      const rich=${chatAssetsScript()};contacts.push(...rich.contacts);
      const offer=!self&&type==='dialog'&&Number(m.dialog?.type)===2&&/发送附件简历/.test(body)?{state:m.dialog.operated===true?'handled':'pending'}:undefined;
      const resumeAttachment=!self&&type==='hyperLink'&&[1,9].includes(Number(m.hyperLink?.hyperLinkType));
      return [{assets:rich.assets,resumeOffer:offer,resumeAttachment,providerMessageId,direction:kind==='system'?'system':self?'outbound':'inbound',kind,body:body.slice(0,10000),sentAt:new Date(time).toISOString(),delivery:self&&!acknowledged?'pending':'sent'}];
    });
    return {geekId,providerConversationId,fetchedAt:new Date().toISOString(),messages,historyLimited:true,attachmentAvailable:conversation?.resumeVisible===true||conversation?.resumeVisible===1,contacts:contacts.slice(-20),resume:${wechatCapabilityScript(false, 'resume')},wechat:${wechatCapabilityScript()}};
  })()`;
}

/** BOSS virtualizes rows inside an overflow:hidden list. Its native dataSources
 * and scroll methods cover loaded conversations that have no DOM row yet. */
export function chatInboxScript(
  geekIds: string[],
  action: 'read' | 'locate' | 'more' = 'read',
  since?: string,
): string {
  if (since && !Number.isFinite(Date.parse(since)))
    throw new Error('Invalid inbox date');
  geekIds.forEach((id) => bossChatTargetSchema.parse(id));
  return `(() => {
    const hosts=Array.from(document.querySelectorAll('.user-list')).filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0});
    if(hosts.length!==1)throw new Error('CHAT_LIST_NOT_READY');
    const vm=hosts[0].__vue__;
    if(vm?.$options?.name!=='boss-virtual-list'||!Array.isArray(vm.dataSources))throw new Error('CHAT_LIST_STATE_UNAVAILABLE');
    const stable=m=>{const ids=new Set([m?.encryptUid,m?.encryptFriendId,m?.encryptGeekId].filter(v=>typeof v==='string'&&v));return ids.size===1?[...ids][0]:''};
    const allowed=new Set(${JSON.stringify(geekIds)}), rows=vm.dataSources, cutoff=${since ? Date.parse(since) : 0};
    const conversations=rows.flatMap(m=>{
      const geekId=stable(m);if(m.del===true||Number(m.del)>0)return [];if(!/^[A-Za-z0-9_~-]{8,160}$/.test(geekId)||(allowed.size&&!allowed.has(geekId)))return [];
      let at=Number(m.lastTS);if(at>0&&at<100000000000)at*=1000;
      if(cutoff&&(!Number.isFinite(at)||at<cutoff||at>Date.now()+60000))return [];
      return [{geekId,unreadCount:Math.min(9999,Math.max(0,Math.trunc(Number(m.newMsgCount)||0))),
        preview:typeof m.lastText==='string'?m.lastText.slice(0,1000):'',timeLabel:typeof m.formateTime==='string'?m.formateTime.slice(0,100):'',
        ...(Number.isFinite(at)&&at>0&&at<8640000000000000?{lastMessageAt:new Date(at).toISOString()}: {}),
        ...(typeof m.name==='string'&&m.name.trim()?{candidateName:m.name.trim().slice(0,200)}:{}),
        ...(typeof m.encryptJobId==='string'?{bossJobId:m.encryptJobId.slice(0,256)}:{}),
        ...(typeof m.jobName==='string'?{positionName:m.jobName.slice(0,256)}:{}),
        ...(typeof m.uniqueId==='string'?{providerConversationId:m.uniqueId.slice(0,512)}:{})}];
    });
    if(${JSON.stringify(action)}==='locate'){
      const matches=rows.map((m,index)=>({id:stable(m),index})).filter(m=>allowed.has(m.id));
      if(matches.length!==1||typeof vm.scrollToIndex!=='function')throw new Error('CHAT_TARGET_NOT_FOUND');
      vm.scrollToIndex(matches[0].index);
    }else if(${JSON.stringify(action)}==='more'){
      if(typeof vm.scrollToBottom!=='function')throw new Error('CHAT_LIST_SCROLL_UNAVAILABLE');
      vm.scrollToBottom();
    }
    const deleted=m=>m.del===true||Number(m.del)>0;
    const times=rows.filter(m=>!(m.isTop===true||Number(m.isTop)>0)&&!deleted(m)).map(m=>{let t=Number(m.lastTS);return t>0&&t<100000000000?t*1000:t});
    const skippedCount=cutoff?rows.filter(m=>{
      if(deleted(m)||!/^[A-Za-z0-9_~-]{8,160}$/.test(stable(m)))return false;
      let t=Number(m.lastTS);if(t>0&&t<100000000000)t*=1000;
      return !Number.isFinite(t)||t<=0||t>Date.now()+60000||(t>=cutoff&&!(typeof m.name==='string'&&m.name.trim()));
    }).length:0;
    const chronological=times.length>0&&times.every((t,i)=>Number.isFinite(t)&&t>0&&(!i||t<=times[i-1]));
    return {loadedCount:rows.length,conversations,skippedCount,windowPassed:Boolean(cutoff&&chronological&&times[times.length-1]<cutoff)};
  })()`;
}

export async function ensureInboxReady(
  page: Page,
  ensure: (page: Page) => Promise<void>,
) {
  const ready = await page
    .evaluate(`(() => {
    if(location.pathname!=='/web/chat/index')return false;
    const list=document.querySelector('.user-list'), vm=list?.__vue__;
    if(!list||list.getBoundingClientRect().height<=0||!Array.isArray(vm?.dataSources))return false;
    const tabs=Array.from(document.querySelectorAll('.chat-message-filter-left span'));
    return tabs.some(t=>(t.textContent||'').replace(/\\s+/g,'').startsWith('全部')&&
      (/active|selected|current|checked/.test(String(t.className))||t.getAttribute('aria-selected')==='true'||t.closest('.active,.selected,.current,.checked')));
  })()`)
    .catch(() => false);
  if (!ready) await ensure(page);
}

export async function loadRecentInbox(page: Page) {
  const since = communicationSince(),
    deadline = Date.now() + 18_000;
  const collected = new Map<string, unknown>();
  let scannedCount = 0,
    coverageLimited = false;
  for (;;) {
    const state = (await page.evaluate(chatInboxScript([], 'read', since))) as {
      loadedCount: number;
      conversations: { geekId: string }[];
      windowPassed: boolean;
      skippedCount: number;
    };
    scannedCount = Math.max(scannedCount, state.loadedCount);
    for (const item of state.conversations) collected.set(item.geekId, item);
    coverageLimited ||=
      state.skippedCount > 0 || collected.size > COMMUNICATION_INBOX_LIMIT;
    if (state.windowPassed) break;
    if (
      Date.now() >= deadline ||
      collected.size >= COMMUNICATION_INBOX_LIMIT ||
      state.loadedCount >= 5_000
    ) {
      coverageLimited = true;
      break;
    }
    await page.evaluate(chatInboxScript([], 'more', since));
    const grew = await page
      .waitForFunction(
        (count) => {
          const vm = (
            document.querySelector('.user-list') as Element & {
              __vue__?: { dataSources?: unknown[] };
            }
          )?.__vue__;
          return (vm?.dataSources?.length ?? 0) > count;
        },
        { timeout: 2_500 },
        state.loadedCount,
      )
      .then((handle) => {
        void handle.dispose();
        return true;
      })
      .catch(() => false);
    if (!grew) {
      coverageLimited ||= state.loadedCount >= 100;
      break;
    }
  }
  return bossChatInboxSchema.parse({
    fetchedAt: new Date().toISOString(),
    windowStart: since,
    scannedCount,
    coverageLimited,
    conversations: [...collected.values()].slice(0, COMMUNICATION_INBOX_LIMIT),
  });
}

async function loadInbox(page: Page, geekIds: string[]) {
  const deadline = Date.now() + 18_000;
  for (;;) {
    const state = (await page.evaluate(chatInboxScript(geekIds))) as {
      loadedCount: number;
      conversations: unknown[];
    };
    const snapshot = bossChatInboxSchema.parse({
      fetchedAt: new Date().toISOString(),
      conversations: state.conversations,
    });
    if (
      snapshot.conversations.length >= geekIds.length ||
      Date.now() >= deadline
    )
      return snapshot;
    await page.evaluate(chatInboxScript(geekIds, 'more'));
    const grew = await page
      .waitForFunction(
        (count) => {
          const vm = (
            document.querySelector('.user-list') as Element & {
              __vue__?: { dataSources?: unknown[] };
            }
          )?.__vue__;
          return (vm?.dataSources?.length ?? 0) > count;
        },
        { timeout: 2500 },
        state.loadedCount,
      )
      .then((handle) => {
        void handle.dispose();
        return true;
      })
      .catch(() => false);
    if (!grew) return snapshot;
  }
}

export async function openExact(
  page: Page,
  geekId: string,
  tools: Awaited<ReturnType<typeof browserTools>>,
): Promise<void> {
  if (await page.evaluate(chatSnapshotScript(geekId)).catch(() => null)) return;
  await ensureInboxReady(page, tools.list.ensureChatListReady);
  const inbox = await loadInbox(page, [geekId]);
  if (!inbox.conversations.some((c) => c.geekId === geekId))
    throw new Error('CHAT_TARGET_NOT_FOUND');
  await page.evaluate(chatInboxScript([geekId], 'locate'));
  const pointScript = `(() => {
    const sourceId=${tools.chat.readChatRowCandidateId.toString()};
    const rows=Array.from(document.querySelectorAll('.geek-item-wrap')).filter(el=>sourceId(el)===${JSON.stringify(geekId)});
    if(rows.length!==1)return null;
    const r=rows[0].getBoundingClientRect(),v=document.querySelector('.user-list')?.getBoundingClientRect();
    if(!v||r.width<=0||r.height<=0||r.bottom<=v.top||r.top>=v.bottom)return null;
    return {x:r.left+r.width/2,y:(Math.max(r.top,v.top)+Math.min(r.bottom,v.bottom))/2};
  })()`;
  const ready = await page.waitForFunction(pointScript, { timeout: 5000 });
  await ready.dispose();
  const point = (await page.evaluate(pointScript)) as {
    x: number;
    y: number;
  } | null;
  if (!point) throw new Error('CHAT_TARGET_NOT_VISIBLE');
  await page.mouse.click(point.x, point.y);
  const selected = await page.waitForFunction(
    `(() => {try {return (${chatSnapshotScript(geekId)}) !== null;}catch{return false;}})()`,
    { timeout: 15000 },
  );
  await selected.dispose();
}

export async function readBossChat(geekId: string): Promise<BossChatSnapshot> {
  const tools = await browserTools();
  return tools.session.withBossSessionPage(async (page) => {
    await openExact(page, geekId, tools);
    return bossChatSnapshotSchema.parse(
      await page.evaluate(chatSnapshotScript(geekId)),
    );
  });
}

/** Only called by the supervisor under the shared account lock and a live chat lease. */
export async function readBossChatOnlineResume(geekId: string, accountId: string) {
  bossChatTargetSchema.parse(geekId);
  const sql = createDatabase();
  const policy = resumeViewPolicyFromEnvironment(process.env);
  const now = new Date();
  try {
    const usage = await new BossForgeRepository(sql).resumeViewUsage(accountId, shanghaiDayStart(now), new Date(now.getTime() - 3600000));
    if (resumeViewPolicyState(now, policy, usage) !== 'ready')
      throw new BossBrowserControlError('resume_limited', '简历查看额度或工作时间暂不允许读取。');
    const tools = await browserTools();
    const {packageRoot} = await getBossCliInstallation();
    const capture = await import(pathToFileURL(`${packageRoot}/dist/common/c_resume_capture.js`).href) as {
      findVisibleCResumeIframeHandle(page: Page): Promise<import("puppeteer-core").ElementHandle | null>;
      closeCResumePanel(page: Page): Promise<void>;
      waitForVisibleCResumeIframeReady(page: Page, timeout?: number): Promise<boolean>;
      captureCResumeIframeToFile(page: Page, viewport: ReturnType<Page['viewport']>, path: string): Promise<boolean>;
    };
    const {snapshotBossPageViewport} = await import(pathToFileURL(`${packageRoot}/dist/browser/index.js`).href) as {snapshotBossPageViewport(page: Page): Promise<ReturnType<Page['viewport']>>};
    const root = process.env.BOSS_FORGE_RESUME_SCREENSHOT_DIR?.trim() || join(homedir(), '.boss-cli', '.cache', 'resume-screenshots');
    await mkdir(root, {recursive:true, mode:0o700});
    const screenshotPath = join(root, `chat-${randomUUID()}.png`);
    await tools.session.withBossSessionPage(async page => {
      await capture.closeCResumePanel(page);
      const stalePanel = await capture.findVisibleCResumeIframeHandle(page);
      if (stalePanel) { await stalePanel.dispose(); throw new Error('ONLINE_RESUME_ALREADY_OPEN'); }
      await openExact(page, geekId, tools);
      const viewport = await snapshotBossPageViewport(page);
      // The chat modal needs enough viewport room for its native canvas.
      const buttons = await page.$$('.resume-btn-online');
      const visible = [];
      for (const button of buttons) if (await button.isVisible()) visible.push(button);
      if (visible.length !== 1 || (await visible[0]!.evaluate(el => el.textContent?.trim())) !== '在线简历')
        throw new Error('ONLINE_RESUME_BUTTON_UNAVAILABLE');
      // Check the native selected identity immediately before the exact visible action.
      await page.evaluate(chatSnapshotScript(geekId));
      await new CommunicationRepository(sql).recordChatResumeView(accountId, geekId);
      let restoreLayout: import('puppeteer-core').JSHandle<() => void> | null = null;
      try {
      await page.setViewport({...viewport!,width:Math.max(viewport?.width ?? 1280,1280),height:Math.max(viewport?.height ?? 900,900)});
        await page.evaluate(chatSnapshotScript(geekId));
        await visible[0]!.click();
        if (!await capture.waitForVisibleCResumeIframeReady(page)) throw new Error('ONLINE_RESUME_NOT_LOADED');
        await page.evaluate(chatSnapshotScript(geekId));
        const frame = await capture.findVisibleCResumeIframeHandle(page);
        if (!frame) throw new Error('ONLINE_RESUME_NOT_LOADED');
        try { restoreLayout = await frame.evaluateHandle(prepareChatResumeLayout); } finally { await frame.dispose(); }
        // Loading time never consumes the requested viewing time.
        await new Promise(resolve => setTimeout(resolve, policy.dwellTargetSeconds * 1000));
        if (!await capture.captureCResumeIframeToFile(page, viewport, screenshotPath)) throw new Error('ONLINE_RESUME_CAPTURE_INCOMPLETE');
        await page.evaluate(chatSnapshotScript(geekId));
      } finally {
        if (restoreLayout) {try {await restoreLayout.evaluate(restore => restore());} finally {await restoreLayout.dispose();}}
        await capture.closeCResumePanel(page);
        if (viewport) await page.setViewport(viewport);
        await Promise.all(buttons.map(button => button.dispose()));
      }
    });
    const artifact = await readResumeArtifact(screenshotPath);
    if (!artifact.complete) throw new Error('ONLINE_RESUME_CAPTURE_INCOMPLETE');
    return bossChatOnlineResumeSchema.parse({geekId, screenshotPath, capturedAt: artifact.capturedAt ?? new Date().toISOString(), text: '', textStatus: 'pending', analysisVersion: 1});
  } finally { await sql.end(); }
}

export async function readBossChatInbox(geekIds: string[] = []) {
  geekIds.forEach((id) => bossChatTargetSchema.parse(id));
  const { session, list } = await browserTools();
  return session.withBossSessionPage(async (page) => {
    await ensureInboxReady(page, list.ensureChatListReady);
    return geekIds.length ? loadInbox(page, geekIds) : loadRecentInbox(page);
  });
}

/** Invoked only by the authenticated supervisor while holding the global and account locks. */
export async function sendQueuedBossChat(
  outgoingId: string,
  accountId: string,
  dependencies?: {
    repository: CommunicationRepository;
    open(geekId: string): Promise<void>;
    send(geekId: string, body: string): Promise<BossMessageProviderReceipt>;
  },
) {
  const sql = dependencies ? null : createDatabase();
  const repository =
    dependencies?.repository ?? new CommunicationRepository(sql!);
  let writeAttempted = false;
  try {
    if (
      !dependencies &&
      (!realContactEnabled(process.env) ||
        contactDispatchModeFromEnvironment(process.env) !== 'real')
    )
      throw new Error('真实发送未开启。');
    const { row, principal, active } = await repository.outgoing(outgoingId);
    if (row.status !== 'queued') return { messageId: outgoingId };
    if (!active || row.boss_account_id !== accountId)
      throw new Error('会话账号或发送人权限已变化。');
    const target = await repository.target(principal, row.conversation_id);
    if (target.geekId !== row.geek_id || target.bossAccountId !== accountId)
      throw new Error('聊天对象绑定已变化。');
    if (sql)
      await new M2Repository(sql).recordVerifiedBossAccountHealth(
        accountId,
        new Date().toISOString(),
      );
    await repository.assertReplyAllowed(principal, target);
    await repository.validateOutgoingBusinessContext(principal, outgoingId);
    if (!(await repository.claimOutgoing(outgoingId)))
      return { messageId: outgoingId };
    const tools = dependencies ? null : await browserTools();
    if (dependencies) await dependencies.open(row.geek_id);
    else
      await tools!.session.withBossSessionPage((page) =>
        openExact(page, row.geek_id, tools!),
      );
    // Recheck authorization immediately before handing the exact draft to BOSS.
    const latest = await repository.outgoing(outgoingId);
    if (!latest.active) throw new Error('发送人权限已变化。');
    await repository.assertReplyAllowed(latest.principal, target);
    await repository.validateOutgoingBusinessContext(
      latest.principal,
      outgoingId,
    );
    writeAttempted = true;
    const receipt = dependencies
      ? await dependencies.send(row.geek_id, row.body)
      : parseBossContactProviderReceipt(
          await tools!.send.runSendChatMessage({
            text: row.body,
            expectedCandidateTarget: `__boss_geek_id__:${encodeURIComponent(row.geek_id)}`,
          }),
          'message',
        );
    if (
      receipt.actionKind !== 'message' ||
      receipt.candidateId !== row.geek_id ||
      receipt.bodySha256 !== createHash('sha256').update(row.body).digest('hex')
    )
      throw new Error('消息回执不一致。');
    await repository.finishOutgoing(outgoingId, receipt);
    return { messageId: outgoingId };
  } catch (error) {
    await repository.failOutgoing(outgoingId, writeAttempted);
    throw error;
  } finally {
    await sql?.end();
  }
}
