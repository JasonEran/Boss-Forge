/** Local disposable database only; no browser, OCR, or candidate contacts. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertIsolatedTestDatabase, createDatabase, BossForgeRepository, DepartmentAtsRepository, M2Repository, type CandidateEvaluationRecord } from "./index.js";

assertIsolatedTestDatabase(process.env, { contactSideEffects: false });
const sql = createDatabase();
try {
  const repo = new BossForgeRepository(sql);
  const ats = new DepartmentAtsRepository(sql);
  const schedules = new M2Repository(sql);
  await ats.ensureBootstrap({ departmentName: "Limit test", adminEmail: "limit@example.invalid", adminName: "Limit test", password: "LocalLimitTest!123" });
  const [admin] = await sql`SELECT id, department_id, email, display_name, role FROM users WHERE email = 'limit@example.invalid'`;
  const position = await ats.createAssignedPosition({ userId: admin!.id, departmentId: admin!.department_id, email: admin!.email, displayName: admin!.display_name, role: admin!.role }, { bossAccountId: `limit-test-${randomUUID()}`, name: "人数上限测试岗位", ownerName: "Limit test" });
  await repo.createRuleVersion({ positionId: position.id, name: "Test rule", config: { requiredCapabilities: [{ capability: "tem8", minimumConfidence: 0.9 }] }, dictionaryVersion: "test.1", createdBy: admin!.id });
  const request = { positionId: position.id, source: "recommend" as const, createdBy: admin!.id, idempotencyKey: randomUUID(), candidateLimit: 20 };
  const task = await repo.createImmediateTask(request);
  assert.equal(task.candidateLimit, 20);
  assert.equal((await repo.createImmediateTask(request)).id, task.id);
  await assert.rejects(repo.createImmediateTask({ ...request, candidateLimit: 21 }), /Idempotency/);
  await assert.rejects(repo.createImmediateTask({ ...request, idempotencyKey: randomUUID(), candidateLimit: 100_001 }), /打招呼人数/);
  const claimed = await repo.claimNextTask("limit-test-worker", position.bossAccountId);
  assert(claimed);
  const records: CandidateEvaluationRecord[] = Array.from({ length: 385 }, (_, i) => ({
    sourceReference: `recommend:${i + 1}:Fixture ${i}`, sourceLocator: { kind: "boss_geek_id", value: `limit-${task.id}-${i}` },
    source: "recommend", displayName: `Fixture ${i}`, fingerprint: `limit-${task.id}-${i}`,
    rawFields: {}, sourceEvidence: [], rawText: "Synthetic résumé", decision: "insufficient", confidence: 0,
    capabilityId: "language.english.tem8", canonicalLabel: "TEM-8", dictionaryVersion: "test.1", currentEnglishLevel: null, reasonCodes: [], evidence: [],
  }));
  // Even an outdated/tampered worker task object cannot enlarge the DB limit.
  await repo.completeTask({ ...claimed, candidateLimit: 200 }, [records[0]!, records[0]!, ...records.slice(1)]);
  const [stored] = await sql`SELECT candidate_count, candidate_limit FROM tasks WHERE id = ${task.id}`;
  assert.equal(stored!.candidate_count, 20);
  const [snapshots] = await sql`SELECT count(*)::int AS count FROM candidate_snapshots WHERE task_id = ${task.id}`;
  assert.equal(snapshots!.count, 20);
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const job = await repo.claimNextResumeScreening("limit-test-worker", position.bossAccountId);
    assert(job);
    seen.add(job.stateId);
  }
  assert.equal(seen.size, 20);
  assert.equal(await repo.claimNextResumeScreening("limit-test-worker", position.bossAccountId), null);
  const [version] = await sql`SELECT version FROM tasks WHERE id = ${task.id}`;
  const cancelled = await repo.cancelTask({ taskId: task.id, expectedVersion: version!.version, actorId: admin!.id, idempotencyKey: randomUUID() });
  assert.equal(await repo.claimNextResumeScreening("limit-test-worker", position.bossAccountId), null);
  const [remaining] = await sql`SELECT count(*)::int AS count FROM candidate_position_states WHERE latest_task_id = ${task.id} AND resume_screening_status IN ('queued', 'processing')`;
  assert.equal(remaining!.count, 0);
  await sql`UPDATE tasks SET candidate_count = 385 WHERE id = ${task.id}`;
  const retried = await repo.retryTask({ taskId: task.id, expectedVersion: cancelled.version, actorId: admin!.id, idempotencyKey: randomUUID() });
  assert.notEqual(retried.status, "cancelled");
  const scheduleRequest = { ...request, idempotencyKey: randomUUID(), candidateLimit: 7, frequency: "once" as const, timezone: "Asia/Shanghai", nextRunAt: new Date(Date.now() - 1000).toISOString() };
  const schedule = await schedules.createSchedule(scheduleRequest);
  assert.equal(schedule.candidateLimit, 7);
  await assert.rejects(schedules.createSchedule({ ...scheduleRequest, candidateLimit: 8 }), /Idempotency/);
  await schedules.materializeDueSchedules();
  const scheduled = await repo.claimNextTask("limit-test-worker", position.bossAccountId);
  assert(scheduled);
  assert.equal(scheduled.candidateLimit, 7);
  await repo.completeTask(scheduled, records);
  const [scheduledCount] = await sql`SELECT candidate_count FROM tasks WHERE id = ${scheduled.id}`;
  assert.equal(scheduledCount!.candidate_count, 20);
  console.log(JSON.stringify({ ok: true, accumulatedCards: 385, admitted: 20, claims: 20, scheduleLimit: 7, scheduleAdmittedChunk: 20, dbAuthoritative: true, stoppedQueue: 0, oversizedRetryAllowed: true, idempotencyValidated: true }));
} finally { await sql.end(); }
