/** Disposable local DB only. No BOSS browser or contact dispatch is invoked. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertIsolatedTestDatabase, createDatabase, BossForgeRepository, DepartmentAtsRepository, M2Repository, type SessionPrincipal, type CandidateEvaluationRecord } from './index.js';

assertIsolatedTestDatabase(process.env, {contactSideEffects:false});
const sql=createDatabase();
try {
  const repo=new BossForgeRepository(sql), ats=new DepartmentAtsRepository(sql), m2=new M2Repository(sql);
  assert.equal((await sql`select allowed_end_minute from contact_settings where id='global'`)[0]!.allowed_end_minute,1260,'fresh migrations use the 21:00 default');
  await ats.ensureBootstrap({departmentName:'Contact test',adminEmail:'contact-ready@example.invalid',adminName:'Contact test',password:'DisposableContactTest123!'});
  const admin=(await sql`select id,department_id,email,display_name,role from users where email='contact-ready@example.invalid'`)[0]!;
  const principal:SessionPrincipal={userId:admin.id,departmentId:admin.department_id,email:admin.email,displayName:admin.display_name,role:admin.role};
  const position=await ats.createAssignedPosition(principal,{bossAccountId:'contact-ready-test',name:'联系测试岗位',ownerName:'Contact test'});
  await repo.createRuleVersion({positionId:position.id,name:'Test',config:{requiredCapabilities:[{capability:'tem8',minimumConfidence:0.9}]},dictionaryVersion:'test.1',createdBy:admin.id});
  const taskInput={positionId:position.id,source:'recommend' as const,createdBy:admin.id,candidateLimit:1};
  const overridden=await repo.createImmediateTask({...taskInput,idempotencyKey:randomUUID()});
  const missing=await repo.createImmediateTask({...taskInput,idempotencyKey:randomUUID()});
  const policy={startMinute:540,endMinute:1260,dailyLimit:20,hourlyLimit:10,cooldownMinutes:30};
  const control={enabled:true,emergencyStop:false,approvalRequired:false,policy};
  await ats.setContactControl(principal,{...control,scopeType:'global',scopeId:'global'});
  const hours=(await sql`select allowed_start_minute,allowed_end_minute from contact_settings where id='global'`)[0]!;
  assert.equal(hours.allowed_start_minute,540);assert.equal(hours.allowed_end_minute,1260);
  await assert.rejects(ats.setContactControl(principal,{...control,enabled:false,scopeType:'global',scopeId:'global',policy:{startMinute:1260,endMinute:540}}),/联系时段/);
  assert.equal((await sql`select enabled from contact_controls where scope_type='global'`)[0]!.enabled,true,'invalid hours must not partly update the switch');
  await ats.setContactControl(principal,{...control,scopeType:'department',scopeId:admin.department_id});
  await ats.setContactControl(principal,{...control,scopeType:'task',scopeId:overridden.id,enabled:false});
  await ats.setContactControl(principal,{...control,scopeType:'position',scopeId:position.id});
  const existing=await sql`select scope_id,enabled from contact_controls where scope_type='task'`;
  assert.equal(existing.find(row=>row.scope_id===overridden.id)?.enabled,false);
  assert.equal(existing.find(row=>row.scope_id===missing.id)?.enabled,true);
  const inherited=await repo.createImmediateTask({...taskInput,idempotencyKey:randomUUID()});
  const inheritedControl=(await sql`select enabled,emergency_stop,policy from contact_controls where scope_type='task' and scope_id=${inherited.id}`)[0]!;
  assert.equal(inheritedControl.enabled,true);assert.equal(inheritedControl.emergency_stop,false);assert.deepEqual(inheritedControl.policy,policy);
  await sql`update tasks set status='cancelled' where id in (${overridden.id},${missing.id})`;
  const job=await repo.claimNextTask('contact-test-worker',position.bossAccountId);assert.equal(job?.id,inherited.id);
  const record:CandidateEvaluationRecord={sourceReference:'recommend:1:Contact Fixture',sourceLocator:{kind:'boss_geek_id',value:'contact-ready-fixture'},source:'recommend',displayName:'Contact Fixture',fingerprint:randomUUID(),rawFields:{},sourceEvidence:[],rawText:'Synthetic resume',decision:'matched',confidence:1,capabilityId:'language.english.tem8',canonicalLabel:'TEM-8',dictionaryVersion:'test.1',currentEnglishLevel:'TEM-8',reasonCodes:[],evidence:[]};
  await repo.completeTask(job!,[record]);
  const state=(await sql`select id from candidate_position_states where latest_task_id=${inherited.id}`)[0]!;
  await sql`update candidate_position_states set resume_screening_status='screened',review_status='approved',version=version+1 where id=${state.id}`;
  const now='2026-09-08T12:00:00.000Z';
  const readiness=(minute:number)=>m2.previewContactReadiness({stateId:state.id,actionKind:'greet',now,localMinuteOfDay:minute});
  await m2.recordVerifiedBossAccountHealth(position.bossAccountId,'2026-09-08T11:29:00.000Z');
  assert((await readiness(1200)).reasons.includes('authoritative_boss_account_health'));
  await m2.recordVerifiedBossAccountHealth(position.bossAccountId,now);
  assert.equal((await readiness(1200)).ready,true);
  for(const [minute,allowed] of [[539,false],[540,true],[1259,true],[1260,false]] as const) {
    assert.equal((await readiness(minute)).checks.find(check=>check.key==='outside_allowed_hours')?.passed,allowed);
  }
  await sql`update account_health set status='blocked' where boss_account_id=${position.bossAccountId}`;
  await m2.recordVerifiedBossAccountHealth(position.bossAccountId,now);
  assert.equal((await readiness(1200)).ready,false,'a successful login read does not erase an explicit account block');
  assert.equal(Number((await sql`select count(*) from contact_intents`)[0]!.count),0);
  console.log(JSON.stringify({ok:true,window:'09:00–21:00',boundariesVerified:true,existingTasksInitialized:true,newTaskInherits:true,explicitTaskOverridePreserved:true,staleHealthRecovered:true,blockedAccountPreserved:true,noContactIntents:true}));
} finally {await sql.end()}
