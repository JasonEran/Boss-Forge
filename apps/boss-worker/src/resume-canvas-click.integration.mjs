import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {clickResumeExpansion} from './resume-canvas-expansion.mjs';
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage'],headless:true});
try{
 const page=await browser.newPage();await page.setViewport({width:1100,height:780});
 await page.setContent('<!doctype html><style>body{margin:0}.panel{height:700px;overflow:auto}iframe{border:0;width:580px;height:1632px}</style><div class="panel"><iframe></iframe></div>');
 const iframe=await page.$('iframe');await iframe.evaluate(el=>el.srcdoc='<!doctype html><style>body{margin:0}canvas{display:block}</style><canvas width="580" height="1646"></canvas><script>window.clicks=[];document.querySelector("canvas").onclick=e=>window.clicks.push({x:e.clientX,y:e.clientY,scroll:scrollY});</script>');
 const frame=await iframe.contentFrame();await frame.waitForSelector('canvas');await frame.evaluate(()=>scrollTo(0,14));
 await clickResumeExpansion(page,frame,{x:508,y:220});
 assert.deepEqual(await frame.evaluate(()=>window.clicks),[{x:508,y:220,scroll:0}]);
 await iframe.evaluate(el=>el.style.height='3000px');await frame.evaluate(()=>document.querySelector('canvas').height=3000);
 await clickResumeExpansion(page,frame,{x:508,y:2000});
 assert.deepEqual(await frame.evaluate(()=>window.clicks.at(-1)),{x:508,y:2000,scroll:0});
 assert((await page.$eval('.panel',el=>el.scrollTop))>1000);
 assert.equal(await frame.evaluate(()=>document.querySelectorAll('span').length),0);
 console.log(JSON.stringify({ok:true,canvasCoordinatesPreserved:true,belowFoldParentScrolled:true,markersRemoved:true}));
}finally{await browser.close();}
