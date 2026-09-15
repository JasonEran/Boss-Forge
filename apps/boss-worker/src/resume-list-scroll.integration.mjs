import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {scrollRecommendationList} from './resume-list-recovery.ts';
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage'],headless:true});
try{
 const page=await browser.newPage();await page.setViewport({width:1100,height:780});
 await page.setContent('<!doctype html><style>html,body{height:100%;margin:0}body{overflow-y:scroll}.card-list{height:3000px;margin:0}</style><ul class="card-list"><li>First batch</li></ul><script>window.addEventListener("scroll",()=>{if(window.scrollY>=document.documentElement.scrollHeight-innerHeight-5&&!document.querySelector(".later")){document.querySelector(".card-list").style.height="5000px";document.querySelector(".card-list").insertAdjacentHTML("beforeend","<li class=later>Later batch</li>")}})</script>');
 const broken=await page.evaluate(()=>{document.body.scrollTop=600;return document.body.scrollTop;});assert.equal(broken,0);
 assert.equal(await scrollRecommendationList(page.mainFrame(),false),true);
 await page.waitForSelector('.later',{timeout:3000});assert((await page.evaluate(()=>scrollY))>2000);
 await scrollRecommendationList(page.mainFrame(),true);assert.equal(await page.evaluate(()=>scrollY),0);
 await page.setContent('<!doctype html><style>body{margin:0}</style><div class="nested" style="height:500px;overflow-y:auto"><ul class="card-list" style="height:2500px;margin:0"><li>Nested list</li></ul></div>');
 assert.equal(await scrollRecommendationList(page.mainFrame(),false),true);
 assert.equal(await page.$eval('.nested',n=>n.scrollTop),2000);assert.equal(await page.evaluate(()=>scrollY),0);
 console.log(JSON.stringify({ok:true,bodyOverflowRegression:true,laterBatchLoaded:true,nestedScroller:true}));
}finally{await browser.close();}
