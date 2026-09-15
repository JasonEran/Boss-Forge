import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { createRequire } from 'node:module';
const adapterRequire=createRequire(createRequire(import.meta.url).resolve('@boss-forge/boss-cli-adapter'));
const {captureFullResume}=await import(adapterRequire.resolve('@joohw/boss-cli/dist/common/c_resume_full_capture.js'));
const dir=process.env.BOSS_CAPTURE_TEST_OUTPUT || '/tmp/boss-full-resume-capture-test';await mkdir(dir,{recursive:true});
let port;
const server=createServer((req,res)=>{
res.setHeader('content-type','text/html;charset=utf-8');
if(req.url==='/avatar.svg'){res.setHeader('content-type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="60" height="60" fill="#c52b38"/></svg>');}
else if(req.url==='/tainted-shell')res.end(`<style>body{margin:0;height:850px;overflow:auto scroll}.outer{height:680px;overflow:auto;margin:38.625px 21.25px;border:3px solid #aaa}iframe{width:900px;height:740px;border:0}</style><div style="height:1100px"></div><div class="outer"><iframe src="http://127.0.0.1:${port}/native-canvas?tainted"></iframe></div>`);
else if(req.url==='/canvas')res.end(`<style>body{margin:0}</style><div style="height:1384px"><canvas width="582" height="1384"></canvas><svg style="position:absolute;top:1200px" width="582" height="40"><text x="20" y="25" style="cursor:pointer" onclick="expandCanvas()">查看全部</text></svg></div><script>function expandCanvas(){const c=document.querySelector('canvas');c.height=4800;document.querySelector('div').style.height='4800px';document.querySelector('svg').remove();const x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,582,4800);x.fillStyle='#222';x.font='20px sans-serif';for(let i=0;i<142;i++)x.fillText('Expanded resume section '+i,20,35+i*30);x.fillStyle='#12b758';x.fillRect(0,4600,582,200);}const c=document.querySelector('canvas'),x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,582,1384);x.fillStyle='#222';x.font='20px sans-serif';for(let i=0;i<35;i++)x.fillText('Resume education and experience '+i,20,35+i*30);x.fillStyle='#12b758';x.fillRect(0,1200,582,184);</script>`);
else if(req.url==='/virtual-canvas')res.end(`<style>body{margin:0;height:0}#content{position:absolute;height:1646px;width:582px}canvas{position:absolute}</style><div id="content"><canvas width="582"></canvas></div><script>function paint(){const c=document.querySelector('canvas');c.height=Math.min(innerHeight,1646);c.style.height=c.height+'px';c.style.width='582px';c.style.transform='translateY('+scrollY+'px)';const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,582,c.height);ctx.fillStyle='#222';ctx.font='20px sans-serif';for(let i=0;i<44;i++)ctx.fillText('Resume education and experience '+i,20,35+i*30-scrollY);}addEventListener('scroll',paint);addEventListener('resize',paint);paint();</script>`);
else if(req.url.startsWith('/native-canvas'))res.end(`<style>body{margin:0}.panel{height:700px;overflow:auto}iframe{border:0;width:582px;height:1646px}</style><div class="panel" style="${req.url.includes('tainted')?'margin:67.375px 43.5px;border:5px solid #999;height:610px':''}"><iframe src="/native-resume${req.url.includes('tainted')?'?tainted&c-resume':''}"></iframe></div><script>const panel=document.querySelector('.panel'),iframe=document.querySelector('iframe');const relay=()=>iframe.contentWindow.postMessage({top:panel.scrollTop},'*');panel.addEventListener('scroll',relay);addEventListener('message',e=>{if(e.data.height){iframe.style.height=e.data.height+'px';relay();}});addEventListener('resize',()=>iframe.contentWindow.postMessage({reset:true},'*'));</script>`);
else if(req.url.startsWith('/native-resume'))res.end(`<style>body{margin:0;height:0}div#resume{position:absolute;height:1646px;width:582px}canvas{position:absolute}</style><div id="resume"><canvas id="resume" width="582" height="780"></canvas></div><script>window.expanded=false;let offset=0;function paint(){const c=document.querySelector('canvas');c.style.transform='translateY('+offset+'px)';const x=c.getContext('2d');x.clearRect(0,0,582,780);x.fillStyle='#222';x.font='20px sans-serif';for(let i=0;i<(expanded?53:44);i++)x.fillText('Resume work education section '+i,20,35+i*30-offset);x.fillStyle='#0ab';x.fillText(expanded?'Expanded':'Expand',470,220-offset);if(window.avatar)x.drawImage(window.avatar,460,30-offset,60,60);x.fillStyle='#12b758';x.fillRect(0,(expanded?1854:1646)-60-offset,582,60);}function resize(){document.querySelector('div#resume').style.height=(expanded?1854:1646)+'px';parent.postMessage({height:expanded?1854:1646},'*');paint();}addEventListener('message',e=>{if(e.data.reset){window.expanded=false;resize();}if(typeof e.data.top==='number'){offset=e.data.top;paint();}});document.querySelector('canvas').onclick=e=>{if(e.clientX>=470&&e.clientX<=560&&e.clientY>=200&&e.clientY<=230){window.expanded=true;resize();}};resize();${req.url.includes('tainted')?`const avatar=new Image();avatar.src='http://localhost:${port}/avatar.svg';avatar.onload=()=>{window.avatar=avatar;paint();};`:''}</script>`);
else if(req.url==='/resume')res.end(`<style>body{margin:0;font:18px Arial}.scroll{height:550px;overflow:auto}.section{height:900px;padding:5px;box-sizing:border-box;border-bottom:2px solid black}</style><div class="scroll">${Array.from({length:16},(_,i)=>`<section class="section" style="background:hsl(${i*15} 55% 90%)"><h2>Resume section ${i+1} · 工作经历 ${i+1}</h2>${Array.from({length:18},(_,j)=>`<p>Experience ${i+1}-${j}: Overseas operations, projects, skills, education. 完整简历经历。</p>`).join('')}</section>`).join('')}</div><script>const s=document.querySelector('.scroll');let done=false;s.addEventListener('scroll',()=>{if(!done&&s.scrollTop+s.clientHeight>=s.scrollHeight-5){done=true;setTimeout(()=>{s.insertAdjacentHTML('beforeend','<section style="height:730px;background:#12b758"><h2>FINAL LAZY SECTION · 资格证书 英语专业八级</h2><p>简历结束：这是延迟加载的最后一段。</p></section>')},220)}})</script>`);
else if(req.url==='/outer')res.end(`<style>body{margin:0}.wrapper{height:600px;overflow:hidden}iframe{border:0;width:900px;height:580px}</style><div class="wrapper"><iframe id="resume" src="http://localhost:${port}/resume"></iframe></div>`);
else res.end(`<style>body{margin:0}.modal{height:620px;overflow:auto}iframe{border:0;width:950px;height:610px}</style><div class="modal"><iframe id="outer" src="http://127.0.0.1:${port}/outer"></iframe></div>`);
});await new Promise(r=>server.listen(0,'0.0.0.0',r));port=server.address().port;
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH || '/usr/bin/chromium',headless:true,ignoreDefaultArgs:['--hide-scrollbars'],args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']});
try {
const page=await browser.newPage();await page.setViewport({width:1100,height:850,deviceScaleFactor:1});await page.goto(`http://localhost:${port}`,{waitUntil:'networkidle0'});
const outer=await (await page.$('#outer')).contentFrame();const iframe=await outer.$('#resume');
await captureFullResume(page,iframe,`${dir}/fixture.png`);
const manifest=JSON.parse(await readFile(`${dir}/fixture.png.manifest.json`,'utf8'));assert.equal(manifest.complete,true);assert(manifest.parts.length>=8);assert(manifest.contentHeight>=15100);
const last=manifest.parts.at(-1);const pixel=await page.evaluate(async ({data,y})=>{const img=new Image();img.src=data;await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);return [...ctx.getImageData(400,y,1,1).data].slice(0,3);},{data:'data:image/png;base64,'+(await readFile(`${dir}/${last.file}`)).toString('base64'),y:last.height-40});assert.deepEqual([...pixel].slice(0,3),[18,183,88]);
assert.equal(await iframe.evaluate(el=>el.getAttribute('style')||''),'');
assert.equal(page.viewport().height,850);
const screenshot=page.screenshot.bind(page);
const blankScreenshot=async options=>{const data=await page.evaluate(({width,height})=>{const c=document.createElement('canvas');c.width=width;c.height=height;const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);return c.toDataURL('image/png').split(',')[1];},options.clip);await writeFile(options.path,Buffer.from(data,'base64'));};
page.screenshot=blankScreenshot;
await assert.rejects(captureFullResume(page,iframe,`${dir}/failed.png`),/BOSS_RESUME_INCOMPLETE/);
await assert.rejects(readFile(`${dir}/failed.png.manifest.json`),{code:'ENOENT'});
await assert.rejects(readFile(`${dir}/failed.png`),{code:'ENOENT'});
assert.equal(page.viewport().height,850);page.screenshot=screenshot;
await iframe.evaluate((el,url)=>el.src=url,`http://localhost:${port}/canvas`);
const canvasFrame=await iframe.contentFrame();await canvasFrame.waitForSelector('canvas');
page.screenshot=blankScreenshot;
const hookPath=dir+'/fixture-hook.mjs';
await writeFile(hookPath,`export async function inspectResumeCapture({page,frame}) {
 const host=await frame.frameElement();
 try {if(await host.evaluate(el=>parseFloat(el.style.height))<1000)throw new Error('Hook ran after frame restoration');}finally{await host.dispose();}
 if(await page.evaluate(()=>innerHeight)<1000)throw new Error('Hook ran after viewport restoration');
 return {expanded:await frame.evaluate(()=>{if(window.__extraExpanded)return false;window.__extraExpanded=true;const c=document.querySelector('canvas'),copy=document.createElement('canvas');copy.width=c.width;copy.height=c.height;copy.getContext('2d').drawImage(c,0,0);c.height+=200;document.querySelector('div').style.height=c.height+'px';const ctx=c.getContext('2d');ctx.drawImage(copy,0,0);ctx.fillStyle='#12b758';ctx.fillRect(0,c.height-200,c.width,200);return true;})};
}`);
process.env.BOSS_RESUME_CAPTURE_HOOK=new URL('file://'+hookPath).href;
try {await captureFullResume(page,iframe,`${dir}/canvas.png`);}finally{delete process.env.BOSS_RESUME_CAPTURE_HOOK;page.screenshot=screenshot;}

