import { acceptBossResume } from './boss-resume-receiving.js';
import { pathToFileURL } from 'node:url';
import {
  bossChatTargetSchema,
  bossWechatReceiptSchema,
  realContactEnabled,
  contactDispatchModeFromEnvironment,
  type BossWechatReceipt,
} from '@boss-forge/contracts';
import { getBossCliInstallation } from '@boss-forge/boss-cli-adapter';
import {
  CommunicationRepository,
  M2Repository,
  createDatabase,
} from '@boss-forge/data';
import type { Page } from 'puppeteer-core';

export function wechatCapabilityScript(
  click = false,
  kind: 'wechat' | 'resume' = 'wechat',
): string {
  return `(() => {
    const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'};
    const buttons=Array.from(document.querySelectorAll('.operate-icon-item')).map(e=>({host:e,button:e.querySelector?.('.operate-btn')}))
      .filter(x=>x.button&&visible(x.host)&&visible(x.button)&&${kind === 'resume' ? '/求简历|索取简历|已收简历|查看简历/' : '/换微信|交换微信|查看微信/'}.test(x.button.textContent||''));
    if(buttons.length!==1)return {state:'unavailable',reason:${JSON.stringify(kind === 'resume' ? '当前会话未找到可确认的 BOSS 求简历按钮。' : '当前会话未找到可确认的 BOSS 微信交换按钮。')}};
    const {host,button}=buttons[0], text=(button.textContent||'').replace(/\\s+/g,' ').trim();
    const classes=String(host.className)+' '+String(button.className);
    if(${kind === 'resume' ? '/已收简历|查看简历/' : '/已交换|查看微信/'}.test(text))return {state:'exchanged',reason:${JSON.stringify(kind === 'resume' ? '对方已分享简历，请在消息附件中查看。' : '已交换微信；对方分享的微信号会显示在联系方式中。')}};
    if(/已申请|已请求|等待对方|申请已发送/.test(text))return {state:'pending',reason:${JSON.stringify(kind === 'resume' ? '简历请求已发出，等待对方回复。' : '微信交换已申请，等待对方确认。')}};
    if(/disabled|forbid|ban/i.test(classes)||button.hasAttribute('disabled')||button.getAttribute('aria-disabled')==='true')
      return {state:'unavailable',reason:/双方回复/.test(text)?${JSON.stringify(kind === 'resume' ? 'BOSS 要求双方回复后才能索取简历。' : 'BOSS 要求双方回复后才能交换微信。')}:${JSON.stringify(kind === 'resume' ? 'BOSS 当前不允许索取简历。' : 'BOSS 当前不允许交换微信。')}};
    if(${click})button.click();
    return {state:'available',reason:''};
  })()`;
}

export function confirmWechatScript(
  geekId: string,
  kind: 'wechat' | 'resume' = 'wechat',
): string {
  bossChatTargetSchema.parse(geekId);
  return `(() => {
    const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'};
    const chats=Array.from(document.querySelectorAll('.conversation-message')).filter(visible);
    if(chats.length!==1||String(chats[0].__vue__?.conversation$?.encryptUid||chats[0].__vue__?.conversation$?.encryptGeekId)!==${JSON.stringify(geekId)})throw new Error('CHAT_TARGET_MISMATCH');
    const tips=Array.from(document.querySelectorAll('.exchange-tooltip')).filter(e=>visible(e)&&${kind === 'resume' ? '/索取简历|求简历/' : '/交换微信/'}.test(e.textContent||''));
    if(tips.length!==1)return false;
    const buttons=Array.from(tips[0].querySelectorAll('.btn-box .boss-btn-primary')).filter(e=>visible(e)&&/^(确定|确认)$/.test((e.textContent||'').trim())&&!e.hasAttribute('disabled')&&!/disabled/.test(String(e.className)));
    if(buttons.length!==1)return false;
    buttons[0].click();return true;
  })()`;
}

export function wechatReceiptScript(
  geekId: string,
  previousMessageIds: string[],
  previousNotices: string[],
  kind: 'wechat' | 'resume' = 'wechat',
): string {
  bossChatTargetSchema.parse(geekId);
  return `(() => {
    const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'};
    const hosts=Array.from(document.querySelectorAll('.conversation-message')).filter(visible);
    if(hosts.length!==1)return false;
    const vm=hosts[0].__vue__, c=vm?.conversation$;
    if(String(c?.encryptUid||c?.encryptGeekId)!==${JSON.stringify(geekId)})return false;
    const providerConversationId=String(c?.uniqueId||'');if(!providerConversationId)return false;
    let evidence=null;
    const capability=${wechatCapabilityScript(false, kind)};
    if(capability.state==='pending')evidence='native_pending';
    const previous=new Set(${JSON.stringify(previousMessageIds)});
    const cards=(vm?.list$||[]).filter(m=>!previous.has(String(m.serverMid||m.mid||''))&&(m.isSelf===true||m.isSelf===1)&&[1,2].includes(Number(m.status))&&
      (m.serverMid||m.received===true)&&${kind === 'resume' ? '/resume|exchange|dialog/i' : '/wechat|exchange|dialog/i'}.test(String(m.type))&&${kind === 'resume' ? '/索取简历|请求简历|求简历/' : '/交换微信|微信交换/'}.test(String(m.text||'')));
    if(cards.length)evidence='native_card';
    const oldNotices=new Set(${JSON.stringify(previousNotices)});
    const notices=Array.from(document.querySelectorAll('.toast,.toast-content,.message,.message-content,[role="alert"]')).filter(visible).map(e=>(e.textContent||'').trim());
    if(notices.some(t=>!oldNotices.has(t)&&${kind === 'resume' ? '/^(简历请求已发送|请求已发送|已发送简历请求|索取简历请求已发送)[。！!]?$/u' : '/^(微信交换请求已发送|请求已发送|已发送微信交换请求|交换微信申请已发送)[。！!]?$/u'}.test(t)))evidence='native_notice';
    return evidence?{geekId:${JSON.stringify(geekId)},providerConversationId,acceptedAt:new Date().toISOString(),evidence}:false;
  })()`;
}

