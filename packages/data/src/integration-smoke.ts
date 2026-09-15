import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  BossForgeRepository,
  DepartmentAtsRepository,
  M2Repository,
  OptimisticLockError,
  assertIsolatedTestDatabase,
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
      DELETE FROM operational_alerts
      WHERE resource_type = 'candidate_position_state'
        AND resource_id IN (
          SELECT cps.id::text FROM candidate_position_states cps
          JOIN positions p ON p.id = cps.position_id
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
  const contactSideEffectTestsEnabled =
    process.env.BOSS_FORGE_TEST_CONTACTS === "1";
  assertIsolatedTestDatabase(process.env, {
    contactSideEffects: contactSideEffectTestsEnabled
  });
  const sql = createDatabase();
  try {
    const suffix = randomUUID();
    const repository = new BossForgeRepository(sql);
    const atsRepository = new DepartmentAtsRepository(sql);
    const m2Repository = new M2Repository(sql);
    await atsRepository.ensureBootstrap({
      departmentName: "Integration Test Department",
      adminEmail: "integration-admin@example.invalid",
      adminName: "Integration Test Admin",
      password: "IntegrationOnly!123"
    });
    const adminRows = await sql<
      Array<{
        user_id: string;
        department_id: string;
        email: string;
        display_name: string;
        role: "admin" | "recruiting_lead";
      }>
    >`
      SELECT id AS user_id, department_id, email, display_name, role
      FROM users
      WHERE status = 'active' AND role IN ('admin', 'recruiting_lead')
      ORDER BY created_at ASC
      LIMIT 1
    `;
    const admin = adminRows[0];
    assert(admin, "Integration database must be seeded with an active manager.");
    const adminPrincipal = {
      userId: admin.user_id,
      departmentId: admin.department_id,
      email: admin.email,
      displayName: admin.display_name,
      role: admin.role
    };
    const position = await atsRepository.createAssignedPosition(adminPrincipal, {
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
    const task = await repository.claimNextTask("integration-worker", position.bossAccountId);
    assert(task);
    const evaluation: CandidateEvaluationRecord = {
        sourceReference: `recommend:1:Integration Candidate ${suffix}`,
        sourceLocator: {
          kind: "boss_geek_id",
          value: ` integration-geek-${suffix} `
        },
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
        semanticEvaluations: [
          {
            criterionId: "semantic.skill.java",
            factType: "skill",
            executionMode: "normalized_entity",
            result: "matched",
            normalizedValue: ["Java"],
            qualifier: "confirmed",
            evidence: ["技术栈：Java 后端"],
            confidence: 1,
            extractor: "alias",
            modelVersion: null,
            promptVersion: "semantic-prompt-1.0",
            catalogVersion: "semantic-catalog-1.0",
            rubricVersion: null,
            runtimeMode: "shadow",
            reasonCodes: ["semantic_alias_matched"]
          }
        ],
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
      sourceLocator: {
        kind: "boss_geek_id",
        value: `integration-geek-cet6-${suffix}`
      },
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
    const collectedJobLabel = `Integration BOSS Job ${suffix}`;
    await repository.completeTask(task, [evaluation, belowTem8Evaluation], collectedJobLabel);
    let viewedAt: Date | null = null;
    for (let index = 0; index < 2; index += 1) {
      const resumeJob = await repository.claimNextResumeScreening(
        "integration-worker",
        position.bossAccountId
      );
      assert(resumeJob);
      assert.equal(resumeJob.bossJobKeyword, collectedJobLabel, "resume reads restore the captured BOSS job even when the position keyword is empty");
      assert.equal(resumeJob.semanticMode, "shadow");
      assert.equal(resumeJob.semanticCatalogVersionId, null);
      const record = resumeJob.candidateName.includes("CET6")
        ? belowTem8Evaluation
        : evaluation;
      if (record === evaluation) {
        viewedAt = new Date();
        await repository.recordResumeView({
          stateId: resumeJob.stateId,
          candidateId: resumeJob.candidateId,
          taskId: resumeJob.taskId,
          bossAccountId: resumeJob.bossAccountId,
          workerId: "integration-worker",
          openedAt: viewedAt.toISOString()
        });
      }
      await repository.completeResumeScreening({
        job: resumeJob,
        record,
        screenshotPath: `/tmp/integration-resume-${index}.png`,
        resumeTextHash: `integration-resume-hash-${index}-${suffix}`,
        workerId: "integration-worker"
      });
    }
    const dashboard = await repository.getDashboard();
    let state = dashboard.candidates.find((candidate) => candidate.name.endsWith(suffix));
    assert(state);
    assert.equal(state.taskId, task.id);
    assert.equal(state.resumeScreeningStatus, "screened");
    assert.equal(state.currentEnglishLevel, "TEM-8（英语专业八级）");
    const belowTem8State = dashboard.candidates.find((candidate) =>
      candidate.name.startsWith("Integration CET6 Candidate")
    );
    assert(belowTem8State);
    assert.equal(belowTem8State.reviewStatus, "not_required");
    assert.equal(belowTem8State.currentEnglishLevel, "CET-6（大学英语六级）");
    assert(viewedAt);
    const usageBeforeReset = await repository.resumeViewUsage(
      position.bossAccountId,
      new Date(viewedAt.getTime() - 24 * 60 * 60 * 1_000),
      new Date(viewedAt.getTime() - 60 * 60 * 1_000)
    );
    assert.equal(usageBeforeReset.viewsToday, 1);
    assert.equal(usageBeforeReset.viewsLastHour, 1);
    assert.equal(usageBeforeReset.absoluteViewsToday, 1);
    assert(usageBeforeReset.nextHourlyAvailableAt);
    await repository.resetResumeViewQuota({
      bossAccountId: position.bossAccountId,
      actorId: "integration-quota-reset"
    });
    const usageAfterReset = await repository.resumeViewUsage(
      position.bossAccountId,
      new Date(viewedAt.getTime() - 24 * 60 * 60 * 1_000),
      new Date(viewedAt.getTime() - 60 * 60 * 1_000)
    );
    assert.equal(usageAfterReset.viewsToday, 0);
    assert.equal(usageAfterReset.viewsLastHour, 1);
    assert.equal(usageAfterReset.absoluteViewsToday, 1);
    assert(usageAfterReset.nextHourlyAvailableAt);
    await repository.requeueResumeScreening(state.stateId, "integration-retry-authorizer");
    const retriedResumeJob = await repository.claimNextResumeScreening(
      "integration-retry-worker",
      position.bossAccountId,
      new Date(viewedAt.getTime() - 24 * 60 * 60 * 1_000)
    );
    assert.equal(retriedResumeJob?.stateId, state.stateId);
    await repository.completeResumeScreening({
      job: retriedResumeJob!,
      record: evaluation,
      screenshotPath: "/tmp/integration-resume-retry.png",
      resumeTextHash: `integration-resume-retry-hash-${suffix}`,
      workerId: "integration-retry-worker"
    });
    const dashboardAfterRetry = await repository.getDashboard();
    state = dashboardAfterRetry.candidates.find((candidate) => candidate.stateId === state!.stateId);
    assert(state);
    assert.equal(state.resumeScreeningStatus, "screened");
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
        idempotencyKey: `integration-review-${suffix}`,
        decision: "rejected",
        note: "Different replay payload.",
        reviewerId: "integration-reviewer",
        expectedVersion: state.stateVersion
      }),
      /different review request/u
    );
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
    assert.equal(detail.taskId, task.id);
    assert.equal(detail.reviewStatus, "approved");
    assert.equal(detail.stateVersion, state.stateVersion + 1);
    const reviewedStage = (await sql<Array<{ stage_key: string }>>`
      SELECT stage_key FROM candidate_position_states WHERE id = ${state.stateId}
    `)[0];
    assert.equal(reviewedStage?.stage_key, "approved");
    assert.equal(detail.reviews.length, 1);
    assert.equal(detail.semanticEvaluations.length, 1);
    assert.equal(detail.semanticEvaluations[0]?.criterionId, "semantic.skill.java");
    assert.deepEqual(detail.semanticEvaluations[0]?.normalizedValue, ["Java"]);
    assert.equal(detail.semanticEvaluations[0]?.promptVersion, "semantic-prompt-1.0");

    await assert.rejects(
      repository.createImmediateTask({
        idempotencyKey: `integration-task-${suffix}`,
        positionId: position.id,
        source: "search",
        searchKeyword: "different replay payload",
        createdBy: "integration-test"
      }),
      /different task request/u
    );
    const ruleVersion2 = await repository.createRuleVersion({
      positionId: position.id,
      name: "Integration TEM8 v2",
      config: { requiredCapabilities: [{ capability: "tem8", minimumConfidence: 0.95 }] },
      dictionaryVersion: "integration.2",
      createdBy: "integration-test"
    });
    await repository.createImmediateTask({
      idempotencyKey: `integration-task-2-${suffix}`,
      positionId: position.id,
      source: "recommend",
      createdBy: "integration-test"
    });
    const task2 = await repository.claimNextTask(
      "integration-worker-2",
      position.bossAccountId
    );
    assert(task2);
    const repeatEvaluation: CandidateEvaluationRecord = {
      ...evaluation,
      sourceReference: `recommend:1:Integration Candidate Renamed ${suffix}`,
      sourceLocator: { kind: "boss_geek_id", value: `integration-geek-${suffix}` },
      displayName: `Integration Candidate Renamed ${suffix}`,
      fingerprint: `integration-fingerprint-renamed-${suffix}`,
      rawFields: { experience: "4 years", credential: "CET-6" },
      sourceEvidence: ["大学英语六级 560 分"],
      rawText: "大学英语六级 560 分",
      decision: "not_matched",
      confidence: 0.98,
      currentEnglishLevel: "CET-6（大学英语六级）",
      reasonCodes: ["confusable_credential"],
      semanticEvaluations: [],
      evidence: []
    };
    const newEvaluation: CandidateEvaluationRecord = {
      ...evaluation,
      sourceReference: `recommend:2:Integration New Candidate ${suffix}`,
      sourceLocator: { kind: "boss_geek_id", value: `integration-new-geek-${suffix}` },
      displayName: `Integration New Candidate ${suffix}`,
      fingerprint: `integration-fingerprint-new-${suffix}`,
      semanticEvaluations: []
    };
    await repository.completeTask(task2, [repeatEvaluation, newEvaluation]);
    const newResumeJob = await repository.claimNextResumeScreening(
      "integration-worker-2",
      position.bossAccountId,
      new Date(viewedAt.getTime() - 24 * 60 * 60 * 1_000)
    );
    assert(newResumeJob);
    assert.equal(newResumeJob.candidateName, newEvaluation.displayName);
    await repository.completeResumeScreening({
      job: newResumeJob,
      record: newEvaluation,
      screenshotPath: "/tmp/integration-new-resume.png",
      resumeTextHash: `integration-new-resume-hash-${suffix}`,
      workerId: "integration-worker-2"
    });
    const sameCandidateSameDay = await repository.claimNextResumeScreening(
      "integration-worker-2",
      position.bossAccountId,
      new Date(viewedAt.getTime() - 24 * 60 * 60 * 1_000)
    );
    assert.equal(sameCandidateSameDay, null);
    const repeatResumeJob = await repository.claimNextResumeScreening(
      "integration-worker-2",
      position.bossAccountId
    );
    assert(repeatResumeJob);
    assert.equal(repeatResumeJob.candidateId, state.candidateId);
    await repository.recordResumeView({
      stateId: repeatResumeJob.stateId,
      candidateId: repeatResumeJob.candidateId,
      taskId: repeatResumeJob.taskId,
      bossAccountId: repeatResumeJob.bossAccountId,
      workerId: "integration-worker-2",
      openedAt: new Date().toISOString()
    });
    await repository.failResumeScreening({
      stateId: repeatResumeJob.stateId,
      taskId: repeatResumeJob.taskId,
      message: "Synthetic isolated OCR failure",
      workerId: "integration-worker-2",
      errorCode: "ocr_failed"
    });
    const openAlerts = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM operational_alerts
      WHERE resource_type = 'candidate_position_state'
        AND resource_id = ${repeatResumeJob.stateId}
        AND alert_type = 'resume_screening_failed'
        AND status = 'open'
    `;
    assert.equal(openAlerts[0]?.count, 1);
    const taskAfterResumeFailure = (await repository.getDashboard({
      positionIds: [position.id]
    })).tasks.find((item) => item.id === task2.id);
    assert(taskAfterResumeFailure);
    const retriedResumeTask = await repository.retryTask({
      taskId: task2.id,
      idempotencyKey: `integration-retry-failed-resume-${suffix}`,
      expectedVersion: taskAfterResumeFailure.version,
      actorId: "integration-reviewer",
    });
    assert.equal(retriedResumeTask.status, "screening");
    const recoveredJob = await repository.claimNextResumeScreening(
      "integration-worker-2",
      position.bossAccountId,
      new Date(viewedAt.getTime() - 24 * 60 * 60 * 1_000)
    );
    assert.equal(recoveredJob?.stateId, repeatResumeJob.stateId);
    await repository.completeResumeScreening({
      job: recoveredJob!,
      record: repeatEvaluation,
      screenshotPath: "/tmp/integration-repeat-resume.png",
      resumeTextHash: `integration-repeat-resume-hash-${suffix}`,
      workerId: "integration-worker-2"
    });
    const historyDashboard = await repository.getDashboard({
      positionIds: [position.id]
    });
    const task1State = historyDashboard.candidates.find(
      (candidate) => candidate.stateId === state!.stateId
    );
    const task2RepeatState = historyDashboard.candidates.find(
      (candidate) => candidate.stateId === repeatResumeJob.stateId
    );
    assert(task1State);
    assert(task2RepeatState);
    assert.notEqual(task1State.stateId, task2RepeatState.stateId);
    assert.equal(task1State.taskId, task.id);
    assert.equal(task1State.reviewStatus, "approved");
    assert.equal(task1State.isCurrent, false);
    assert.equal(task2RepeatState.taskId, task2.id);
    assert.equal(task2RepeatState.candidateId, task1State.candidateId);
    assert.equal(task2RepeatState.isRepeat, true);
    assert.equal(task2RepeatState.isCurrent, true);
    assert.equal(task2RepeatState.reviewStatus, "not_required");
    assert.equal(task2RepeatState.contactStatus, "not_contacted");
    assert.equal(
      historyDashboard.tasks.find((item) => item.id === task2.id)?.newCandidateCount,
      1
    );
    assert.equal(
      historyDashboard.tasks.find((item) => item.id === task2.id)?.repeatCandidateCount,
      1
    );
    const stateOwnership = await sql<
      Array<{ task_id: string; rule_version_id: string; alert_status: string | null }>
    >`
      SELECT cps.latest_task_id AS task_id, cps.rule_version_id,
        alert.status AS alert_status
      FROM candidate_position_states cps
      LEFT JOIN operational_alerts alert
        ON alert.resource_type = 'candidate_position_state'
       AND alert.resource_id = cps.id::text
       AND alert.alert_type = 'resume_screening_failed'
      WHERE cps.id = ${repeatResumeJob.stateId}
    `;
    assert.equal(stateOwnership[0]?.task_id, task2.id);
    assert.equal(stateOwnership[0]?.rule_version_id, ruleVersion2.id);
    assert.equal(stateOwnership[0]?.alert_status, "resolved");
    await assert.rejects(
      atsRepository.contactReadiness({
        userId: admin.user_id,
        departmentId: admin.department_id,
        email: admin.email,
        displayName: admin.display_name,
        role: admin.role
      }, {
        positionId: position.id,
        taskId: task2.id,
        candidateId: belowTem8State.candidateId
      }),
      /does not belong to the requested task and position/u
    );

    const screenedTask2 = historyDashboard.tasks.find((item) => item.id === task2.id);
    assert(screenedTask2);
    assert.equal(screenedTask2.status, "waiting_review");
    const cancelledScreenedTask = await repository.cancelTask({
      taskId: task2.id,
      idempotencyKey: `integration-cancel-screened-${suffix}`,
      expectedVersion: screenedTask2.version,
      actorId: "integration-reviewer"
    });
    const resumedScreenedTask = await repository.retryTask({
      taskId: task2.id,
      idempotencyKey: `integration-retry-screened-${suffix}`,
      expectedVersion: cancelledScreenedTask.version,
      actorId: "integration-reviewer"
    });
    assert.equal(resumedScreenedTask.status, "waiting_review");
    const queuedAfterResume = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM candidate_position_states
      WHERE latest_task_id = ${task2.id} AND resume_screening_status = 'queued'
    `;
    assert.equal(queuedAfterResume[0]?.count, 0);

    const cancellable = await repository.createImmediateTask({
      idempotencyKey: `integration-cancellable-${suffix}`,
      positionId: position.id,
      source: "recommend",
      createdBy: "integration-test"
    });
    const cancelledTask = await repository.cancelTask({
      taskId: cancellable.id,
      idempotencyKey: `integration-cancel-command-${suffix}`,
      expectedVersion: cancellable.version,
      actorId: "integration-reviewer"
    });
    const cancelledReplay = await repository.cancelTask({
      taskId: cancellable.id,
      idempotencyKey: `integration-cancel-command-${suffix}`,
      expectedVersion: cancellable.version,
      actorId: "integration-reviewer"
    });
    assert.equal(cancelledReplay.version, cancelledTask.version);
    const retriedTask = await repository.retryTask({
      taskId: cancellable.id,
      idempotencyKey: `integration-retry-command-${suffix}`,
      expectedVersion: cancelledTask.version,
      actorId: "integration-reviewer"
    });
    assert.equal(retriedTask.status, "queued");

    const templateVersionId = await m2Repository.ensureMessageTemplate({
      name: `Integration Template ${suffix}`,
      body: "你好 {{candidate_name}}，测试岗位：{{position_name}}。",
      createdBy: "integration-test"
    });
    await assert.rejects(
      m2Repository.previewMessage(state.stateId),
      /Approved candidate or active message template not found/u,
      "Historical, non-current candidate states must not be contactable."
    );
    const contactCandidate = historyDashboard.candidates.find(
      (candidate) => candidate.name === newEvaluation.displayName
    );
    assert(contactCandidate);
    assert.equal(contactCandidate.isCurrent, true);
    assert.equal(contactCandidate.taskId, task2.id);
    await repository.reviewCandidate({
      stateId: contactCandidate.stateId,
      idempotencyKey: `integration-current-review-${suffix}`,
      decision: "approved",
      note: "Current task candidate approved for isolated contact testing.",
      reviewerId: "integration-reviewer",
      expectedVersion: contactCandidate.stateVersion
    });
    const preview = await m2Repository.previewMessage(contactCandidate.stateId);
    assert(preview.renderedMessage.includes(contactCandidate.name));
    if (contactSideEffectTestsEnabled) {
      for (const [scopeType, scopeId] of [
        ["global", "global"],
        ["department", admin.department_id],
        ["position", position.id],
        ["task", task2.id]
      ] as const) {
        await atsRepository.setContactControl(adminPrincipal, {
          scopeType,
          scopeId,
          enabled: true,
          approvalRequired: false,
          policy: { testOnly: true },
          emergencyStop: false
        });
      }
      await sql`
        UPDATE candidate_position_states SET resume_screening_status = 'queued'
        WHERE id = ${contactCandidate.stateId}
      `;
      await assert.rejects(
        m2Repository.createManualContactIntent({
          stateId: contactCandidate.stateId,
          actionKind: "message",
          idempotencyKey: `integration-contact-incomplete-${suffix}`,
          templateVersionId: preview.templateVersionId,
          providerJobId: null,
          providerGreetingId: null,
          renderedMessage: preview.renderedMessage,
          createdBy: admin.user_id,
          localMinuteOfDay: 12 * 60,
          now: new Date().toISOString()
        }),
        /resume_screening_incomplete/u
      );
      await sql`
        UPDATE candidate_position_states SET resume_screening_status = 'screened'
        WHERE id = ${contactCandidate.stateId}
      `;
      const intent = await m2Repository.createManualContactIntent({
        stateId: contactCandidate.stateId,
        actionKind: "message",
        idempotencyKey: `integration-contact-${suffix}`,
        templateVersionId: preview.templateVersionId,
        providerJobId: null,
        providerGreetingId: null,
        renderedMessage: preview.renderedMessage,
        createdBy: admin.user_id,
        localMinuteOfDay: 12 * 60,
        now: new Date().toISOString()
      });
    assert.equal(intent.status, "ready");
    assert.equal(intent.taskId, task2.id);
    const dispatch = await m2Repository.claimContactDispatch(
      "integration-contact-worker",
      "fake",
      position.bossAccountId
    );
    assert(dispatch);
    assert.equal(dispatch.id, intent.id);
    await sql`
      UPDATE candidate_position_states SET resume_screening_status = 'processing'
      WHERE id = ${contactCandidate.stateId}
    `;
    await assert.rejects(
      m2Repository.assertContactDispatchAllowed({
        job: dispatch,
        localMinuteOfDay: 12 * 60,
        now: new Date().toISOString()
      }),
      /resume_screening_incomplete/u
    );
    await sql`
      UPDATE candidate_position_states SET resume_screening_status = 'screened'
      WHERE id = ${contactCandidate.stateId}
    `;
    await m2Repository.assertContactDispatchAllowed({
      job: dispatch,
      localMinuteOfDay: 12 * 60,
      now: new Date().toISOString()
    });
    await m2Repository.finishContactDispatch({
      job: dispatch,
      result: "simulated",
      externalMessage: "fake transport only"
    });
    const fakeCompletion = await sql<
      Array<{ intent_status: string; candidate_status: string; attempt_result: string }>
    >`
      SELECT ci.status AS intent_status, cps.contact_status AS candidate_status,
        ca.result AS attempt_result
      FROM contact_intents ci
      JOIN candidate_position_states cps ON cps.id = ci.candidate_position_state_id
      JOIN contact_attempts ca ON ca.contact_intent_id = ci.id
      WHERE ci.id = ${intent.id}
    `;
    assert.equal(fakeCompletion[0]?.intent_status, "simulated");
    assert.equal(fakeCompletion[0]?.candidate_status, "simulated");
    assert.equal(fakeCompletion[0]?.attempt_result, "simulated");
    const fakeQuota = await sql<Array<{ used: number }>>`
      SELECT COALESCE(SUM(used), 0)::int AS used
      FROM quota_counters
      WHERE (scope_type = 'account' AND scope_id = ${position.bossAccountId})
        OR (scope_type = 'position' AND scope_id = ${position.id})
        OR (scope_type = 'task' AND scope_id = ${task2.id})
    `;
    assert.equal(fakeQuota[0]?.used, 0);
    }
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
        contactSideEffectTestsEnabled,
        contactFlow: contactSideEffectTestsEnabled
          ? "executed in isolated test database"
          : "skipped (set BOSS_FORGE_TEST_CONTACTS=1 only for an isolated database)",
        fakeContactDispatch: contactSideEffectTestsEnabled,
        uncertainContactResolution: false,
        perTaskCandidateHistory: true,
        contactReadinessTaskScope: true,
        recoveredFailureAlertResolved: true,
        cancelRetryWithoutStuckScreening: true,
        scheduleLifecycle: true,
        scheduleMaterialization: true,
        resumeViewQuotaReset: true,
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
