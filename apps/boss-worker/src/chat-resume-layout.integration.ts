import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { prepareChatResumeLayout } from './chat-resume-layout.js';
const browser=await puppeteer.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try {
  const page=await browser.newPage();await page.setViewport({width:1280,height:900});
  await page.setContent('<style>::-webkit-scrollbar{width:4px} .resume-detail-chat{width:734px;height:500px;overflow:auto;scrollbar-gutter:stable}iframe{width:734px;height:2000px;border:0}</style><div class="boss-popup__wrapper"><div class="resume-detail-wrap"><div class="resume-detail-chat"><iframe></iframe></div></div></div>');
  const frame=(await page.$('iframe'))!;
  const width=()=>page.$eval('.resume-detail-chat',n=>n.clientWidth);
  assert.equal(await width(),730);
  const restore=await frame.evaluateHandle(prepareChatResumeLayout);
  assert.equal(await width(),734,'complete canvas width must be visible');
  assert(await page.$eval('.resume-detail-chat',n=>n.scrollHeight>n.clientHeight),'native scrolling remains available');
  await restore.evaluate(fn=>fn());await restore.dispose();assert.equal(await width(),730,'original scrollbar restored');
  console.log(JSON.stringify({ok:true,clippedWidth:730,captureWidth:734,restoredWidth:730}));
}finally{await browser.close()}