/** Click the native BOSS exchange control and its native confirmation. A click
 * alone is never a successful receipt. No chat text substitutes for this action. */
export async function exchangeBossWechat(
  geekId: string,
  hooks: { assertAuthorized(): Promise<void>; writeAttempted(): void },
  kind: 'wechat' | 'resume' = 'wechat',
): Promise<BossWechatReceipt> {
  const { readBossChat, chatSnapshotScript } =
    await import('./boss-communication.js');
  await readBossChat(geekId);
  const { packageRoot } = await getBossCliInstallation();
  const session = (await import(
    pathToFileURL(packageRoot + '/dist/common/boss_session_page.js').href
  )) as { withBossSessionPage<T>(run: (page: Page) => Promise<T>): Promise<T> };
  return session.withBossSessionPage(async (page) => {
    const before = (await page.evaluate(chatSnapshotScript(geekId))) as {
      messages: { providerMessageId: string }[];
      wechat: { state: string; reason: string };
      resume?: { state: string; reason: string };
    };
    const capability = kind === 'resume' ? before.resume : before.wechat;
    if (capability?.state !== 'available')
      throw new Error(capability?.reason || 'BOSS 申请按钮不可用。');
    const notices = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll(
          '.toast,.toast-content,.message,.message-content,[role="alert"]',
        ),
      ).map((e) => (e.textContent || '').trim()),
    );
    await hooks.assertAuthorized();
    await page.evaluate(chatSnapshotScript(geekId));
    hooks.writeAttempted();
    const clicked = (await page.evaluate(
      wechatCapabilityScript(true, kind),
    )) as {
      state: string;
    };
    if (clicked.state !== 'available')
      throw new Error('BOSS 微信交换按钮状态已变化。');
    const dialog = await page.waitForFunction(
      `(() => Array.from(document.querySelectorAll('.exchange-tooltip')).some(e=>e.getBoundingClientRect().height>0&&${kind === 'resume' ? '/索取简历|求简历/' : '/交换微信/'}.test(e.textContent||'')))()`,
      { timeout: 10_000 },
    );
    await dialog.dispose();
    await hooks.assertAuthorized();
    if (!(await page.evaluate(confirmWechatScript(geekId, kind))))
      throw new Error('微信交换确认界面已变化，未继续操作。');
    const proof = await page.waitForFunction(
      wechatReceiptScript(
        geekId,
        before.messages.map((m) => m.providerMessageId),
        notices,
        kind,
      ),
      { timeout: 12_000 },
    );
    try {
      return bossWechatReceiptSchema.parse(await proof.jsonValue());
    } finally {
      await proof.dispose();
    }
  });
}

export async function sendQueuedBossWechat(
  actionId: string,
  accountId: string,
  dependencies?: {
    repository: CommunicationRepository;
    exchange(
      geekId: string,
      hooks: { assertAuthorized(): Promise<void>; writeAttempted(): void },
      kind?: 'wechat' | 'resume',
    ): Promise<BossWechatReceipt>;
    acceptResume?(geekId:string,messageId:string,hooks:{assertAuthorized():Promise<void>;writeAttempted():void}):Promise<BossWechatReceipt>;
  },
) {
  const sql = dependencies ? null : createDatabase();
  const repository =
    dependencies?.repository ?? new CommunicationRepository(sql!);
  let attempted = false;
  try {
    if (
      !dependencies &&
      (!realContactEnabled(process.env) ||
        contactDispatchModeFromEnvironment(process.env) !== 'real')
    )
      throw new Error('真实发送未开启。');
    const { row, principal, active } =
      await repository.outgoingWechat(actionId);
    if (row.status !== 'queued') return { actionId };
    if (!active || row.boss_account_id !== accountId)
      throw new Error('微信交换账号或发送权限已变化。');
    const target = await repository.target(principal, row.conversation_id);
    if (target.geekId !== row.geek_id || target.bossAccountId !== accountId)
      throw new Error('微信交换对象绑定已变化。');
    if (sql)
      await new M2Repository(sql).recordVerifiedBossAccountHealth(
        accountId,
        new Date().toISOString(),
      );
    const assertAuthorized = async () => {
      const current = await repository.outgoingWechat(actionId);
      if (!current.active) throw new Error('微信交换发送权限已变化。');
      await repository.assertReplyAllowed(current.principal, target);
    };
    await assertAuthorized();
    if (!(await repository.claimWechat(actionId))) return { actionId };
    const receipt = row.action_kind === 'resume_accept'
      ? await (dependencies ? dependencies.acceptResume ?? (async()=>{throw new Error('Resume acceptance test dependency missing');}) : acceptBossResume)(target.geekId, row.provider_message_id, {assertAuthorized, writeAttempted:()=>{attempted=true;}})
      : await (dependencies?.exchange ?? exchangeBossWechat)(
      target.geekId,
      {
        assertAuthorized,
        writeAttempted: () => {
          attempted = true;
        },
      },
      row.action_kind === 'resume' ? 'resume' : 'wechat',
    );
    await repository.finishWechat(actionId, receipt);
    return { actionId };
  } catch (error) {
    await repository.failWechat(actionId, attempted);
    throw error;
  } finally {
    await sql?.end();
  }
}
