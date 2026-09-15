import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { retryRecommendationContext } from './boss-jobs-browser.js';

describe('replaced recommendation iframe recovery', () => {
  it('reacquires context after the actual detached Frame error, without hiding other errors', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("Attempted to use detached Frame 'old'."))
      .mockRejectedValueOnce(new Error('Execution context was destroyed, most likely because of a navigation.'))
      .mockResolvedValue('current-list');
    expect(await retryRecommendationContext(read)).toBe('current-list');
    expect(read).toHaveBeenCalledTimes(3);
    const invalid = vi.fn().mockRejectedValue(new Error('BOSS_JOB_NOT_FOUND'));
    await expect(retryRecommendationContext(invalid)).rejects.toThrow('BOSS_JOB_NOT_FOUND');
    expect(invalid).toHaveBeenCalledOnce();
  });
  it('stops after three transient failures rather than retrying indefinitely', async () => {
    const read = vi.fn().mockRejectedValue(new Error('detached frame'));
    await expect(retryRecommendationContext(read)).rejects.toThrow('detached frame');
    expect(read).toHaveBeenCalledTimes(3);
  });
});

describe('BOSS browser callbacks under the actual tsx runtime', () => {
  it('reads job catalog and recommendation options after serialization into a clean browser context', () => {
    const script = String.raw`
      import {runInNewContext} from 'node:vm';
      import {readJobPage, readJobOptions} from './apps/boss-worker/src/boss-jobs-browser.ts';
      const node = {textContent:' 海外运营 ', getAttribute: key => ['data-id', 'value'].includes(key) ? 'job-123' : null,
        querySelector: selector => ({textContent:selector.includes('status')?'招聘中':'海外运营'}), matches: selector => selector === '.curr'};
      const document = {querySelectorAll: () => [node], querySelector: () => ({textContent:'共 1 个岗位'})};
      const frame = {evaluate: async callback => runInNewContext(typeof callback === 'string' ? callback : '('+callback.toString()+')()', {document})};
      process.stdout.write(JSON.stringify({catalog: await readJobPage(frame), options: await readJobOptions(frame)}));
    `;
    const output = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8', cwd: new URL('../../../', import.meta.url), timeout: 15000 }));
    expect(output.catalog).toEqual({ jobs: [{ id: 'job-123', name: '海外运营', status: '招聘中' }], total: 1, ready: true });
    expect(output.options[0]).toMatchObject({ id: 'job-123', name: '海外运营', index: 0, disabled: false, current: true });
  });
});

describe('BOSS job_v2 rendered cards', () => {
  it('keeps identical job names bound to their distinct IDs from visible Vue 3 cards', () => {
    const script = String.raw`
      import {runInNewContext} from 'node:vm';
      import {readJobPage} from './apps/boss-worker/src/boss-jobs-browser.ts';
      const rows=[0,1].map(i=>({getAttribute:()=>null,querySelector:s=>({textContent:s.includes('status')?['开放中','待开放'][i]:'亚马逊运营'})}));
      const children=rows.map((el,i)=>({component:{props:{jobInfo:{encryptJobId:'job-'+i}},subTree:{el}}}));
      const root={component:{subTree:{children}}}; children.push(root);
      const document={querySelectorAll:()=>rows,querySelector:s=>s==='#app'?{_vnode:root}:{textContent:'共2个职位'}};
      const frame={evaluate:async source=>runInNewContext(source,{document})};
      process.stdout.write(JSON.stringify(await readJobPage(frame)));
    `;
    const result=JSON.parse(execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{encoding:'utf8',cwd:new URL('../../../',import.meta.url),timeout:15000}));
    expect(result).toEqual({jobs:[{id:'job-0',name:'亚马逊运营',status:'开放中'},{id:'job-1',name:'亚马逊运营',status:'待开放'}],total:2,ready:true});
  });
  it('waits for cards when a positive total renders before the list, while allowing a real empty account', () => {
    const script = String.raw`
      import {runInNewContext} from 'node:vm';
      import {readJobPage} from './apps/boss-worker/src/boss-jobs-browser.ts';
      const results=[];
      for(const text of ['共12个职位','共0个职位','共 个职位']){
        const document={querySelectorAll:()=>[],querySelector:s=>s==='#app'?null:{textContent:text}};
        results.push(await readJobPage({evaluate:async source=>runInNewContext(source,{document})}));
      }
      process.stdout.write(JSON.stringify(results));
    `;
    const result=JSON.parse(execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{encoding:'utf8',cwd:new URL('../../../',import.meta.url),timeout:15000}));
    expect(result.map((row:{ready:boolean})=>row.ready)).toEqual([false,true,false]);
  });
});
