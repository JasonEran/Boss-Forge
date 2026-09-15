/** Local DOM + persistent chat requests. Never connects to BOSS. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import puppeteer from 'puppeteer-core';
import { selectRecommendationJob } from './boss-jobs-browser.js';

const html = `<!doctype html><style>.job-selecter-options{display:none}</style>
<div class="job-selecter-wrap"><button class="ui-dropmenu-label">其他岗位</button></div>
<div class="job-selecter-options"><input class="chat-job-search"><div class="job-list"></div></div>
<button class="filter-label-wrap">筛选</button><div class="card-list"></div>
<script>
const jobs=[{id:'other',name:'其他岗位'},{id:'one',name:'海外运营'},{id:'two',name:'海外运营'}];
let current='other'; window.jobClicks=0;
const cards=document.querySelector('.card-list');cards.__vue__={pageList:[],$parent:{loading:false}};
const dropdown=document.querySelector('.job-selecter-options');
const input=document.querySelector('input');
const label=document.querySelector('.ui-dropmenu-label');
function render(){
 const list=document.querySelector('.job-list');list.replaceChildren();
 for(const job of jobs.filter(j=>j.name.includes(input.value)||j.id==='other')){
  const node=document.createElement('button');node.className='job-item'+(job.id===current?' curr':'');node.dataset.id=job.id;
  const name=document.createElement('span');name.className='job-name label';name.textContent=job.name;node.append(name);
  node.onclick=async()=>{window.jobClicks++;current=job.id;window.selectedJob=job.id;label.textContent=job.name;dropdown.style.display='none';render();cards.__vue__.$parent.loading=true;const r=await fetch('/wapi/zpjob/rec/geek/list?page=1&jobId='+job.id);const body=await r.json();setTimeout(()=>{cards.__vue__.pageList=body.zpData.geekList;cards.__vue__.$parent.loading=false;},250);};
  list.append(node);
 }
}
label.onclick=()=>{dropdown.style.display=dropdown.style.display==='block'?'none':'block';input.value='';render();};
input.oninput=()=>{setTimeout(render,200);};
render();
fetch('/chat-stream');fetch('/status-stream');fetch('/metrics-stream');
</script>`;
const server = createServer((request, response) => {
  if (request.url?.startsWith('/wapi/zpjob/rec/geek/list')) { const jobId=new URL(request.url,'http://localhost').searchParams.get('jobId');response.writeHead(200, {'content-type':'application/json'});response.end(JSON.stringify({code:0,zpData:{encryptJobId:jobId,geekList:[{encryptGeekId:'person-'+jobId}]}}));return; }
  if (request.url?.endsWith('-stream')) return; // Deliberately never idle.
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html);
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); assert(address && typeof address !== 'string');
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: 'domcontentloaded' });
  await assert.rejects(page.waitForNetworkIdle({ idleTime: 50, timeout: 300 }), /Timed out/);
  const reader = { ensureInRecommendPage: async () => page.mainFrame(), readRecommendList: async () => [], renderRecommendList: () => '' };
  const job = { id: 'two', name: '海外运营', allowNameFallback: false };
  const options = { reader };
  const selected = await selectRecommendationJob(page, job, options);
  assert.equal(selected.selected.id, 'two');
  assert.deepEqual(await page.evaluate('document.querySelector(".card-list").__vue__.pageList'),[{encryptGeekId:'person-two'}]);
  assert.equal(await page.evaluate('window.selectedJob'), 'two', 'Same-name jobs must remain bound to their exact ID');
  assert.equal(await page.evaluate('window.jobClicks'), 1);
  await selectRecommendationJob(page, job, options);
  assert.equal(await page.evaluate('window.jobClicks'), 1, 'Reading the active job must not switch it again');
  await assert.rejects(selectRecommendationJob(page, { ...job, id: 'absent' }, options), /BOSS_JOB_NOT_FOUND/);
  assert.equal(await page.evaluate('window.jobClicks'), 1);
  console.log(JSON.stringify({ ok: true, persistentTraffic: true, renderedResponseConfirmed: true, delayedSearchResults: true, exactSameNameJobId: true, noRedundantSwitch: true, missingJobRejected: true, candidateReads: 0 }));
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}
