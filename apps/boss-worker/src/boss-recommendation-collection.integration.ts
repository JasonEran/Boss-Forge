/** Synthetic native scroll/API/render cycle. No connection to BOSS. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import puppeteer from 'puppeteer-core';
import { collectRecommendationCards } from './boss-recommendation-collection.js';

let scenario = 'limit';
let requests = 0;
const geek = (n: number) => ({ encryptGeekId: `person-${n}` });
const people = (from: number, to: number) => Array.from({ length: to - from }, (_, n) => geek(from + n));
const server = createServer((req, res) => {
  if (!req.url?.startsWith('/wapi/')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body></body></html>'); return; }
  requests++;
  const page = Number(new URL(req.url, 'http://localhost').searchParams.get('page'));
  const data = { encryptJobId: scenario === 'wrong-job' ? 'other' : 'job', page, hasMore: scenario !== 'end', geekList: scenario === 'end' ? [] : people((page - 1) * 15, page * 15) };
  setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: scenario === 'error' ? 37 : 0, zpData: data })); }, 100);
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); assert(address && typeof address !== 'string');
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const frame = page.mainFrame();
  const setup = async (name: string, count = 15) => {
    scenario = name; requests = 0;
    await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: 'domcontentloaded' });
    await page.setContent(`<style>body{overflow-y:scroll}.card-item{height:100px}</style><div class="card-list"></div><script>
      const root=document.querySelector('.card-list');
      const owner={page$:1,hasMore$:true,loading$:false};
      const vm=root.__vue__={jobId:'job',pageList:[], $parent:{loading:false,finished:false,$parent:owner}};
      window.mode=${JSON.stringify(name)};
      function render(){root.replaceChildren();for(const row of vm.pageList){const el=document.createElement('div');el.className='card-item';el.textContent=row.encryptGeekId||row.memo;root.append(el);}}
      vm.pageList=${JSON.stringify(people(0, count))};render();
      window.addEventListener('scroll',async()=>{
        if(scrollY<=0||scrollY+innerHeight<document.documentElement.scrollHeight-20||vm.$parent.loading||vm.$parent.finished)return;
        vm.$parent.loading=owner.loading$=true;
        const body=await(await fetch('/wapi/zpjob/rec/geek/list?page='+(owner.page$+1))).json();
        setTimeout(()=>{
          if(body.code===0){const d=body.zpData;owner.page$=d.page;owner.hasMore$=d.hasMore;vm.$parent.finished=!d.hasMore;
            if(window.mode==='fallback') vm.pageList.push(...d.geekList.slice(0,3),{cardType:'memo',type:1,memo:'更多推荐'},...d.geekList.slice(3));
            else vm.pageList.push(...d.geekList);
          }
          render();vm.$parent.loading=owner.loading$=false;
        },150);
      });
    </script>`);
  };
  const read = () => frame.evaluate(`document.querySelector('.card-list').__vue__.pageList.filter(x=>x.encryptGeekId).map(x=>({geekId:x.encryptGeekId}))`) as Promise<Array<{ geekId: string }>>;
  await setup('limit');
  let result = await collectRecommendationCards(page, frame, 'job', read, { candidateLimit: 20 });
  assert.equal(result.cards.length, 20); assert.equal(result.stopReason, 'limit'); assert.equal(requests, 1);
  // Reusing the same loaded context for a smaller task must not cause another scroll.
  result = await collectRecommendationCards(page, frame, 'job', read, { candidateLimit: 1 });
  assert.equal(result.cards.length, 1); assert.equal(requests, 1);
  await setup('fallback');
  result = await collectRecommendationCards(page, frame, 'job', read, { candidateLimit: 20 });
  assert.equal(result.cards.length, 18); assert.equal(result.stopReason, 'exhausted'); assert.equal(requests, 1);
  assert(!result.cards.some(c => c.geekId === 'person-18'));
  await setup('end', 13);
  result = await collectRecommendationCards(page, frame, 'job', read, { candidateLimit: 20 });
  assert.equal(result.cards.length, 13); assert.equal(result.stopReason, 'exhausted'); assert.equal(requests, 1);
  for (const name of ['error', 'wrong-job']) {
    await setup(name);
    await assert.rejects(collectRecommendationCards(page, frame, 'job', read, { candidateLimit: 20 }), /BOSS_RECOMMEND_UNVERIFIED/);
    assert.equal(requests, 1);
  }
  console.log(JSON.stringify({ ok: true, loaded15To20: true, nativeScroll: true, delayedResponseAndRender: true, fallbackStoppedAt18: true, emptyFinalPage: true, noExtraScrollAtLimit: true, errorAndWrongJobRejected: true }));
} finally { await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
