import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page, HTTPResponse, Target, ElementHandle } from 'puppeteer-core';
import { bossChatAttachmentSchema, bossChatTargetSchema } from '@boss-forge/contracts';
import { getBossCliInstallation } from '@boss-forge/boss-cli-adapter';

export const attachmentMaxBytes=20*1024*1024;
export function attachmentFileType(body: Buffer): 'application/pdf'|'image/png'|'image/jpeg'|null {
  if(body.subarray(0,5).toString()==='%PDF-')return 'application/pdf';
  if(body.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(body[0]===255&&body[1]===216&&body[2]===255)return 'image/jpeg';
  return null;
}
export function isAttachmentPreview(url: string, geekId: string): boolean {
  try {const u=new URL(url);return u.protocol==='https:'&&u.hostname==='www.zhipin.com'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&u.pathname===`/wflow/zpgeek/download/preview4boss/${geekId}`;}catch{return false;}
}

// Limit cleanup to the viewer containing an actual attachment iframe.
export const attachmentCloseControlScript = `(() => {
  const frames=[...document.querySelectorAll('iframe.attachment-iframe')].filter(e=>e.getBoundingClientRect().width>0);
  if(frames.length===1){
    const main=frames[0].closest('.new-resume-online-main-ui');
    const buttons=main?[...main.querySelectorAll('.close-btn')].filter(e=>e.getBoundingClientRect().width>0):[];
    if(buttons.length===1)return buttons[0];
  }
  const legacy=document.querySelector('.my-dialog-resume .resume-custom-close');
  return legacy&&legacy.getBoundingClientRect().width>0?legacy:null;
})()`;

async function closeAttachmentViewer(page: Page, waitForMount = false): Promise<void> {
  // Preview bytes can arrive before the native modal finishes mounting.
  const handle = waitForMount
    ? await page.waitForFunction(attachmentCloseControlScript,{timeout:4000}).catch(()=>null)
    : await page.evaluateHandle(attachmentCloseControlScript);
  if(!handle)return;
  try {
    const button=handle.asElement() as ElementHandle<Element> | null;
    if(!button)return;
    await button.click();
    await page.waitForFunction(() => ![...document.querySelectorAll('iframe.attachment-iframe')].some(e=>e.getBoundingClientRect().width>0),{timeout:3000});
  } finally { await handle.dispose(); }
}

export async function pruneAttachmentFiles(root: string, now = Date.now()): Promise<void> {
  for (const entry of await readdir(root, {withFileTypes:true})) {
    if (!entry.isFile() || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(?:pdf|png|jpg)$/.test(entry.name)) continue;
    const path=join(root,entry.name);
    try { if ((await stat(path)).mtimeMs < now-3600000) await unlink(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

/** Observe the bytes loaded by BOSS's actual attachment viewer. No guessed URL,
 * credentials copied to another host, or application/consent button is used. */
export async function readBossChatAttachment(geekId: string) {
  bossChatTargetSchema.parse(geekId);
  const {readBossChat,chatSnapshotScript}=await import('./boss-communication.js');
  const {packageRoot}=await getBossCliInstallation();
  const session=await import(pathToFileURL(`${packageRoot}/dist/common/boss_session_page.js`).href) as {withBossSessionPage<T>(run:(page:Page)=>Promise<T>):Promise<T>};
  await session.withBossSessionPage(async page=>{await closeAttachmentViewer(page);});
  const snapshot=await readBossChat(geekId);
  if(!snapshot.attachmentAvailable)throw new Error('对方的附件尚未接收，请先同意接收。');
  return session.withBossSessionPage(async page=>{
    const browser=page.browser(),observed=new Set<Page>([page]),opened=new Set<Page>();
    let settled=false,reading=false;
    let resolveFile:(file:{body:Buffer;contentType:'application/pdf'|'image/png'|'image/jpeg'})=>void;
    let rejectFile:(error:Error)=>void;
    const file=new Promise<{body:Buffer;contentType:'application/pdf'|'image/png'|'image/jpeg'}>((resolve,reject)=>{resolveFile=resolve;rejectFile=reject;});
    // Catch immediately so a timeout during another awaited operation is handled.
    const result=file.then(value=>({value}),error=>({error: error as Error}));
    const response=async(r:HTTPResponse)=>{
      if(settled||reading||![200,206].includes(r.status())||!isAttachmentPreview(r.url(),geekId))return;
      reading=true;
      try {
        if(Number(r.headers()['content-length'])>attachmentMaxBytes)throw new Error('附件超过 20 MB，暂不支持查看。');
        // PDF viewers may abort the initial request and load ranges. Re-read
        // that observed, same-origin preview URL in the existing browser session.
        let body=r.status()===200?await r.content().then(v=>Buffer.from(v)).catch(()=>null):null;
        if(!body) {
          const encoded=await page.evaluate(async(url,max)=>{
            if(new URL(url).origin!==location.origin)throw new Error('Attachment origin mismatch');
            const response=await fetch(url,{credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(30000)});
            if(response.status!==200||Number(response.headers.get('content-length'))>max)throw new Error('附件无法完整读取。');
            const reader=response.body?.getReader();if(!reader)throw new Error('附件内容为空。');
            let total=0;const chunks:Uint8Array[]=[];
            try {for(;;){const part=await reader.read();if(part.done)break;total+=part.value.length;if(total>max)throw new Error('附件超过 20 MB。');chunks.push(part.value);}}finally{await reader.cancel();reader.releaseLock();}
            const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
            let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
            return btoa(binary);
          },r.url(),attachmentMaxBytes);
          body=Buffer.from(encoded,'base64');
        }
        if(body.length>attachmentMaxBytes)throw new Error('附件超过 20 MB，暂不支持查看。');
        const contentType=attachmentFileType(body);
        if(!contentType){reading=false;return;}
        settled=true;resolveFile({body,contentType});
      }catch(e){if(!settled){settled=true;rejectFile(e as Error);}}
    };
    const newTarget=async(target:Target)=>{
      if(target.opener()!==page.target())return;
      const child=await target.page();if(!child)return;
      opened.add(child);observed.add(child);child.on('response',response);
    };
    page.on('response',response);browser.on('targetcreated',newTarget);
    const timer=setTimeout(()=>{if(!settled){settled=true;rejectFile(new Error('附件暂未加载完成，请刷新会话后重试。'));}},45000);
    try {
      await page.evaluate(chatSnapshotScript(geekId));
      const buttons=await page.$$('.resume-btn-file');
      try {
        const eligible=[];
        for(const button of buttons)if(await button.isVisible()&&await button.evaluate(e=>!e.classList.contains('disabled')&&!e.hasAttribute('disabled')&&e.textContent?.trim()==='附件简历'))eligible.push(button);
        if(eligible.length!==1)throw new Error('当前附件简历不可查看，请同步会话后重试。');
        await eligible[0]!.click();
      }finally{await Promise.all(buttons.map(b=>b.dispose()));}
      const completed=await result;
      if('error' in completed)throw completed.error;
      await page.evaluate(chatSnapshotScript(geekId));
      const root=join(process.env.BOSS_FORGE_RESUME_SCREENSHOT_DIR?.trim()||join(homedir(),'.boss-cli','.cache','resume-screenshots'),'attachments');
      await mkdir(root,{recursive:true,mode:0o700});
      await pruneAttachmentFiles(root);
      const ext=completed.value.contentType==='application/pdf'?'pdf':completed.value.contentType==='image/png'?'png':'jpg';
      const filePath=join(root,`${randomUUID()}.${ext}`);
      await writeFile(filePath,completed.value.body,{mode:0o600});
      return bossChatAttachmentSchema.parse({geekId,filePath,name:`附件简历.${ext}`,contentType:completed.value.contentType,size:completed.value.body.length});
    }finally{
      clearTimeout(timer);browser.off('targetcreated',newTarget);
      for(const target of observed)target.off('response',response);
      for(const target of opened)await target.close().catch(()=>{});
      // The native close control belongs exclusively to the attachment viewer.
      await closeAttachmentViewer(page,true).catch(error=>console.error('Attachment viewer cleanup failed:',error instanceof Error?error.message:String(error)));
    }
  });
}
