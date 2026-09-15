import {randomUUID} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {processCommunicationResumeAnalysis} from './communication-resume-analysis.js';
const job={conversationId:'conversation',accountId:'account',claimId:randomUUID(),snapshot:{geekId:'test-geek',capturedAt:'2026-09-11T00:00:00.000Z',screenshotPath:'/saved/resume.png',text:'',textStatus:'processing' as const}};
function repository(){return {claimOnlineResumeAnalysis:vi.fn(async():Promise<typeof job|null>=>job),renewOnlineResumeAnalysis:vi.fn(async()=>true),finishOnlineResumeAnalysis:vi.fn(async()=>true)};}
describe('background chat resume analysis',()=>{
  it('analyzes the saved screenshot without any browser operation',async()=>{
    const repo=repository(),recognize=vi.fn(async()=>({text:'教育经历：某大学英语专业本科毕业，工作经历：海外内容运营。语言能力：通过英语专业八级。'}));
    await processCommunicationResumeAnalysis('account',repo,{configured:()=>true,recognize,resolve:async p=>p});
    expect(recognize).toHaveBeenCalledWith(job.snapshot.screenshotPath);
    expect(repo.finishOnlineResumeAnalysis).toHaveBeenCalledWith(job,{text:expect.stringContaining('英语专业八级')});
  });
  it('preserves screenshots and records a retryable result when analysis fails',async()=>{
    const repo=repository();await processCommunicationResumeAnalysis('account',repo,{configured:()=>true,recognize:async()=>{throw Error('secret provider detail');},resolve:async p=>p});
    expect(repo.finishOnlineResumeAnalysis).toHaveBeenCalledWith(job,{text:'',error:'简历分析暂未完成，可重试分析；截图已保留。'});
  });
  it('does not call OCR when no job exists or the image cannot be resolved',async()=>{
    const recognize=vi.fn(async()=>({text:''})),repo=repository();
    await processCommunicationResumeAnalysis('account',repo,{configured:()=>true,recognize,resolve:async()=>{throw Error('outside root');}});expect(recognize).not.toHaveBeenCalled();
    repo.claimOnlineResumeAnalysis.mockResolvedValue(null);
    expect(await processCommunicationResumeAnalysis('account',repo,{configured:()=>true,recognize,resolve:async p=>p})).toBe(false);expect(recognize).not.toHaveBeenCalled();
  });
});
