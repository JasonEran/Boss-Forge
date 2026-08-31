import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  BossForgeRepository,
  M2Repository,
  OptimisticLockError,
  createDatabase,
  type CandidateEvaluationRecord
} from "./index.js";

async function cleanupIntegrationData(sql: ReturnType<typeof createDatabase>): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction`
      DELETE FROM outbox_events WHERE aggregate_id IN (
        SELECT ci.id FROM contact_intents ci
        JOIN candidate_position_states cps ON cps.id = ci.candidate_position_state_id
        JOIN positions p ON p.id = cps.position_id
        WHERE p.boss_account_id LIKE 'integration-account-%'
      )
    `;
    await transaction`
      DELETE FROM contact_attempts WHERE contact_intent_id IN (
        SELECT ci.id FROM contact_intents ci
        JOIN candidate_position_states cps ON cps.id = ci.candidate_position_state_id
        JOIN positions p ON p.id = cps.position_id
        WHERE p.boss_account_id LIKE 'integration-account-%'
      )
    `;
    await transaction`
      DELETE FROM contact_intents WHERE candidate_position_state_id IN (
        SELECT cps.id FROM candidate_position_states cps
        JOIN positions p ON p.id = cps.position_id
        WHERE p.boss_account_id LIKE 'integration-account-%'
      )
    `;
    await transaction`
      DELETE FROM quota_counters WHERE
        (scope_type = 'account' AND scope_id LIKE 'integration-account-%')
        OR (scope_type = 'position' AND scope_id IN (
          SELECT id::text FROM positions WHERE boss_account_id LIKE 'integration-account-%'
        ))
        OR (scope_type = 'task' AND scope_id IN (
          SELECT t.id::text FROM tasks t JOIN positions p ON p.id = t.position_id
          WHERE p.boss_account_id LIKE 'integration-account-%'
        ))
    `;
    await transaction`
      DELETE FROM reviews WHERE candidate_position_state_id IN (
        SELECT cps.id FROM candidate_position_states cps JOIN positions p ON p.id = cps.position_id
        WHERE p.boss_account_id LIKE 'integration-account-%'
      )
    `;
    await transaction`
      DELETE FROM match_evidence WHERE candidate_position_state_id IN (
        SELECT cps.id FROM candidate_position_states cps JOIN positions p ON p.id = cps.position_id
        WHERE p.boss_account_id LIKE 'integration-account-%'
      )
    `;
    await transaction`
      DELETE FROM candidate_position_states WHERE position_id IN (
        SELECT id FROM positions WHERE boss_account_id LIKE 'integration-account-%'
      )
    `;
    await transaction`
      DELETE FROM candidate_snapshots WHERE task_id IN (
        SELECT t.id FROM tasks t JOIN positions p ON p.id = t.position_id
        WHERE p.boss_account_id LIKE 'integration-account-%'
      )
    `;
    await transaction`
      DELETE FROM tasks WHERE position_id IN (
        SELECT id FROM positions WHERE boss_account_id LIKE 'integration-account-%'
      )
    `;
    await transaction`
      DELETE FROM schedules WHERE position_id IN (
        SELECT id FROM positions WHERE boss_account_id LIKE 'integration-account-%'
      )
    `;
    await transaction`
      UPDATE rule_sets SET active_version_id = NULL WHERE position_id IN (
        SELECT id FROM positions WHERE boss_account_id LIKE 'integration-account-%'
      )
    `;
    await transaction`
      DELETE FROM rule_versions WHERE rule_set_id IN (
        SELECT rs.id FROM rule_sets rs JOIN positions p ON p.id = rs.position_id
        WHERE p.boss_account_id LIKE 'integration-account-%'
      )
    `;
    await transaction`
      DELETE FROM rule_sets WHERE position_id IN (
        SELECT id FROM positions WHERE boss_account_id LIKE 'integration-account-%'
      )
    `;
    await transaction`
      DELETE FROM candidates WHERE fingerprint LIKE 'integration-fingerprint-%'
    `;
    await transaction`
      DELETE FROM positions WHERE boss_account_id LIKE 'integration-account-%'
    `;
    await transaction`
      UPDATE message_templates SET active_version_id = NULL WHERE name LIKE 'Integration Template %'
    `;
    await transaction`
      DELETE FROM template_versions WHERE template_id IN (
        SELECT id FROM message_templates WHERE name LIKE 'Integration Template %'
      )
    `;
    await transaction`DELETE FROM message_templates WHERE name LIKE 'Integration Template %'`;
    await transaction`
      DELETE FROM audit_logs WHERE actor_id LIKE 'integration-%'
        OR payload::text LIKE '%integration-account-%'
    `;
  });
}

