import {runInNewContext} from 'node:vm';
import {describe,it,expect} from 'vitest';
import {resumeOfferActionScript,matchesResumeAcceptance} from './boss-resume-receiving.js';
import {attachmentFileType,isAttachmentPreview} from './boss-attachment.js';

function fixture(options:{geek?:string;mid?:string;type?:number;operated?:boolean;self?:boolean;disabled?:boolean;duplicate?:boolean}={}) {
  let clicks=0;
  const rect=()=>({width:100,height:40});
  const button={textContent:'同意',className:options.disabled?'card-btn disabled':'card-btn',getBoundingClientRect:rect,getAttribute:()=>null,hasAttribute:()=>false,click:()=>{clicks++;}};
  const row={__vue__:{message:{mid:options.mid??'123456',type:'dialog',isSelf:options.self??false,text:'对方想发送附件简历给您，您是否同意',dialog:{type:options.type??2,operated:options.operated??false}}},querySelectorAll:()=>[button],scrollIntoView:()=>{}};
  const host={getBoundingClientRect:rect,__vue__:{conversation$:{encryptUid:options.geek??'candidate-resume-test',uniqueId:'thread'}},querySelectorAll:()=>options.duplicate?[row,row]:[row]};
  return {context:{document:{querySelectorAll:()=>[host]},getComputedStyle:()=>({visibility:'visible'})},clicks:()=>clicks};
}
describe('native attachment consent',()=>{
  it('observes without acting and clicks only the exact inbound resume offer',()=>{
    const f=fixture();
    expect(runInNewContext(resumeOfferActionScript('candidate-resume-test','123456'),f.context).providerMessageId).toBe('123456');
    expect(f.clicks()).toBe(0);
    runInNewContext(resumeOfferActionScript('candidate-resume-test','123456',true),f.context);
    expect(f.clicks()).toBe(1);
  });
  it.each([{geek:'another-candidate'},{mid:'999999'},{type:1},{operated:true},{self:true},{disabled:true},{duplicate:true}])('does not act on mismatched or processed state %j',options=>{
    const f=fixture(options);
    expect(()=>runInNewContext(resumeOfferActionScript('candidate-resume-test','123456',true),f.context)).toThrow();expect(f.clicks()).toBe(0);
  });
  it('requires the native acceptance endpoint and exact message/type receipt binding',()=>{
    const url='https://www.zhipin.com/wapi/zpchat/exchange/accept';
    expect(matchesResumeAcceptance(url,'POST','mid=123456&type=3','123456')).toBe(true);
    expect(matchesResumeAcceptance(url,'POST',JSON.stringify({mid:123456,type:3}),'123456')).toBe(true);
    for(const [u,m,b] of [[url,'GET','mid=123456&type=3'],[url,'POST','mid=123456&type=2'],[url,'POST','mid=999999&type=3'],[url.replace('zhipin.com','zhipin.com.evil.test'),'POST','mid=123456&type=3'],[url.replace('accept','reject'),'POST','mid=123456&type=3']])expect(matchesResumeAcceptance(u!,m!,b!,'123456')).toBe(false);
  });
});
describe('native attachment preview data',()=>{
  it('binds preview responses to the native host and chosen candidate',()=>{
    expect(isAttachmentPreview('https://www.zhipin.com/wflow/zpgeek/download/preview4boss/candidate-test?d=signed','candidate-test')).toBe(true);
    for(const url of ['https://www.zhipin.com/wflow/zpgeek/download/preview4boss/another-candidate','https://www.zhipin.com.evil.test/wflow/zpgeek/download/preview4boss/candidate-test','https://user@www.zhipin.com/wflow/zpgeek/download/preview4boss/candidate-test','https://www.zhipin.com:8000/wflow/zpgeek/download/preview4boss/candidate-test'])expect(isAttachmentPreview(url,'candidate-test')).toBe(false);
  });
  it('accepts PDF/images and rejects error pages and executable file formats',()=>{
    expect(attachmentFileType(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
    expect(attachmentFileType(Buffer.from([137,80,78,71,13,10,26,10]))).toBe('image/png');
    expect(attachmentFileType(Buffer.from([255,216,255,224]))).toBe('image/jpeg');
    expect(attachmentFileType(Buffer.from('<html>login</html>'))).toBeNull();
    expect(attachmentFileType(Buffer.from('MZbinary'))).toBeNull();
  });
});

it('cleans only expired worker attachment files while retaining active reads and unrelated files',async()=>{
  const {mkdtemp,writeFile,utimes,readdir,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {randomUUID}=await import('node:crypto');
  const {pruneAttachmentFiles}=await import('./boss-attachment.js');
  const root=await mkdtemp(join(tmpdir(),'attachment-prune-')),old=randomUUID()+'.pdf',fresh=randomUUID()+'.png',unrelated='saved-resume.pdf',now=Date.now();
  try{
    for(const name of [old,fresh,unrelated])await writeFile(join(root,name),'fixture');
    for(const name of [old,unrelated])await utimes(join(root,name),(now-7200000)/1000,(now-7200000)/1000);
    await pruneAttachmentFiles(root,now);
    expect((await readdir(root)).sort()).toEqual([fresh,unrelated].sort());
  }finally{await rm(root,{recursive:true,force:true});}
});

it('locates only the visible attachment close control instead of unrelated resume or chat controls',async()=>{
  const {attachmentCloseControlScript}=await import('./boss-attachment.js');let clicks=0;
  const button={getBoundingClientRect:()=>({width:20}),click:()=>{clicks++;}};
  const frame={getBoundingClientRect:()=>({width:600}),closest:(selector:string)=>{expect(selector).toBe('.new-resume-online-main-ui');return{querySelectorAll:()=>[button]};}};
  const context={document:{querySelectorAll:(selector:string)=>{expect(selector).toBe('iframe.attachment-iframe');return[frame];},querySelector:()=>null}};
  expect(runInNewContext(attachmentCloseControlScript,context)).toBe(button);expect(clicks).toBe(0);
  expect(runInNewContext(attachmentCloseControlScript,{document:{querySelectorAll:()=>[],querySelector:()=>null}})).toBeNull();expect(clicks).toBe(0);
});
