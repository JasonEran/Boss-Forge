import { pathToFileURL } from 'node:url';
import type { Page } from 'puppeteer-core';
import { bossChatTargetSchema, bossWechatReceiptSchema, type BossWechatReceipt } from '@boss-forge/contracts';
import { getBossCliInstallation } from '@boss-forge/boss-cli-adapter';

/** The native consent card is bound to both the selected person and message. */
export function resumeOfferActionScript(geekId: string, messageId: string, click = false): string {
  bossChatTargetSchema.parse(geekId);
  if (!/^\d{1,30}$/.test(messageId)) throw new Error('Invalid native resume offer');
  return `(() => {
    const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'};
    const hosts=[...document.querySelectorAll('.conversation-message')].filter(visible);
    if(hosts.length!==1)throw new Error('CHAT_NOT_READY');
    const c=hosts[0].__vue__?.conversation$;
    if(String(c?.encryptUid||c?.encryptGeekId)!==${JSON.stringify(geekId)})throw new Error('CHAT_TARGET_MISMATCH');
    const rows=[...hosts[0].querySelectorAll('.message-item')].filter(e=>{const m=e.__vue__?.message||e.__vue__?.$props?.message;return String(m?.serverMid||m?.mid)===${JSON.stringify(messageId)}});
    if(rows.length!==1)throw new Error('RESUME_OFFER_NOT_FOUND');
    const row=rows[0],m=row.__vue__?.message||row.__vue__?.$props?.message;
    if(m.isSelf===true||m.isSelf===1||m.type!=='dialog'||Number(m.dialog?.type)!==2||!/发送附件简历/.test(m.text||''))throw new Error('RESUME_OFFER_MISMATCH');
    if(m.dialog.operated===true)throw new Error('RESUME_OFFER_ALREADY_HANDLED');
    const buttons=[...row.querySelectorAll('.message-card-buttons .card-btn')].filter(e=>(e.textContent||'').trim()==='同意'&&visible(e)&&!e.hasAttribute('disabled')&&e.getAttribute('aria-disabled')!=='true'&&!/disabled/.test(String(e.className)));
    if(buttons.length!==1)throw new Error('RESUME_OFFER_UNAVAILABLE');
    if(${click}){row.scrollIntoView({block:'center'});buttons[0].click();}
    return {providerConversationId:String(c.uniqueId||''),providerMessageId:${JSON.stringify(messageId)}};
  })()`;
}

export function matchesResumeAcceptance(url: string, method: string, body: string | undefined, messageId: string): boolean {
  try {
    const u=new URL(url);
    if(u.origin!=='https://www.zhipin.com'||u.pathname!=='/wapi/zpchat/exchange/accept'||method!=='POST'||!body)return false;
    const fields=body.trim().startsWith('{') ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body));
    return String(fields.mid)===messageId&&Number(fields.type)===3;
  } catch {return false;}
}

export async function acceptBossResume(geekId: string, messageId: string, hooks: {assertAuthorized(): Promise<void>; writeAttempted(): void}): Promise<BossWechatReceipt> {
  const {readBossChat}=await import('./boss-communication.js');
  await readBossChat(geekId);
  const {packageRoot}=await getBossCliInstallation();
  const session=await import(pathToFileURL(`${packageRoot}/dist/common/boss_session_page.js`).href) as {withBossSessionPage<T>(run:(page:Page)=>Promise<T>):Promise<T>};
  return session.withBossSessionPage(async page=>{
    const before=await page.evaluate(resumeOfferActionScript(geekId,messageId)) as {providerConversationId:string};
    await hooks.assertAuthorized();
    // Install observation before clicking. A disabled card or click alone is not proof.
    const receipt=page.waitForResponse(r=>matchesResumeAcceptance(r.url(),r.request().method(),r.request().postData(),messageId),{timeout:15000}).then(async r=>({ok:r.ok(),body:await r.json()})).catch(()=>null);
    hooks.writeAttempted();
    await page.evaluate(resumeOfferActionScript(geekId,messageId,true));
    const result=await receipt;
    if(!result?.ok||result.body?.code!==0||result.body?.zpData?.status!==0)throw new Error('尚未确认 BOSS 已接收简历，请刷新会话核对。');
    return bossWechatReceiptSchema.parse({geekId,providerConversationId:before.providerConversationId,providerMessageId:messageId,acceptedAt:new Date().toISOString(),evidence:'native_resume_received'});
  });
}