const canvasManifest=JSON.parse(await readFile(`${dir}/canvas.png.manifest.json`,'utf8'));
assert(canvasManifest.contentHeight>=5000);assert.equal(canvasManifest.parts.length,4);assert.equal(await canvasFrame.$("svg"),null);
await iframe.evaluate((el,url)=>el.src=url,`http://localhost:${port}/virtual-canvas`);
const virtualFrame=await iframe.contentFrame();await virtualFrame.waitForSelector('canvas');
page.screenshot=blankScreenshot;
try {await captureFullResume(page,iframe,`${dir}/virtual-canvas.png`);}finally{page.screenshot=screenshot;}
const virtualManifest=JSON.parse(await readFile(`${dir}/virtual-canvas.png.manifest.json`,'utf8'));
assert.equal(virtualManifest.contentHeight,1646);assert.equal(virtualManifest.parts.length,2);
assert(virtualManifest.parts.every(part=>part.cssHeight>=800));
const nativePage=await browser.newPage();await nativePage.setViewport({width:1100,height:780});
await nativePage.goto(`http://localhost:${port}/native-canvas`,{waitUntil:'networkidle0'});
const nativeIframe=await nativePage.$('iframe');const nativeFrame=await nativeIframe.contentFrame();await nativeFrame.waitForSelector('canvas');
const nativeHook=dir+'/native-hook.mjs';
await writeFile(nativeHook,`import {clickResumeExpansion} from ${JSON.stringify(new URL('./resume-canvas-expansion.mjs',import.meta.url).href)}; export async function inspectResumeCapture({page,frame}){if(await frame.evaluate(()=>window.expanded))return {expanded:false};await clickResumeExpansion(page,frame,{x:500,y:220});return {expanded:true};}`);
process.env.BOSS_RESUME_CAPTURE_HOOK=new URL('file://'+nativeHook).href;
try{await captureFullResume(nativePage,nativeIframe,`${dir}/native-canvas.png`);}finally{delete process.env.BOSS_RESUME_CAPTURE_HOOK;}
const nativeManifest=JSON.parse(await readFile(`${dir}/native-canvas.png.manifest.json`,'utf8'));
assert.equal(nativeManifest.contentHeight,1854);assert.equal(nativeManifest.parts.length,3);assert.equal(await nativeFrame.evaluate(()=>window.expanded),true);assert.equal(nativePage.viewport().height,780);
const nativeBackground=await nativePage.evaluate(async data=>{const i=new Image();i.src=data;await i.decode();const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const x=c.getContext('2d');x.drawImage(i,0,0);return [...x.getImageData(0,0,1,1).data];},'data:image/png;base64,'+(await readFile(`${dir}/native-canvas.png`)).toString('base64'));assert.deepEqual(nativeBackground,[255,255,255,255]);
// Native 4px scrollbars can shrink a 100%-width iframe while the WASM
// canvas stays at 582px. Capture the rightmost pixels, not a cropped 578px image.
const narrowPage=await browser.newPage();await narrowPage.setViewport({width:1100,height:820});
await narrowPage.goto(`http://localhost:${port}/native-canvas`,{waitUntil:'networkidle0'});
await narrowPage.addStyleTag({content:'.panel{width:582px;overflow:scroll}.panel::-webkit-scrollbar{width:4px;height:4px}.panel iframe{width:100%}'});
await narrowPage.$eval('.panel',el=>el.classList.add('resume-detail-wrap'));
const narrowIframe=await narrowPage.$('iframe'),narrowFrame=await narrowIframe.contentFrame();
await narrowFrame.waitForFunction('innerWidth === 578');
process.env.BOSS_RESUME_CAPTURE_HOOK=new URL('file://'+nativeHook).href;
try{await captureFullResume(narrowPage,narrowIframe,`${dir}/narrow-canvas.png`);}finally{delete process.env.BOSS_RESUME_CAPTURE_HOOK;}
const narrowManifest=JSON.parse(await readFile(`${dir}/narrow-canvas.png.manifest.json`,'utf8'));
assert.equal(narrowManifest.complete,true);assert.equal(narrowManifest.contentWidth,582);assert.equal(narrowManifest.contentHeight,1854);
assert(narrowManifest.parts.every(p=>p.width===582));
assert.equal(await narrowPage.$eval('.panel',el=>el.style.getPropertyValue('scrollbar-width')),'');
await narrowFrame.waitForFunction('innerWidth === 578');
const narrowTail=narrowManifest.parts.at(-1);
const rightPixel=await narrowPage.evaluate(async data=>{const i=new Image();i.src=data;await i.decode();const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const x=c.getContext('2d');x.drawImage(i,0,0);return [...x.getImageData(581,i.height-20,1,1).data];},'data:image/png;base64,'+(await readFile(`${dir}/${narrowTail.file}`)).toString('base64'));
assert.deepEqual(rightPixel,[18,183,88,255]);
// A foreign avatar makes toDataURL fail even though the résumé is visible.
// Capture through nested frames and clipped/bordered parents without resizing.
const taintedPage=await browser.newPage();await taintedPage.setViewport({width:1100,height:850,deviceScaleFactor:2});
await taintedPage.goto(`http://localhost:${port}/tainted-shell`,{waitUntil:'networkidle0'});
const shellIframe=await taintedPage.$('iframe'),shellFrame=await shellIframe.contentFrame();
const taintedIframe=await shellFrame.$('iframe'),taintedFrame=await taintedIframe.contentFrame();
await taintedFrame.waitForFunction('!!window.avatar');
assert.equal(await taintedFrame.evaluate(`(() => {try{document.querySelector('canvas').toDataURL();return false;}catch(e){return e.name==='SecurityError';}})()`),true);
process.env.BOSS_RESUME_CAPTURE_HOOK=new URL('file://'+nativeHook).href;
try{await captureFullResume(taintedPage,taintedIframe,`${dir}/tainted-canvas.png`);}finally{delete process.env.BOSS_RESUME_CAPTURE_HOOK;}
const {readResumeArtifact}=await import('../../../packages/boss-cli-adapter/src/resume-artifacts.ts');
const taintedManifest=await readResumeArtifact(`${dir}/tainted-canvas.png`);
assert.equal(taintedManifest.complete,true);assert.equal(taintedManifest.contentHeight,1854);
assert.equal(await taintedFrame.evaluate('window.expanded'),true);assert.equal(taintedPage.viewport().height,850);
let covered=0;for(const part of taintedManifest.parts){assert(part.offsetY<=covered+2);assert.equal(part.width,1164);assert.equal(part.height,part.cssHeight*2);covered=part.offsetY+part.cssHeight;}assert(covered>=1852);
const tail=taintedManifest.parts.at(-1);
const footer=await page.evaluate(async ({data,y})=>{const i=new Image();i.src=data;await i.decode();const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const x=c.getContext('2d');x.drawImage(i,0,0);return [...x.getImageData(400,y,1,1).data];},{data:'data:image/png;base64,'+(await readFile(`${dir}/${tail.file}`)).toString('base64'),y:tail.height-40});
assert.deepEqual(footer,[18,183,88,255]);
// A compositor failure must preserve its real cause, never become content_empty.
const {captureCResumeIframeToFile}=await import(adapterRequire.resolve('@joohw/boss-cli/dist/common/c_resume_capture.js'));
const taintedScreenshot=taintedPage.screenshot.bind(taintedPage);
taintedPage.screenshot=async()=>{throw new Error('CDP_CAPTURE_TEST_FAILURE');};
try{await assert.rejects(captureCResumeIframeToFile(taintedPage,taintedPage.viewport(),`${dir}/error.png`),/BOSS_RESUME_CAPTURE_FAILED.*CDP_CAPTURE_TEST_FAILURE/);}finally{taintedPage.screenshot=taintedScreenshot;}
assert.equal(taintedPage.viewport().height,850);
console.log(JSON.stringify({ok:true,parts:manifest.parts.length,height:manifest.contentHeight,finalLazySectionPixel:[...pixel],stylesRestored:true,blankPartRejected:true,canvasOverflowCaptured:true,svgSectionExpanded:true,canvasBitmapFallback:true,expansionBeforeLayoutRestore:true,virtualCanvasCaptured:true,shortBlankFooterCaptured:true,nativeCanvasExpansionPreserved:true,transparentCanvasCompositedOnWhite:true,taintedCanvasCaptured:true,nestedClipCoverage:true,deviceScaleTwo:true,taintedFinalFooter:footer,captureErrorPreserved:true,propagatedBodyOverflow:true,nativeScrollbarWidthRestored:true,rightmostCanvasPixelsCaptured:true}));
}finally{await browser.close();await new Promise(r=>server.close(r));}
