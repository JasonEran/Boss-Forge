import puppeteer from 'puppeteer-core';
import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const fixture=JSON.parse(await readFile('/tmp/boss-resume-ui-fixture.json','utf8'));
const origin=process.env.BOSS_UI_TEST_URL || 'http://127.0.0.1:3049';
assert(new URL(origin).hostname==='127.0.0.1');
const dir=process.env.BOSS_CAPTURE_TEST_OUTPUT || '/tmp/boss-full-resume-capture-test';await mkdir(dir,{recursive:true});
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
try {
const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
await page.evaluateOnNewDocument(token=>sessionStorage.setItem('boss-forge.session-token',token),fixture.token);
await page.setViewport({width:1440,height:1000});await page.goto(origin+'/candidates',{waitUntil:'networkidle0'});
await page.waitForFunction(()=>document.body.innerText.includes('长简历测试样本'));
async function click(text){await page.evaluate(label=>{const button=[...document.querySelectorAll('button')].find(b=>b.offsetWidth&&b.innerText.trim()===label);if(!button)throw new Error('Missing button '+label);button.click();},text);}
await click('长简历测试样本');
await page.waitForFunction(()=>document.querySelectorAll('section[aria-label="简历预览"] img').length===10 && [...document.querySelectorAll('section[aria-label="简历预览"] img')].every(img=>img.complete&&img.naturalHeight>0));
assert.equal(await page.evaluate(()=>document.querySelector('section[aria-label="简历预览"]').innerText.includes('完整截图 · 共 10 段')),true);
const region='section[aria-label="简历图片，滚动查看全部内容"]';
await page.$eval(region,el=>el.scrollTop=el.scrollHeight);
await page.screenshot({path:dir+'/review-desktop-bottom.png'});
await click('放大查看');await page.$eval(region,el=>el.scrollTop=el.scrollHeight);
assert.equal(await page.evaluate(()=>[...document.querySelectorAll('button')].some(b=>b.innerText==='适合宽度')),true);
await page.setViewport({width:390,height:844});await click('适合宽度');
await page.$eval(region,el=>el.scrollTop=el.scrollHeight);
await page.$eval(region,el=>el.scrollIntoView({block:'center'}));
await page.screenshot({path:dir+'/review-mobile-bottom.png'});
assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
await page.keyboard.press('Escape');
await page.goto(origin+'/positions',{waitUntil:'networkidle0'});await click('编辑岗位规则');
await page.waitForFunction(()=>document.body.innerText.includes('第二步 · 我们补充核验'));
assert.equal(await page.$('#boss-filter-mode'),null);
assert.equal(await page.$('#minimum-education'),null);
assert.equal(await page.$('input[aria-label="最少工作年限"]'),null);
await page.screenshot({path:dir+'/rule-mobile.png'});
assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
await page.setViewport({width:1440,height:1000});await page.screenshot({path:dir+'/rule-desktop.png'});
assert.deepEqual(errors,[]);
console.log(JSON.stringify({ok:true,allTenImagesLoaded:true,zoom:true,desktopAndMobile:true,noPageErrors:true,splitRuleEditor:true}));
}finally{await browser.close();}
