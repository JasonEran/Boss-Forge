/** Isolated synthetic DOM test: never connects to BOSS or a user's browser. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import puppeteer from 'puppeteer-core';
import { applyBossRecommendationFilters, readFilterPanel, readBossVipFilterOptions } from './boss-filters-browser.js';
const executablePath = process.env.BOSS_FORGE_TEST_CHROME;
if (!executablePath) throw new Error('BOSS_FORGE_TEST_CHROME must point to an isolated test Chromium executable.');
const server=createServer((request,response)=>{
  if(request.url?.endsWith('-stream'))return;
  response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({code:0,zpData:{encryptJobId:'job-test',geekList:[]}}));
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const address=server.address();assert(address && typeof address!=='string');
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}`,{waitUntil:'domcontentloaded'});
  await page.setContent(`<!doctype html><html><body><div class="card-list"></div><div class="filter-wrap"><button class="filter-label-wrap">筛选</button></div><script>
    const cards=document.querySelector('.card-list');cards.__vue__={pageList:[],$parent:{loading:false}};
    fetch('/chat-stream');fetch('/status-stream');fetch('/metrics-stream');
    const definitions = [
      {paramName:'degree',radio:0,options:[{code:0,name:'不限'},{code:1,name:'本科'},{code:2,name:'硕士'},{code:3,name:'博士'}]},
      {paramName:'experience',radio:0,options:[{code:0,name:'不限'},{code:1,name:'1-3年'}]},
      {paramName:'gender',radio:1,options:[{code:0,name:'不限'},{code:1,name:'女'}]},
      {paramName:'age',name:'年龄',type:2,start:16,end:45},
      {paramName:'school',name:'院校',radio:0,firstDegreeOption:{paramName:'firstDegree',code:1,name:'仅看第一学历',tip:'按第一学历院校筛选'},options:[{code:0,name:'不限'},{code:1,name:'985'}]},
      ...['activation','recentNotView','exchangeResumeWithColleague','switchJobFrequency','intention','salary','keyword1','major'].map(paramName=>({paramName,radio:['intention','keyword1','major'].includes(paramName)?0:1, options:[{code:0,name:'不限'},{code:1,name:paramName+'选项A'},{code:2,name:paramName+'选项B'}]}))
    ];
    const defaults = () => ({...Object.fromEntries(definitions.map(def=>[def.paramName,def.type===2?[def.start,def.end+1]:def.radio===1?0:[0]])),firstDegree:0});
    const root = document.querySelector('.filter-wrap');
    const vm = root.__vue__ = {jobId:'job-test',checkedFilters:defaults(),checked$:defaults(),vipFilter$:definitions.filter(def=>!['degree','experience','intention','salary'].includes(def.paramName)),normalFilter$:definitions.filter(def=>['degree','experience','intention','salary'].includes(def.paramName))};
    window.counts = {clear:0,confirm:0}; window.dropSave=false; window.linkConflict=false;
    function render() {
      document.querySelector('.filter-panel')?.remove();
      const panel = document.createElement('div'); panel.className='filter-panel';
      for(const def of definitions.filter(d=>d.options)) {
        const box = document.createElement('div');box.className='check-box '+def.paramName;
        for(const choice of def.options) {
          const node=document.createElement('button');node.className='option';node.textContent=choice.name;node.__vue__={optionItem:choice};
          if(choice.code===0)node.classList.add('default');
          if([vm.checkedFilters[def.paramName]].flat().includes(choice.code))node.classList.add('active');
          if(def.paramName==='degree' && vm.checkedFilters.gender===1)node.classList.add('disable');
          node.onclick=()=>{
            if(node.classList.contains('disable'))return;
            if(def.radio===1){vm.checkedFilters[def.paramName]=vm.checkedFilters[def.paramName]===choice.code?0:choice.code;render();return;}
            let values=vm.checkedFilters[def.paramName].filter(c=>c!==0);
            values=values.includes(choice.code)?values.filter(c=>c!==choice.code):values.concat(choice.code);
            vm.checkedFilters[def.paramName]=values.length?values:[0];
            if(window.linkConflict && choice.name==='博士')vm.checkedFilters.degree=[3];
            render();
          }; box.append(node);
        }panel.append(box);
      }
      const age=document.createElement('div');age.className='filter-item age';
      const slider=document.createElement('div');slider.className='vue-slider';slider.__vue__={$emit(event,values){if(event!=='change')throw new Error('Wrong slider event');vm.checkedFilters.age=values;render()}};age.append(slider);panel.append(age);
      const first=document.createElement('button');first.className='first-degree-wrap';first.textContent='仅看第一学历';first.onclick=()=>{vm.checkedFilters.firstDegree=vm.checkedFilters.firstDegree?0:1;render()};panel.append(first);
      const buttons=document.createElement('div');buttons.className='btns';
      const clear=document.createElement('button');clear.className='btn default';clear.textContent='清除';clear.onclick=()=>{window.counts.clear++;vm.checkedFilters=defaults();render();};
      const confirm=document.createElement('button');confirm.className='btn';confirm.textContent='确定';confirm.onclick=async()=>{window.counts.confirm++;if(!window.dropSave)vm.checked$=structuredClone(vm.checkedFilters);panel.remove();cards.__vue__.$parent.loading=true;await fetch('/wapi/zpjob/rec/geek/list?page=1');setTimeout(()=>{cards.__vue__.$parent.loading=false;},100);};
      buttons.append(clear,confirm);panel.append(buttons);root.append(panel);
    }
    document.querySelector('.filter-label-wrap').onclick=()=>{const panel=document.querySelector('.filter-panel');if(panel)panel.remove();else {vm.checkedFilters=structuredClone(vm.checked$);render();}};
  </script></body></html>`);
  await assert.rejects(page.waitForNetworkIdle({idleTime:50,timeout:300}),/Timed out/);
  const frame = page.mainFrame();
  const plan = { version: 1 as const, mode: 'custom' as const, fields: { degree: ['本科', '硕士', '博士'] } };
  // Previously selected unrelated filters disable degree options until Clear.
  await page.evaluate("document.querySelector('.filter-wrap').__vue__.checked$.gender=1");
  await applyBossRecommendationFilters(page, frame, plan);
  assert.deepEqual(await page.evaluate('window.counts'), {clear:1,confirm:1});
  await applyBossRecommendationFilters(page, frame, plan);
  assert.deepEqual(await page.evaluate('window.counts'), {clear:1,confirm:1}, 'Same task context must not refresh the recommendation list');
  await assert.rejects(applyBossRecommendationFilters(page, frame, {...plan,fields:{degree:['不存在的选项']}}), /BOSS_FILTER_UNAVAILABLE/);
  assert.deepEqual(await page.evaluate('window.counts'), {clear:1,confirm:1}, 'Unknown labels must not apply partial filters');
  await applyBossRecommendationFilters(page, frame, {...plan,mode:'off',fields:{}});
  await page.evaluate('window.dropSave=true');
  await assert.rejects(applyBossRecommendationFilters(page, frame, plan), /BOSS_FILTER_UNVERIFIED/);
  await page.evaluate('window.dropSave=false; window.linkConflict=true');
  await assert.rejects(applyBossRecommendationFilters(page, frame, plan), /BOSS_FILTER_CONFLICT/);
  const state = await readFilterPanel(frame);
  assert.equal(state.unmanagedActive, false, 'Neutral [0] first-degree selection must remain neutral');
  await page.evaluate('window.linkConflict=false');
  const snapshot = readBossVipFilterOptions(state, 'job-test', '测试岗位');
  assert.equal(snapshot.definitions?.length, 14, 'Every VIP and normal field, including first-degree, must be mapped');
  assert.deepEqual(snapshot.definitions?.find(field=>field.key==='age')?.range, {min:16,max:45,step:1});
  const fullPlan = {version:1 as const,mode:'custom' as const,fields:{
    age:['22','35'] as [string,string],activation:['activation选项A'],recentNotView:['recentNotView选项A'],
    exchangeResumeWithColleague:['exchangeResumeWithColleague选项A'],school:['985'],firstDegree:['仅看第一学历'],
    switchJobFrequency:['switchJobFrequency选项A'],experience:['1-3年'],intention:['intention选项A'],degree:['本科'],salary:['salary选项A'],keyword1:['keyword1选项A'],major:['major选项A'],
  }};
  await applyBossRecommendationFilters(page,frame,fullPlan);
  const committed = await page.evaluate('document.querySelector(".filter-wrap").__vue__.checked$') as Record<string,unknown>;
  assert.deepEqual(committed.age,[22,35]);assert.equal(committed.firstDegree,1);assert.equal(committed.salary,1);
  const counts = await page.evaluate('window.counts');
  await applyBossRecommendationFilters(page,frame,fullPlan);
  assert.deepEqual(await page.evaluate('window.counts'),counts,'Full VIP plan must also be idempotent');
  await applyBossRecommendationFilters(page,frame,{...fullPlan,fields:{age:['22','不限'],salary:['salary选项B']}});
  assert.deepEqual(await page.evaluate('document.querySelector(".filter-wrap").__vue__.checked$.age'),[22,46]);
  assert.equal(await page.evaluate('document.querySelector(".filter-wrap").__vue__.checked$.firstDegree'),0);
  await assert.rejects(applyBossRecommendationFilters(page,frame,{...fullPlan,fields:{age:['22','80']}}),/BOSS_FILTER_UNAVAILABLE/);
  // Acquiring a complete snapshot is read-only, even when VIP is unavailable.
  await page.evaluate('document.querySelector(".filter-wrap").__vue__.showVipFilters=false');
  const locked = readBossVipFilterOptions(await readFilterPanel(frame),'job-test','测试岗位');
  assert(locked.definitions?.filter(field=>field.source==='vip').every(field=>!field.available));
  assert(locked.definitions?.filter(field=>field.source==='normal').every(field=>field.available));
  await assert.rejects(readFilterPanel(frame,'different-job'),/BOSS_FILTER_JOB_CHANGED/);
  await page.evaluate('document.querySelector(".filter-wrap").__vue__.showVipFilters=true');
  const beforeFetch = await page.evaluate('JSON.stringify(document.querySelector(".filter-wrap").__vue__.checked$)');
  readBossVipFilterOptions(await readFilterPanel(frame,'job-test'),'job-test','测试岗位');
  assert.equal(await page.evaluate('JSON.stringify(document.querySelector(".filter-wrap").__vue__.checked$)'),beforeFetch);
  await applyBossRecommendationFilters(page,frame,{version:1,mode:'custom',fields:{gender:['女']}},'job-test');
  assert.equal(await page.evaluate('document.querySelector(".filter-wrap").__vue__.checked$.gender'),1);

  console.log('Full VIP filters browser integration passed: 14 fields, ranges, first-degree, single/multiple selections, neutral reset, idempotence, missing options, rejected save, linked conflicts, locked VIP.');
} finally { await browser.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve())); }
