/** Native chooser fixture: exercise real DOM actions without touching a BOSS account. */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { ensureBossMajorOptions, readBossMajorCatalog } from './boss-major-catalog.js';

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage();
try {
  await page.setContent(`<div id="filter"><div class="filter-panel"><button class="operate-btn major">修改筛选专业</button></div></div>`);
  await page.evaluate(`(() => {
    const original = ['新闻传播学类','电子商务类','工商管理类','管理科学与工程类','经济与贸易类'].map((name,index)=>({code:index+1,name}));
    const groups = [{name:'经管类',children:original.map(item=>({...item,name:item.code===1?'新闻传播类':item.name}))},{name:'语言类',children:[{code:6,name:'英语'},{code:7,name:'法语'},{code:8,name:'日语'},{code:9,name:'德语'},{code:10,name:'俄语'}]}];
    const vm = { jobId:'job-a',checkedFilters:{},vipFilter$:[{paramName:'major',options:original}],subjectList:groups,$children:[] };
    document.querySelector('#filter').__vue__=vm;
    window.saved=0;window.failSave=false;window.delaySave=0;window.majorVm=vm;
    document.querySelector('.operate-btn').onclick=()=>{
      const chooser={selectSubjectList:vm.vipFilter$[0].options.map(item=>({...item}))};vm.$children=[chooser];
      const dialog=document.createElement('div');dialog.className='filter-subject-dialog';
      dialog.innerHTML='<div class="filter-major-cate"></div><div class="filter-major-names"></div><div class="major-select-list"></div><div class="major-footer-btns"><button class="btn btn-cancel">取消</button><button class="btn">确定</button></div>';
      document.body.append(dialog);
      function selected(){const box=dialog.querySelector('.major-select-list');box.innerHTML='';chooser.selectSubjectList.forEach((item,index)=>{const chip=document.createElement('div');chip.className='major-select-item';chip.textContent=item.name;const close=document.createElement('i');close.className='iboss-close';close.onclick=()=>{if(chooser.selectSubjectList.length<=1)return;chooser.selectSubjectList.splice(index,1);selected()};chip.append(close);box.append(chip)})}
      function category(group){const box=dialog.querySelector('.filter-major-names');box.innerHTML='';group.children.forEach(item=>{const node=document.createElement('div');node.textContent=item.name;node.onclick=()=>{const i=chooser.selectSubjectList.findIndex(v=>v.code===item.code);if(i>=0)chooser.selectSubjectList.splice(i,1);else if(chooser.selectSubjectList.length<5)chooser.selectSubjectList.push({...item});selected()};box.append(node)})}
      groups.forEach(group=>{const node=document.createElement('div');node.textContent=group.name;node.onclick=()=>category(group);dialog.querySelector('.filter-major-cate').append(node)});
      dialog.querySelector('.btn-cancel').onclick=()=>dialog.remove();
      dialog.querySelector('.btn:not(.btn-cancel)').onclick=()=>{window.saved++;dialog.remove();if(!window.failSave)setTimeout(()=>{vm.vipFilter$[0].options=chooser.selectSubjectList.map(item=>({...item}))},window.delaySave)};
      selected();category(groups[0]);
    };
  })()`);
  const frame = page.mainFrame();
  const before = await page.evaluate('JSON.stringify(window.majorVm.vipFilter$)');
  const catalog = await readBossMajorCatalog(frame, 'job-a');
  assert(catalog.majors.some(item => item.name === '英语'));
  assert.equal(await page.evaluate('JSON.stringify(window.majorVm.vipFilter$)'), before);
  assert.equal(await page.evaluate('window.saved'), 0);
  assert.equal(await frame.$('.filter-subject-dialog'), null);
  await assert.rejects(readBossMajorCatalog(frame, 'job-b'), /JOB_CHANGED/);
  await assert.rejects(ensureBossMajorOptions(frame, ['不存在'], 'job-a'), /未找到/);
  assert.equal(await page.evaluate('window.saved'), 0);
  await page.evaluate('window.delaySave=300');
  assert.deepEqual(await ensureBossMajorOptions(frame, ['英语', '新闻传播类'], 'job-a'), ['英语', '新闻传播学类']);
  assert.deepEqual(await page.evaluate('window.majorVm.vipFilter$[0].options.map(x=>x.code).sort()'), [1, 6]);
  assert.equal(await page.evaluate('window.saved'), 1);
  assert.deepEqual(await ensureBossMajorOptions(frame, ['英语', '新闻传播类'], 'job-a'), ['英语', '新闻传播学类']);
  assert.equal(await page.evaluate('window.saved'), 1, 'same codes with aliases do not save again');
  assert.deepEqual(await ensureBossMajorOptions(frame, ['法语','日语','德语','俄语','英语'], 'job-a'), ['法语','日语','德语','俄语','英语']);
  assert.equal(await page.evaluate('window.majorVm.vipFilter$[0].options.length'), 5);
  const saves = await page.evaluate('window.saved');
  assert.deepEqual(await ensureBossMajorOptions(frame, [], 'job-a'), []);
  assert.equal(await page.evaluate('window.saved'), saves, 'unlimited does not erase configured shortcuts');
  await page.evaluate('window.failSave=true');
  await assert.rejects(ensureBossMajorOptions(frame, ['电子商务类'], 'job-a'), /Waiting failed/);
  assert.equal(await frame.$('.filter-subject-dialog'), null);
  console.log(JSON.stringify({ok:true,readOnlyFetch:true,jobMismatch:true,unknownRejectedBeforeSave:true,canonicalAliases:true,waitsForSave:true,replacesFiveChoices:true,idempotent:true,failedSaveRejected:true}));
} finally { await browser.close(); }
