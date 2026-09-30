/** Disposable local PostgreSQL only. No browser or real contact transport. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertIsolatedTestDatabase, createDatabase, BossForgeRepository, DepartmentAtsRepository, M2Repository, type CandidateEvaluationRecord } from "./index.js";

assertIsolatedTestDatabase(process.env, { contactSideEffects: true });
const sql = createDatabase();
try {
  const repo = new BossForgeRepository(sql), ats = new DepartmentAtsRepository(sql), contacts = new M2Repository(sql);
  await ats.ensureBootstrap({ departmentName: "Priority test", adminEmail: "priority@example.invalid", adminName: "Test", password: "LocalPriorityFixture!123" });
  const [admin] = await sql`SELECT id,department_id,email,display_name,role FROM users WHERE email='priority@example.invalid'`;
  const principal = { userId: admin!.id, departmentId: admin!.department_id, email: admin!.email, displayName: admin!.display_name, role: admin!.role };
  async function fixture() {
    const account = `priority-test-${randomUUID()}`;
    const position = await ats.createAssignedPosition(principal, { bossAccountId: account, name: account, ownerName: "Test" });
    await repo.createRuleVersion({ positionId: position.id, name: "Test", config: { requiredCapabilities: [{ capability: "tem8", minimumConfidence: 0.9 }] }, dictionaryVersion: "test.1", createdBy: admin!.id });
    const task = await repo.createImmediateTask({ idempotencyKey: randomUUID(), positionId: position.id, source: "recommend", createdBy: admin!.id, candidateLimit: 100 });
    const claimed = await repo.claimNextTask("fixture", account);
    assert(claimed);
    const records: CandidateEvaluationRecord[] = Array.from({ length: 3 }, (_, i) => ({
      sourceReference: `${account}:${i}`, sourceLocator: { kind: "boss_geek_id", value: `${account}-${i}` },
      source: "recommend", displayName: `Fixture ${i}`, fingerprint: `${account}-${i}`, rawFields: {}, sourceEvidence: [], rawText: "Synthetic resume",
      decision: "insufficient", confidence: 0, capabilityId: "language.english.tem8", canonicalLabel: "TEM-8", dictionaryVersion: "test.1", currentEnglishLevel: null, reasonCodes: [], evidence: []
    }));
    await repo.completeTask(claimed, records);
    const states = await sql`SELECT id FROM candidate_position_states WHERE latest_task_id=${task.id} ORDER BY id`;
    await sql`UPDATE candidate_position_states SET resume_screening_status='screened' WHERE id IN (${states[0]!.id},${states[1]!.id})`;
    return { account, position, task, states };
  }
  const a = await fixture(), b = await fixture();
  async function intent(f: typeof a, index: number, status: "ready" | "uncertain") {
    const id = randomUUID();
    await sql`INSERT INTO contact_intents(id,idempotency_key,candidate_position_state_id,task_id,template_version_id,rendered_message,status,policy_snapshot,created_by,transport_mode,action_kind,provider_job_id,provider_greeting_id,finished_at)
      VALUES(${id},${id},${f.states[index]!.id},${f.task.id},NULL,'Synthetic greeting',${status},'{}',${admin!.id},'real','greet','fixture-job','fixture-greeting',${status==='uncertain' ? new Date(Date.now()-86400000) : null})`;
    if (status === "ready") await sql`INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,status,available_at) VALUES(${randomUUID()},'contact_intent',${id},'contact.requested','{}','pending',now()-interval '1 minute')`;
    return id;
  }
  const ready = await intent(a, 0, "ready");
  await intent(b, 0, "uncertain");
  // Another account's uncertainty must not change A's contact priority.
  assert.equal(await repo.claimNextResumeScreening("test", a.account, null, "real"), null);
  const uncertain = await intent(a, 1, "uncertain");
  assert.equal(await contacts.claimContactDispatch("test", "real", a.account), null, "old uncertainty still blocks real sends before browser work");
  const resume = await repo.claimNextResumeScreening("test", a.account, null, "real");
  assert(resume, "blocked contact must not starve resume screening");
  assert.equal(resume.stateId, a.states[2]!.id);
  const [event] = await sql`SELECT status,attempts FROM outbox_events WHERE aggregate_id=${ready}`;
  assert.equal(event!.status, "pending"); assert.equal(event!.attempts, 0);
  await sql`UPDATE candidate_position_states SET resume_screening_status='queued',resume_screening_claimed_at=NULL,resume_screening_claimed_by=NULL WHERE id=${resume.stateId}`;
  await sql`UPDATE contact_intents SET status='cancelled' WHERE id=${uncertain}`;
  assert.equal(await repo.claimNextResumeScreening("test", a.account, null, "real"), null, "contact priority resumes after verification");
  await contacts.setContactDispatchPaused(a.position.id, true, admin!.id);
  assert(await repo.claimNextResumeScreening("test", a.account, null, "real"), "paused contact queue must not starve screening");
  await contacts.setContactDispatchPaused(a.position.id, false, admin!.id);
  assert(await contacts.claimContactDispatch("test", "real", a.account), "account B uncertainty must not block account A");
  console.log(JSON.stringify({ ok: true, oldUncertaintyBlockedBeforeClaim: true, blockedContactDoesNotStarveResumes: true, pausedContactDoesNotStarveResumes: true, accountIsolation: true, realGreetingExecuted: false }));
} finally { await sql.end(); }