async function main(): Promise<void> {
  const sql = createDatabase();
  try {
    const suffix = randomUUID();
    const repository = new BossForgeRepository(sql);
    const m2Repository = new M2Repository(sql);
    const position = await repository.createPosition({
      bossAccountId: `integration-account-${suffix}`,
      name: `Integration Position ${suffix}`,
      ownerName: "integration-test"
    });
    await repository.createRuleVersion({
      positionId: position.id,
      name: "Integration TEM8",
      config: { requiredCapabilities: [{ capability: "tem8", minimumConfidence: 0.9 }] },
      dictionaryVersion: "integration.1",
      createdBy: "integration-test"
    });
    await repository.createImmediateTask({
      idempotencyKey: `integration-task-${suffix}`,
      positionId: position.id,
      source: "recommend",
      createdBy: "integration-test"
    });
    const task = await repository.claimNextTask("integration-worker");
    assert(task);
    const evaluation: CandidateEvaluationRecord = {
        sourceReference: `recommend:1:Integration Candidate ${suffix}`,
        source: "recommend",
        displayName: `Integration Candidate ${suffix}`,
        fingerprint: `integration-fingerprint-${suffix}`,
        rawFields: { experience: "3 years" },
        sourceEvidence: ["TEM-8 certified"],
        rawText: "TEM-8 certified",
        decision: "matched",
        confidence: 0.99,
        capabilityId: "language.english.tem8",
        canonicalLabel: "TEM-8",
        dictionaryVersion: "integration.1",
        currentEnglishLevel: "TEM-8（英语专业八级）",
        reasonCodes: ["confirmed_alias"],
        evidence: [
          {
            sourceText: "TEM-8 certified",
            normalizedAlias: "TEM-8",
            status: "positive",
            confidence: 0.99
          }
        ]
      };
    const belowTem8Evaluation: CandidateEvaluationRecord = {
      sourceReference: `recommend:2:Integration CET6 Candidate ${suffix}`,
      source: "recommend",
      displayName: `Integration CET6 Candidate ${suffix}`,
      fingerprint: `integration-fingerprint-cet6-${suffix}`,
      rawFields: { experience: "4 years", credential: "CET-6" },
      sourceEvidence: ["大学英语六级 560 分"],
      rawText: "大学英语六级 560 分",
      decision: "not_matched",
      confidence: 0.98,
      capabilityId: "language.english.tem8",
      canonicalLabel: "TEM-8",
      dictionaryVersion: "integration.1",
      currentEnglishLevel: "CET-6（大学英语六级）",
      reasonCodes: ["confusable_credential"],
      evidence: []
    };
    await repository.completeTask(task, [evaluation, belowTem8Evaluation]);
    for (let index = 0; index < 2; index += 1) {
      const resumeJob = await repository.claimNextResumeScreening("integration-worker");
      assert(resumeJob);
      const record = resumeJob.candidateName.includes("CET6")
        ? belowTem8Evaluation
        : evaluation;
      await repository.completeResumeScreening({
        job: resumeJob,
        record,
        screenshotPath: `/tmp/integration-resume-${index}.png`,
        resumeTextHash: `integration-resume-hash-${index}-${suffix}`,
        workerId: "integration-worker"
      });
    }
    const dashboard = await repository.getDashboard();
    const state = dashboard.candidates.find((candidate) => candidate.name.endsWith(suffix));
    assert(state);
    assert.equal(state.resumeScreeningStatus, "screened");
    assert.equal(state.currentEnglishLevel, "TEM-8（英语专业八级）");
    const belowTem8State = dashboard.candidates.find((candidate) =>
      candidate.name.startsWith("Integration CET6 Candidate")
    );
    assert(belowTem8State);
    assert.equal(belowTem8State.reviewStatus, "not_required");
    assert.equal(belowTem8State.currentEnglishLevel, "CET-6（大学英语六级）");
    const first = await repository.reviewCandidate({
      stateId: state.stateId,
      idempotencyKey: `integration-review-${suffix}`,
      decision: "approved",
      note: "Evidence confirmed.",
      reviewerId: "integration-reviewer",
      expectedVersion: state.stateVersion
    });
    const replay = await repository.reviewCandidate({
      stateId: state.stateId,
      idempotencyKey: `integration-review-${suffix}`,
      decision: "approved",
      note: "Evidence confirmed.",
      reviewerId: "integration-reviewer",
      expectedVersion: state.stateVersion
    });
    assert.equal(first.id, replay.id);
    await assert.rejects(
      repository.reviewCandidate({
        stateId: state.stateId,
        idempotencyKey: `integration-review-stale-${suffix}`,
        decision: "rejected",
        note: "Stale write",
        reviewerId: "integration-reviewer",
        expectedVersion: state.stateVersion
      }),
      OptimisticLockError
    );
    const detail = await repository.getCandidateDetail(state.stateId);
    assert(detail);
    assert.equal(detail.reviewStatus, "approved");
    assert.equal(detail.stateVersion, state.stateVersion + 1);
    assert.equal(detail.reviews.length, 1);
    const templateVersionId = await m2Repository.ensureMessageTemplate({
      name: `Integration Template ${suffix}`,
      body: "你好 {{candidate_name}}，测试岗位：{{position_name}}。",
      createdBy: "integration-test"
    });
    const preview = await m2Repository.previewMessage(state.stateId);
    assert(preview.renderedMessage.includes("Integration Candidate"));
    const intent = await m2Repository.createManualContactIntent({
      stateId: state.stateId,
      idempotencyKey: `integration-contact-${suffix}`,
      templateVersionId: preview.templateVersionId,
      renderedMessage: preview.renderedMessage,
      createdBy: "integration-reviewer",
      localMinuteOfDay: 12 * 60,
      now: new Date().toISOString()
    });
    assert.equal(intent.status, "ready");
    const dispatch = await m2Repository.claimContactDispatch("integration-contact-worker");
    assert(dispatch);
    assert.equal(dispatch.id, intent.id);
    await m2Repository.assertContactDispatchAllowed({
      job: dispatch,
      localMinuteOfDay: 12 * 60,
      now: new Date().toISOString()
    });
    await m2Repository.finishContactDispatch({
      job: dispatch,
      result: "sent",
      externalMessage: "fake transport only"
    });
    const schedule = await m2Repository.createSchedule({
      idempotencyKey: `integration-schedule-${suffix}`,
      positionId: position.id,
      source: "recommend",
      frequency: "once",
      timezone: "Asia/Shanghai",
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      createdBy: "integration-test"
    });
    const cancelled = await m2Repository.cancelSchedule({
      scheduleId: schedule.id,
      expectedVersion: schedule.version,
      actorId: "integration-test"
    });
    assert.equal(cancelled.enabled, false);
    const dueSchedule = await m2Repository.createSchedule({
      idempotencyKey: `integration-due-schedule-${suffix}`,
      positionId: position.id,
      source: "recommend",
      frequency: "once",
      timezone: "Asia/Shanghai",
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
      createdBy: "integration-test"
    });
    assert((await m2Repository.materializeDueSchedules()) >= 1);
    const materialized = (await m2Repository.listSchedules()).find(
      (item) => item.id === dueSchedule.id
    );
    assert(materialized);
    assert.equal(materialized.enabled, false);
    await sql`
      UPDATE tasks SET status = 'cancelled'
      WHERE position_id = ${position.id} AND created_by = 'integration-test' AND status = 'queued'
    `;
    console.log(
      JSON.stringify({
        ok: true,
        stateId: state.stateId,
        reviewId: first.id,
        idempotentReplay: first.id === replay.id,
        optimisticLock: true,
        messagePreview: true,
        fakeContactDispatch: true,
        scheduleLifecycle: true,
        scheduleMaterialization: true,
        seededTemplateVersionId: templateVersionId
      })
    );
  } finally {
    await cleanupIntegrationData(sql);
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
