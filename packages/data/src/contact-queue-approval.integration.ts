/** Disposable local DB only. Exercises dispatch policy; never invokes BOSS transport. */
import assert from 'node:assert/strict';
import { issueContactPreviewApproval, contactPreviewApprovalIdempotencyKey, type ContactPreviewApprovalContext } from '@boss-forge/contracts';
import { randomUUID } from 'node:crypto';
import { assertIsolatedTestDatabase, createDatabase, BossForgeRepository, DepartmentAtsRepository, M2Repository, type SessionPrincipal, type CandidateEvaluationRecord } from './index.js';

assertIsolatedTestDatabase(process.env, {contactSideEffects:true});
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
  process.env.BOSS_FORGE_CONTACT_DISPATCH_MODE = 'real';
  process.env.BOSS_FORGE_REAL_GREET_ENABLED = '1';
  const signingKey = 'isolated-queue-test-signing-key-32-bytes';
  process.env.BOSS_FORGE_CONTACT_PREVIEW_SIGNING_KEY = signingKey;
  const acceptedAt = new Date(Date.now() - 3_600_000);
  const dispatchAt = new Date();
  await m2.recordVerifiedBossAccountHealth(position.bossAccountId, dispatchAt.toISOString());
  const candidate = (await sql`select candidate_id from candidate_position_states where id=${state.id}`)[0]!;
  const expected: ContactPreviewApprovalContext = {
    actionKind: 'greet', approvedBy: admin.id, candidateStateId: state.id,
    candidateId: candidate.candidate_id, candidateName: record.displayName,
    positionId: position.id, positionName: position.name, taskId: inherited.id,
    bossAccountId: position.bossAccountId, source: 'recommend', sourceLocator: record.sourceLocator!,
    templateVersionId: null, providerJobId: 'isolated-boss-job',
    providerGreetingId: 'isolated-greeting', renderedMessage: 'ISOLATED TEST — NEVER SEND'
  };
  const realApproval = issueContactPreviewApproval({ context: expected, signingKey, now: acceptedAt, ttlMs: 600_000 });
  const request = {
    stateId: state.id, actionKind: 'greet' as const,
    idempotencyKey: contactPreviewApprovalIdempotencyKey('greet', realApproval.approval.approvalId),
    templateVersionId: null, providerJobId: expected.providerJobId, providerGreetingId: expected.providerGreetingId,
    renderedMessage: expected.renderedMessage, createdBy: admin.id, localMinuteOfDay: 600,
    now: acceptedAt.toISOString(), transportMode: 'real' as const, realApproval, intervalSeconds: 10
  };
  await assert.rejects(m2.createManualContactIntent({ ...request, now: dispatchAt.toISOString() }), /contact_preview_approval_signature_invalid/);
  await assert.rejects(m2.createManualContactIntent({...request,intervalSeconds:9}), /10–600/);
  const intent = await m2.createManualContactIntent(request);
  await assert.rejects(sql`update contact_intents set interval_seconds=9 where id=${intent.id}`, /contact_intents_interval_seconds_check/);
  const stored = (await sql`select policy_snapshot from contact_intents where id=${intent.id}`)[0]!.policy_snapshot;
  assert.equal(typeof stored.contactQueueApprovalToken, 'string');
  assert.equal((await m2.createManualContactIntent(request)).id, intent.id, 'confirmation remains idempotent');
  const dispatch = await m2.claimContactDispatch('isolated-queue-test', 'real', position.bossAccountId);
  assert(dispatch);
  const check = () => m2.assertContactDispatchAllowed({job: dispatch, localMinuteOfDay:600, now:dispatchAt.toISOString()});
  await check();
  await sql`update contact_controls set enabled=false where scope_type='position' and scope_id=${position.id}`;
  await assert.rejects(check(), /contact_control_position_disabled/);
  await sql`update contact_controls set enabled=true where scope_type='position' and scope_id=${position.id}`;
  await sql`update contact_intents set policy_snapshot=policy_snapshot-'contactQueueApprovalToken' where id=${intent.id}`;
  await assert.rejects(check(), /contact_preview_approval_expired/);
  await sql`update contact_intents set policy_snapshot=${sql.json(stored)} where id=${intent.id}`;
  await sql`update contact_intents set rendered_message='Changed after confirmation' where id=${intent.id}`;
  await assert.rejects(check(), /dispatch_context_changed/);
  await sql`update contact_intents set rendered_message=${expected.renderedMessage} where id=${intent.id}`;
  await assert.rejects(m2.assertContactDispatchAllowed({job:dispatch,localMinuteOfDay:600,now:new Date(acceptedAt.getTime()+86_400_000).toISOString()}), /contact_queue_approval_expired/);
  await check();
  const controlBefore=await m2.contactDispatchControl(position.id);
  assert.equal(controlBefore.internalQuotasEnabled,false);
  assert.equal(controlBefore.paused,false);
  await m2.setContactDispatchPaused(position.id,true,admin.id);
  assert.equal((await m2.contactDispatchControl(position.id)).paused,true);
  await check(); // A manual pause permits the already claimed person to finish.
  await sql`update quota_counters set used=100 where scope_id in (${position.bossAccountId},${position.id},${inherited.id})`;
  await check(); // Internal quantity caps no longer block the approved contact.
  await m2.finishContactDispatch({job:dispatch,result:'failed',errorMessage:'Isolated preflight fixture; transport never called'});
  const unlimitedReadiness=await m2.previewContactReadiness({stateId:state.id,actionKind:'greet',now:dispatchAt.toISOString(),localMinuteOfDay:600});
  assert.equal(unlimitedReadiness.ready,true);
  assert(unlimitedReadiness.checks.some(check=>check.detail.includes('内部数量限额已关闭')));
  const nextApproval=issueContactPreviewApproval({context:expected,signingKey,now:dispatchAt,ttlMs:600_000});
  const nextIntent=await m2.createManualContactIntent({...request,now:dispatchAt.toISOString(),realApproval:nextApproval,idempotencyKey:contactPreviewApprovalIdempotencyKey('greet',nextApproval.approval.approvalId)});
  await sql`update contact_intents set started_at=now()-interval '5 seconds',finished_at=now()-interval '1 second' where id=${intent.id}`;
  assert.equal(await m2.claimContactDispatch('pacing-too-soon','real',position.bossAccountId),null);
  await sql`update contact_intents set started_at=now()-interval '20 seconds',finished_at=now()-interval '1 second' where id=${intent.id}`;
  assert.equal(await m2.claimContactDispatch('paused-position','real',position.bossAccountId),null);
  assert.equal((await m2.contactDispatchControl(position.id)).queued,1);
  await m2.setContactDispatchPaused(position.id,false,admin.id);
  await sql.begin(async tx=>{
    await tx`select id from positions where id=${position.id} for update`;
    assert.equal(await m2.claimContactDispatch('pause-race','real',position.bossAccountId),null,'a claim cannot pass an in-progress pause update');
    await tx`update positions set contact_dispatch_paused=true where id=${position.id}`;
  });
  assert.equal(await m2.claimContactDispatch('pause-acknowledged','real',position.bossAccountId),null);
  await m2.setContactDispatchPaused(position.id,false,admin.id);
  const concurrent=await Promise.all(['pacing-a','pacing-b'].map(worker=>m2.claimContactDispatch(worker,'real',position.bossAccountId)));
  assert.equal(concurrent.filter(Boolean).length,1,'one account remains serial');
  assert.equal(concurrent.find(Boolean)!.id,nextIntent.id,'elapsed processing time satisfies the interval without extra sleep');
  await m2.assertContactDispatchAllowed({job:concurrent.find(Boolean)!,localMinuteOfDay:600,now:dispatchAt.toISOString()});
  console.log(JSON.stringify({ok:true,internalQuantityLimitsDisabled:true,pausePreservesQueue:true,startIntervalSeconds:10,processingTimeCounts:true,concurrentClaimsSerialized:true,queuedForMinutes:60,stalePreviewRejected:true,legacyNotRenewed:true,currentSwitchAndMessageRechecked:true,deadlineBounded:true,externalSends:0}));
} finally { await sql.end(); }
