import {homedir} from 'node:os';
import {join} from 'node:path';
import {readResumeArtifact,resolveResumeFile} from '@boss-forge/boss-cli-adapter';
import {CommunicationRepository,createDatabase} from '@boss-forge/data';
import {recognizeResumeWithTencentOcr,resumeOcrLooksUsable,tencentOcrConfigured} from './tencent-ocr.js';

type AnalysisRepository=Pick<CommunicationRepository,'claimOnlineResumeAnalysis'|'renewOnlineResumeAnalysis'|'finishOnlineResumeAnalysis'>;
export async function processCommunicationResumeAnalysis(accountId:string,repository:AnalysisRepository,dependencies:{
  configured():boolean;
  recognize(path:string):Promise<{text:string}>;
  resolve(path:string):Promise<string>;
}={
  configured:tencentOcrConfigured,
  recognize:recognizeResumeWithTencentOcr,
  resolve:async path=>{
    const root=process.env.BOSS_FORGE_RESUME_SCREENSHOT_DIR?.trim()||join(homedir(),'.boss-cli','.cache','resume-screenshots');
    const file=await resolveResumeFile(path,root);
    if(!(await readResumeArtifact(file)).complete)throw Error('Incomplete resume capture');
    return file;
  },
}) {
  const job=await repository.claimOnlineResumeAnalysis(accountId);
  if(!job)return false;
  const heartbeat=setInterval(()=>{void repository.renewOnlineResumeAnalysis(job).catch(()=>{});},20000);
  heartbeat.unref();
  try{
    if(!dependencies.configured()){
      await repository.finishOnlineResumeAnalysis(job,{text:'',error:'文字识别服务尚未配置，截图可以正常查看。'});return true;
    }
    const file=await dependencies.resolve(job.snapshot.screenshotPath);
    const result=await dependencies.recognize(file);
    const text=resumeOcrLooksUsable(result.text)?result.text.trim():'';
    await repository.finishOnlineResumeAnalysis(job,{text,...(!text?{error:'未识别到足够的简历内容，可重试分析或直接查看截图。'}:{})});
  }catch{
    await repository.finishOnlineResumeAnalysis(job,{text:'',error:'简历分析暂未完成，可重试分析；截图已保留。'});
  }finally{clearInterval(heartbeat);}
  return true;
}

/** Durable image-only jobs continue independently of BOSS login and screening. */
export function startCommunicationResumeAnalysis(accountId:string) {
  const sql=createDatabase(),repository=new CommunicationRepository(sql);
  let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,running:Promise<void>|null=null;
  const tick=()=>{
    if(stopped)return;
    running=(async()=>{
      try{await processCommunicationResumeAnalysis(accountId,repository);}
      catch(error){console.error('Communication resume analysis worker failed:',error instanceof Error?error.message:String(error));}
      finally{running=null;if(!stopped)timer=setTimeout(tick,2000);}
    })();
  };
  timer=setTimeout(tick,0);
  return async ()=>{
    stopped=true;clearTimeout(timer);
    await (running??Promise.resolve()).then(()=>sql.end()).catch(()=>{});
  };
}
