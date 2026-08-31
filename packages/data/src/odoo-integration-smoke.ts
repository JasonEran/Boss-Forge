import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parseOdooInboundEvent } from "@boss-forge/contracts";
import {
  BossForgeRepository,
  ContactDispatchPolicyError,
  M2Repository,
  OdooIntegrationRepository,
  createDatabase,
  type CandidateEvaluationRecord
} from "./index.js";

type Database = ReturnType<typeof createDatabase>;

type Fixture = {
  suffix: string;
  odooDatabaseUuid: string;
  bossAccountId: string;
  jobEventId: string;
  mutatedJobEventId: string;
  screeningEventId: string;
  cancellationRequestEventId: string;
  cancellationEventId: string;
  contactEventId: string;
  authorizationId: string;
  requestId: string;
  cancellationRequestId: string;
  fingerprint: string;
  ownerId: string;
  requestedById: string;
  reviewerId: string;
  workerId: string;
};

async function cleanup(sql: Database, fixture: Fixture): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction`
      DELETE FROM integration_outbox_events
      WHERE correlation_id IN (
        ${fixture.screeningEventId}::uuid,
        ${fixture.cancellationEventId}::uuid,
        ${fixture.contactEventId}::uuid
      )
    `;
    await transaction`
      DELETE FROM integration_inbox_events
      WHERE event_id IN (
        ${fixture.jobEventId}::uuid,
        ${fixture.mutatedJobEventId}::uuid,
        ${fixture.screeningEventId}::uuid,
        ${fixture.cancellationRequestEventId}::uuid,
        ${fixture.cancellationEventId}::uuid,
        ${fixture.contactEventId}::uuid
      )
    `;
    await transaction`
      DELETE FROM contact_attempts
      WHERE contact_intent_id IN (
        SELECT id FROM contact_intents
        WHERE authorization_id = ${fixture.authorizationId}::uuid
      )
    `;
    await transaction`
      DELETE FROM outbox_events
      WHERE aggregate_id IN (
        SELECT id FROM contact_intents
        WHERE authorization_id = ${fixture.authorizationId}::uuid
      )
    `;
    await transaction`
      DELETE FROM contact_quota_reservations
      WHERE contact_intent_id IN (
        SELECT id FROM contact_intents
        WHERE authorization_id = ${fixture.authorizationId}::uuid
      )
    `;
    await transaction`
      DELETE FROM quota_counters
      WHERE
        (scope_type = 'account' AND scope_id = ${fixture.bossAccountId})
        OR (
          scope_type = 'position'
          AND scope_id IN (
            SELECT id::text FROM positions
            WHERE odoo_database_uuid = ${fixture.odooDatabaseUuid}
              AND boss_account_id = ${fixture.bossAccountId}
          )
        )
        OR (
          scope_type = 'task'
          AND scope_id IN (
            SELECT t.id::text
            FROM tasks t
            JOIN positions p ON p.id = t.position_id
            WHERE p.odoo_database_uuid = ${fixture.odooDatabaseUuid}
              AND p.boss_account_id = ${fixture.bossAccountId}
          )
        )
    `;
    await transaction`
      DELETE FROM contact_intents
      WHERE authorization_id = ${fixture.authorizationId}::uuid
    `;
    await transaction`
      DELETE FROM contact_authorizations
      WHERE id = ${fixture.authorizationId}::uuid
    `;
    await transaction`
      UPDATE message_templates
      SET active_version_id = NULL
      WHERE position_id IN (
        SELECT id FROM positions
        WHERE odoo_database_uuid = ${fixture.odooDatabaseUuid}
          AND boss_account_id = ${fixture.bossAccountId}
      )
    `;
    await transaction`
      DELETE FROM template_versions
      WHERE template_id IN (
        SELECT mt.id
        FROM message_templates mt
        JOIN positions p ON p.id = mt.position_id
        WHERE p.odoo_database_uuid = ${fixture.odooDatabaseUuid}
          AND p.boss_account_id = ${fixture.bossAccountId}
      )
    `;
    await transaction`
      DELETE FROM message_templates
      WHERE position_id IN (
        SELECT id FROM positions
        WHERE odoo_database_uuid = ${fixture.odooDatabaseUuid}
          AND boss_account_id = ${fixture.bossAccountId}
      )
    `;
    await transaction`
      DELETE FROM reviews
      WHERE candidate_position_state_id IN (
        SELECT cps.id
        FROM candidate_position_states cps
        JOIN positions p ON p.id = cps.position_id
        WHERE p.odoo_database_uuid = ${fixture.odooDatabaseUuid}
          AND p.boss_account_id = ${fixture.bossAccountId}
      )
    `;
    await transaction`
      DELETE FROM match_evidence
      WHERE candidate_position_state_id IN (
        SELECT cps.id
        FROM candidate_position_states cps
        JOIN positions p ON p.id = cps.position_id
        WHERE p.odoo_database_uuid = ${fixture.odooDatabaseUuid}
          AND p.boss_account_id = ${fixture.bossAccountId}
      )
    `;
    await transaction`
      DELETE FROM audit_logs
      WHERE actor_id IN (
        ${fixture.ownerId},
        ${fixture.requestedById},
        ${fixture.reviewerId},
        ${fixture.workerId}
      )
    `;
    await transaction`
      DELETE FROM external_object_maps
      WHERE external_system = 'odoo'
        AND external_database_uuid = ${fixture.odooDatabaseUuid}
    `;
    await transaction`
      DELETE FROM candidate_position_states
      WHERE position_id IN (
        SELECT id FROM positions
        WHERE odoo_database_uuid = ${fixture.odooDatabaseUuid}
          AND boss_account_id = ${fixture.bossAccountId}
      )
    `;
    await transaction`
      DELETE FROM candidate_snapshots
      WHERE task_id IN (
        SELECT t.id
        FROM tasks t
        JOIN positions p ON p.id = t.position_id
        WHERE p.odoo_database_uuid = ${fixture.odooDatabaseUuid}
          AND p.boss_account_id = ${fixture.bossAccountId}
      )
    `;
    await transaction`
      DELETE FROM candidates
      WHERE fingerprint = ${fixture.fingerprint}
    `;
    await transaction`
      DELETE FROM tasks
      WHERE position_id IN (
        SELECT id FROM positions
        WHERE odoo_database_uuid = ${fixture.odooDatabaseUuid}
          AND boss_account_id = ${fixture.bossAccountId}
      )
    `;
    await transaction`
      DELETE FROM schedules
      WHERE position_id IN (
        SELECT id FROM positions
        WHERE odoo_database_uuid = ${fixture.odooDatabaseUuid}
          AND boss_account_id = ${fixture.bossAccountId}
      )
    `;
    await transaction`
      UPDATE rule_sets
      SET active_version_id = NULL
      WHERE position_id IN (
        SELECT id FROM positions
        WHERE odoo_database_uuid = ${fixture.odooDatabaseUuid}
          AND boss_account_id = ${fixture.bossAccountId}
      )
    `;
    await transaction`
      DELETE FROM rule_versions
      WHERE rule_set_id IN (
        SELECT rs.id
        FROM rule_sets rs
        JOIN positions p ON p.id = rs.position_id
        WHERE p.odoo_database_uuid = ${fixture.odooDatabaseUuid}
          AND p.boss_account_id = ${fixture.bossAccountId}
      )
    `;
    await transaction`
      DELETE FROM rule_sets
      WHERE position_id IN (
        SELECT id FROM positions
        WHERE odoo_database_uuid = ${fixture.odooDatabaseUuid}
          AND boss_account_id = ${fixture.bossAccountId}
      )
    `;
    await transaction`
      UPDATE positions SET contact_policy_snapshot_id = NULL
      WHERE odoo_database_uuid = ${fixture.odooDatabaseUuid}
        AND boss_account_id = ${fixture.bossAccountId}
    `;
    await transaction`
      DELETE FROM contact_policy_snapshots
      WHERE position_id IN (
        SELECT id FROM positions
        WHERE odoo_database_uuid = ${fixture.odooDatabaseUuid}
          AND boss_account_id = ${fixture.bossAccountId}
      )
    `;
    await transaction`
      DELETE FROM positions
      WHERE odoo_database_uuid = ${fixture.odooDatabaseUuid}
        AND boss_account_id = ${fixture.bossAccountId}
    `;
  });
}

function assertExactlyOnce(
  rows: Array<{ event_type: string; event_count: number }>,
  eventTypes: string[]
): void {
  const counts = new Map(rows.map((row) => [row.event_type, Number(row.event_count)]));
  for (const eventType of eventTypes) {
    assert.equal(counts.get(eventType), 1, `${eventType} must be emitted exactly once.`);
  }
}

async function expectContactPolicyBlock(
  action: () => Promise<void>,
  disposition: "deferred" | "failed",
  reason: string
): Promise<ContactDispatchPolicyError> {
  try {
    await action();
  } catch (error: unknown) {
    assert(error instanceof ContactDispatchPolicyError);
    assert.equal(error.disposition, disposition);
    assert(error.reasons.includes(reason));
    return error;
  }
  throw new Error(`Expected contact policy block: ${reason}`);
}

async function main(): Promise<void> {
  assert.notEqual(
    process.env.BOSS_FORGE_REAL_GREET_ENABLED,
    "1",
    "Odoo integration smoke refuses to run while real greeting is enabled."
  );

  const suffix = randomUUID();
  const fixture: Fixture = {
    suffix,
    odooDatabaseUuid: `odoo-smoke-${suffix}`,
    bossAccountId: `odoo-smoke-account-${suffix}`,
    jobEventId: randomUUID(),
    mutatedJobEventId: randomUUID(),
    screeningEventId: randomUUID(),
    cancellationRequestEventId: randomUUID(),
    cancellationEventId: randomUUID(),
    contactEventId: randomUUID(),
    authorizationId: randomUUID(),
    requestId: randomUUID(),
    cancellationRequestId: randomUUID(),
    fingerprint: `odoo-smoke-fingerprint-${suffix}`,
    ownerId: `odoo-smoke-owner-${suffix}`,
    requestedById: `odoo-smoke-requester-${suffix}`,
    reviewerId: `odoo-smoke-reviewer-${suffix}`,
    workerId: `odoo-smoke-worker-${suffix}`
  };
  const sql = createDatabase();
  const originalFetch = globalThis.fetch;
  let networkAttemptCount = 0;
  globalThis.fetch = (async () => {
    networkAttemptCount += 1;
    throw new Error("Network access is forbidden in the Odoo database integration smoke test.");
  }) as typeof fetch;

  try {
    const repository = new BossForgeRepository(sql);
    const m2Repository = new M2Repository(sql);
    const integrationRepository = new OdooIntegrationRepository(sql);
    const odooJobId = 91_001;
    const odooApplicantId = 92_001;
    const externalRuleVersionId = `odoo-smoke-rule-${suffix}`;
    const externalPolicyVersionId = `odoo-smoke-policy-${suffix}`;
    const occurredAt = new Date().toISOString();
    const legacyRuleConfig = {
      requiredCapabilities: [{ capability: "tem8" as const, minimumConfidence: 0.9 }]
    };

    const jobEvent = parseOdooInboundEvent({
      eventId: fixture.jobEventId,
      eventType: "job.config.published.v1",
      aggregateType: "hr.job",
      aggregateId: String(odooJobId),
      aggregateVersion: 1,
      occurredAt,
      payload: {
        odooDatabaseUuid: fixture.odooDatabaseUuid,
        odooCompanyId: 1,
        odooJobId,
        name: `Odoo smoke position ${suffix}`,
        bossAccountId: fixture.bossAccountId,
        bossJobKeyword: null,
        ownerId: fixture.ownerId,
        collaboratorIds: [],
        active: true,
        rule: {
          versionId: externalRuleVersionId,
          version: 1,
          schemaVersion: "1.0",
          dictionaryVersion: "builtin.v1",
          config: legacyRuleConfig
        },
        contactPolicy: {
          policyVersionId: externalPolicyVersionId,
          autoContactAfterReview: true,
          dailyLimit: 7,
          allowedStartMinute: 0,
          allowedEndMinute: 1_440,
          crossPositionCooldownHours: 72,
          authorizationTtlHours: 24,
          stopOnUncertain: true
        }
      }
    });
    if (jobEvent.eventType !== "job.config.published.v1") {
      throw new Error("Smoke fixture did not parse as a job configuration event.");
    }
    const firstJob = await integrationRepository.handleInboundEvent(jobEvent);
    const replayedJob = await integrationRepository.handleInboundEvent(jobEvent);
    assert.equal(firstJob.replayed, false);
    assert.equal(replayedJob.replayed, true);
    assert.equal(replayedJob.resourceId, firstJob.resourceId);
    const mutatedJobEvent = parseOdooInboundEvent({
      ...jobEvent,
      eventId: fixture.mutatedJobEventId,
      aggregateVersion: 2,
      occurredAt: new Date().toISOString(),
      payload: {
        ...jobEvent.payload,
        contactPolicy: { ...jobEvent.payload.contactPolicy, dailyLimit: 8 }
      }
    });
    await assert.rejects(
      () => integrationRepository.handleInboundEvent(mutatedJobEvent),
      /different immutable snapshot/
    );
    const newerJobEvent = parseOdooInboundEvent({
      ...jobEvent,
      eventId: randomUUID(),
      aggregateVersion: 2,
      occurredAt: new Date().toISOString(),
      payload: { ...jobEvent.payload, bossJobKeyword: "latest-keyword" }
    });
    const newerJob = await integrationRepository.handleInboundEvent(newerJobEvent);
    assert.equal(newerJob.replayed, false);
    const staleJobEvent = parseOdooInboundEvent({
      ...jobEvent,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      payload: { ...jobEvent.payload, bossJobKeyword: "stale-keyword" }
    });
    const staleJob = await integrationRepository.handleInboundEvent(staleJobEvent);
    assert.equal(staleJob.replayed, true);
    const versionedPosition = await sql<
      Array<{ boss_job_keyword: string | null; aggregate_version: number }>
    >`
      SELECT boss_job_keyword, odoo_config_aggregate_version AS aggregate_version
      FROM positions WHERE id = ${firstJob.resourceId}::uuid
    `;
    assert.equal(versionedPosition[0]?.boss_job_keyword, "latest-keyword");
    assert.equal(versionedPosition[0]?.aggregate_version, 2);
    const positionCounts = await sql<
      Array<{ position_count: number; rule_count: number; policy_count: number }>
    >`
      SELECT
        COUNT(DISTINCT p.id)::int AS position_count,
        COUNT(DISTINCT rv.id)::int AS rule_count,
        COUNT(DISTINCT policy.id)::int AS policy_count
      FROM positions p
      JOIN rule_sets rs ON rs.position_id = p.id
      JOIN rule_versions rv ON rv.rule_set_id = rs.id
      JOIN contact_policy_snapshots policy ON policy.id = p.contact_policy_snapshot_id
      WHERE p.odoo_database_uuid = ${fixture.odooDatabaseUuid}
        AND p.boss_account_id = ${fixture.bossAccountId}
        AND rv.external_version_id = ${externalRuleVersionId}
    `;
    assert.equal(positionCounts[0]?.position_count, 1);
    assert.equal(positionCounts[0]?.rule_count, 1);
    assert.equal(positionCounts[0]?.policy_count, 1);

    const screeningEvent = parseOdooInboundEvent({
      eventId: fixture.screeningEventId,
      eventType: "screening.run.requested.v1",
      aggregateType: "boss.forge.screening.run",
      aggregateId: fixture.requestId,
      aggregateVersion: 1,
      occurredAt,
      payload: {
        requestId: fixture.requestId,
        odooDatabaseUuid: fixture.odooDatabaseUuid,
        odooCompanyId: 1,
        odooJobId,
        requestedById: fixture.requestedById,
        execution: {
          mode: "immediate",
          source: "recommend",
          searchKeyword: null,
          scheduledFor: null
        },
        rule: {
          versionId: externalRuleVersionId,
          version: 1,
          schemaVersion: "1.0",
          dictionaryVersion: "builtin.v1",
          config: legacyRuleConfig
        }
      }
    });
    const firstScreening = await integrationRepository.handleInboundEvent(screeningEvent);
    const replayedScreening = await integrationRepository.handleInboundEvent(screeningEvent);
    assert.equal(firstScreening.replayed, false);
    assert.equal(replayedScreening.replayed, true);
    assert.equal(replayedScreening.resourceId, firstScreening.resourceId);
    const businessReplay = await integrationRepository.handleInboundEvent(
      parseOdooInboundEvent({
        ...screeningEvent,
        eventId: randomUUID(),
        occurredAt: new Date().toISOString()
      })
    );
    assert.equal(businessReplay.replayed, true);
    assert.equal(businessReplay.resourceId, firstScreening.resourceId);
    await assert.rejects(
      () =>
        integrationRepository.handleInboundEvent(
          parseOdooInboundEvent({
            ...screeningEvent,
            eventId: randomUUID(),
            aggregateVersion: 2,
            occurredAt: new Date().toISOString(),
            payload: { ...screeningEvent.payload, requestedById: `${fixture.requestedById}-other` }
          })
        ),
      /different immutable snapshot/
    );
    const taskCounts = await sql<Array<{ task_count: number }>>`
      SELECT COUNT(*)::int AS task_count
      FROM tasks
      WHERE odoo_database_uuid = ${fixture.odooDatabaseUuid}
        AND odoo_run_id = ${fixture.requestId}
    `;
    assert.equal(taskCounts[0]?.task_count, 1);
    const taskPolicyRows = await sql<
      Array<{ external_version_id: string; daily_limit: number }>
    >`
      SELECT policy.external_version_id, policy.daily_limit
      FROM tasks t
      JOIN contact_policy_snapshots policy ON policy.id = t.contact_policy_snapshot_id
      WHERE t.id = ${firstScreening.resourceId}::uuid
    `;
    assert.equal(taskPolicyRows[0]?.external_version_id, externalPolicyVersionId);
    assert.equal(taskPolicyRows[0]?.daily_limit, 7);

    await sql`
      UPDATE tasks SET created_at = '1970-01-01T00:00:00Z'
      WHERE id = ${firstScreening.resourceId}
    `;
    const earlierQueuedTasks = await sql<Array<{ competing_count: number }>>`
      SELECT COUNT(*)::int AS competing_count
      FROM tasks
      WHERE status = 'queued'
        AND id <> ${firstScreening.resourceId}::uuid
        AND created_at <= '1970-01-01T00:00:00Z'
    `;
    assert.equal(
      earlierQueuedTasks[0]?.competing_count,
      0,
      "Refusing to claim because an existing queued task could be selected first."
    );
    const staleTaskLease = await repository.claimNextTask(
      `${fixture.workerId}-stale`,
      fixture.bossAccountId
    );
    assert(staleTaskLease);
    await sql`
      UPDATE tasks SET claimed_at = '1970-01-01T00:00:00Z'
      WHERE id = ${staleTaskLease.id}::uuid
    `;
    const task = await repository.claimNextTask(fixture.workerId, fixture.bossAccountId);
    assert(task);
    assert.equal(task.id, firstScreening.resourceId);
    assert.notEqual(task.claimToken, staleTaskLease.claimToken);
    const evaluation: CandidateEvaluationRecord = {
      sourceReference: `recommend:1:Odoo Smoke Candidate ${suffix}`,
      source: "recommend",
      displayName: `Odoo Smoke Candidate ${suffix}`,
      fingerprint: fixture.fingerprint,
      rawFields: {
        "信息": `odoo-smoke-info-${suffix}`,
        "经验": "5年"
      },
      sourceEvidence: ["英语专业八级 TEM-8"],
      rawText: "英语专业八级 TEM-8",
      decision: "matched",
      confidence: 0.99,
      capabilityId: "language.english.tem8",
      canonicalLabel: "TEM-8",
      dictionaryVersion: "builtin.v1",
      currentEnglishLevel: "TEM-8（英语专业八级）",
      reasonCodes: ["confirmed_alias"],
      evidence: [
        {
          sourceText: "英语专业八级 TEM-8",
          normalizedAlias: "TEM-8",
          status: "positive",
          confidence: 0.99
        }
      ]
    };
    await assert.rejects(
      () => repository.completeTask(staleTaskLease, [evaluation]),
      /lease is no longer active/
    );
    await repository.completeTask(task, [evaluation]);
    const taskLeaseRows = await sql<Array<{ claim_attempts: number }>>`
      SELECT claim_attempts FROM tasks WHERE id = ${task.id}::uuid
    `;
    assert.equal(taskLeaseRows[0]?.claim_attempts, 2);
    const states = await sql<Array<{ id: string; version: number }>>`
      SELECT id, version
      FROM candidate_position_states
      WHERE latest_task_id = ${task.id}
    `;
    assert.equal(states.length, 1);
    const stateId = states[0]!.id;
    await sql`
      UPDATE candidate_position_states
      SET updated_at = '1970-01-01T00:00:00Z'
      WHERE id = ${stateId}
    `;
    const earlierResumeJobs = await sql<Array<{ competing_count: number }>>`
      SELECT COUNT(*)::int AS competing_count
      FROM candidate_position_states
      WHERE id <> ${stateId}::uuid
        AND (
          resume_screening_status = 'queued'
          OR (
            resume_screening_status = 'processing'
            AND resume_screening_claimed_at < now() - interval '15 minutes'
          )
        )
        AND updated_at <= '1970-01-01T00:00:00Z'
    `;
    assert.equal(
      earlierResumeJobs[0]?.competing_count,
      0,
      "Refusing to claim because an existing resume job could be selected first."
    );
    const resumeJob = await repository.claimNextResumeScreening(
      fixture.workerId,
      fixture.bossAccountId
    );
    assert(resumeJob);
    assert.equal(resumeJob.stateId, stateId);
    await repository.completeResumeScreening({
      job: resumeJob,
      record: evaluation,
      screenshotPath: null,
      resumeTextHash: `odoo-smoke-resume-hash-${suffix}`,
      workerId: fixture.workerId
    });

    const screeningOutbound = await sql<
      Array<{ event_type: string; event_count: number }>
    >`
      SELECT event_type, COUNT(*)::int AS event_count
      FROM integration_outbox_events
      WHERE correlation_id = ${fixture.screeningEventId}::uuid
      GROUP BY event_type
    `;
    assertExactlyOnce(screeningOutbound, [
      "screening.run.started.v1",
      "candidate.collected.v1",
      "candidate.screened.v1",
      "screening.run.completed.v1"
    ]);

    const reviewedAt = new Date();
    const reviewEvent = parseOdooInboundEvent({
      eventId: randomUUID(),
      eventType: "candidate.review.completed.v1",
      aggregateType: "candidate_state",
      aggregateId: stateId,
      aggregateVersion: 1,
      occurredAt: reviewedAt.toISOString(),
      payload: {
        candidateStateId: stateId,
        odooDatabaseUuid: fixture.odooDatabaseUuid,
        odooApplicantId,
        odooJobId,
        decision: "approved",
        reviewerId: fixture.reviewerId,
        reviewedAt: reviewedAt.toISOString(),
        reviewVersion: 1
      }
    });
    const firstReview = await integrationRepository.handleInboundEvent(reviewEvent);
    const replayedReview = await integrationRepository.handleInboundEvent(reviewEvent);
    assert.equal(firstReview.replayed, false);
    assert.equal(replayedReview.replayed, true);
    const reviewedTaskRows = await sql<Array<{ status: string }>>`
      SELECT status FROM tasks WHERE id = ${task.id}::uuid
    `;
    assert.equal(reviewedTaskRows[0]?.status, "completed");
    const completionRows = await sql<
      Array<{ completion_count: number; final_pending_review_count: number }>
    >`
      SELECT COUNT(*)::int AS completion_count,
        MIN((payload ->> 'pendingReviewCount')::int)::int AS final_pending_review_count
      FROM integration_outbox_events
      WHERE correlation_id = ${fixture.screeningEventId}::uuid
        AND event_type = 'screening.run.completed.v1'
    `;
    assert.equal(completionRows[0]?.completion_count, 2);
    assert.equal(completionRows[0]?.final_pending_review_count, 0);
    const authorizationExpiresAt = new Date(reviewedAt.getTime() + 24 * 60 * 60 * 1_000);
    const contactEvent = parseOdooInboundEvent({
      eventId: fixture.contactEventId,
      eventType: "candidate.contact.authorized.v1",
      aggregateType: "boss.forge.contact.authorization",
      aggregateId: fixture.authorizationId,
      aggregateVersion: 1,
      occurredAt: new Date().toISOString(),
      payload: {
        authorizationId: fixture.authorizationId,
        candidateStateId: stateId,
        odooDatabaseUuid: fixture.odooDatabaseUuid,
        odooApplicantId,
        odooJobId,
        reviewerId: fixture.reviewerId,
        reviewedAt: reviewedAt.toISOString(),
        reviewVersion: 1,
        bossAccountId: fixture.bossAccountId,
        ruleVersionId: externalRuleVersionId,
        templateVersionId: `odoo-smoke-template-${suffix}`,
        contactPolicyVersionId: externalPolicyVersionId,
        renderedMessage: "您好，我们对您的经历很感兴趣。这是内网 fake smoke，不会真实发送。",
        transportMode: "fake",
        authorizationExpiresAt: authorizationExpiresAt.toISOString(),
        doNotContact: false
      }
    });
    const firstContact = await integrationRepository.handleInboundEvent(contactEvent);
    const replayedContact = await integrationRepository.handleInboundEvent(contactEvent);
    assert.equal(firstContact.replayed, false);
    assert.equal(replayedContact.replayed, true);
    assert.equal(replayedContact.resourceId, firstContact.resourceId);
    const contactCounts = await sql<
      Array<{
        authorization_count: number;
        intent_count: number;
        real_intent_count: number;
        snapshotted_authorization_count: number;
        snapshotted_intent_count: number;
      }>
    >`
      SELECT
        COUNT(DISTINCT ca.id)::int AS authorization_count,
        COUNT(DISTINCT ci.id)::int AS intent_count,
        COUNT(DISTINCT ci.id) FILTER (WHERE ci.transport_mode = 'real')::int
          AS real_intent_count,
        COUNT(DISTINCT ca.id) FILTER (
          WHERE ca.contact_policy_snapshot_id IS NOT NULL AND ca.policy_snapshot IS NOT NULL
        )::int AS snapshotted_authorization_count,
        COUNT(DISTINCT ci.id) FILTER (
          WHERE ci.contact_policy_snapshot_id = ca.contact_policy_snapshot_id
            AND ci.policy_snapshot = ca.policy_snapshot
        )::int AS snapshotted_intent_count
      FROM contact_authorizations ca
      LEFT JOIN contact_intents ci ON ci.authorization_id = ca.id
      WHERE ca.id = ${fixture.authorizationId}::uuid
    `;
    assert.equal(contactCounts[0]?.authorization_count, 1);
    assert.equal(contactCounts[0]?.intent_count, 1);
    assert.equal(contactCounts[0]?.real_intent_count, 0);
    assert.equal(contactCounts[0]?.snapshotted_authorization_count, 1);
    assert.equal(contactCounts[0]?.snapshotted_intent_count, 1);
    await sql`
      UPDATE outbox_events
      SET created_at = '-infinity'::timestamptz
      WHERE aggregate_id = ${firstContact.resourceId}::uuid
    `;
    const earlierFakeDispatches = await sql<Array<{ competing_count: number }>>`
      SELECT COUNT(*)::int AS competing_count
      FROM outbox_events oe
      JOIN contact_intents ci ON ci.id = oe.aggregate_id
      WHERE oe.status = 'pending'
        AND oe.event_type = 'contact.requested'
        AND oe.available_at <= now()
        AND ci.status = 'ready'
        AND ci.transport_mode = 'fake'
        AND ci.id <> ${firstContact.resourceId}::uuid
        AND oe.created_at <= '-infinity'::timestamptz
    `;
    assert.equal(
      earlierFakeDispatches[0]?.competing_count,
      0,
      "Refusing to claim because an existing fake dispatch could be selected first."
    );
    const firstFakeDispatch = await m2Repository.claimContactDispatch(
      fixture.workerId,
      "fake",
      fixture.bossAccountId
    );
    assert(firstFakeDispatch);
    assert.equal(firstFakeDispatch.id, firstContact.resourceId);
    assert.equal(firstFakeDispatch.transportMode, "fake");
    assert.equal(firstFakeDispatch.candidateFingerprint, fixture.fingerprint);
    assert.equal(firstFakeDispatch.source, "recommend");
    assert.equal(firstFakeDispatch.authorizationId, fixture.authorizationId);
    assert.equal(firstFakeDispatch.odooDatabaseUuid, fixture.odooDatabaseUuid);
    assert.equal(firstFakeDispatch.odooJobId, odooJobId);
    assert.equal(firstFakeDispatch.odooApplicantId, odooApplicantId);
    assert.equal(firstFakeDispatch.contactPolicyVersionId, externalPolicyVersionId);
    await sql`
      UPDATE contact_authorizations SET do_not_contact = true
      WHERE id = ${fixture.authorizationId}::uuid
    `;
    await expectContactPolicyBlock(
      () =>
        m2Repository.assertContactDispatchAllowed({
          job: firstFakeDispatch,
          now: new Date().toISOString(),
          localMinuteOfDay: 12 * 60
        }),
      "failed",
      "do_not_contact"
    );
    await sql`
      UPDATE contact_authorizations SET do_not_contact = false
      WHERE id = ${fixture.authorizationId}::uuid
    `;
    await m2Repository.assertContactDispatchAllowed({
      job: firstFakeDispatch,
      now: new Date().toISOString(),
      localMinuteOfDay: 12 * 60
    });

    await sql`
      UPDATE quota_counters SET used = 7
      WHERE scope_type = 'position'
        AND scope_id = (
          SELECT position_id::text FROM candidate_position_states
          WHERE id = ${firstFakeDispatch.candidateStateId}::uuid
        )
    `;
    const quotaBlock = await expectContactPolicyBlock(
      () =>
        m2Repository.assertContactDispatchAllowed({
          job: firstFakeDispatch,
          now: new Date().toISOString(),
          localMinuteOfDay: 12 * 60
        }),
      "deferred",
      "position_daily_limit"
    );
    assert(quotaBlock.availableAt);
    await m2Repository.deferContactDispatch({
      job: firstFakeDispatch,
      availableAt: quotaBlock.availableAt,
      reason: quotaBlock.message
    });
    const deferredRows = await sql<
      Array<{
        intent_status: string;
        outbox_status: string;
        attempt_result: string;
        available_at: Date;
      }>
    >`
      SELECT ci.status AS intent_status, oe.status AS outbox_status,
        ca2.result AS attempt_result, oe.available_at
      FROM contact_intents ci
      JOIN outbox_events oe ON oe.aggregate_id = ci.id
      JOIN contact_attempts ca2 ON ca2.contact_intent_id = ci.id
        AND ca2.attempt_no = ${firstFakeDispatch.attemptNo}
      WHERE ci.id = ${firstFakeDispatch.id}::uuid
    `;
    assert.equal(deferredRows[0]?.intent_status, "ready");
    assert.equal(deferredRows[0]?.outbox_status, "pending");
    assert.equal(deferredRows[0]?.attempt_result, "deferred");
    assert(deferredRows[0]!.available_at.getTime() > Date.now());

    await sql.begin(async (transaction) => {
      await transaction`
        UPDATE quota_counters SET used = 0
        WHERE scope_type = 'position'
          AND scope_id = (
            SELECT position_id::text FROM candidate_position_states
            WHERE id = ${firstFakeDispatch.candidateStateId}::uuid
          )
      `;
      await transaction`
        UPDATE outbox_events SET available_at = now()
        WHERE aggregate_id = ${firstFakeDispatch.id}::uuid
      `;
    });
    const staleFakeDispatch = await m2Repository.claimContactDispatch(
      fixture.workerId,
      "fake",
      fixture.bossAccountId
    );
    assert(staleFakeDispatch);
    await sql`
      UPDATE contact_intents SET started_at = now() - interval '11 minutes'
      WHERE id = ${staleFakeDispatch.id}::uuid
    `;
    assert.equal(
      await m2Repository.recoverStaleContactDispatches(fixture.bossAccountId, "real"),
      0
    );
    assert.equal(
      await m2Repository.recoverStaleContactDispatches(`${fixture.bossAccountId}-other`, "fake"),
      0
    );
    assert.equal(
      await m2Repository.recoverStaleContactDispatches(fixture.bossAccountId, "fake"),
      1
    );
    const fakeRecoveryRows = await sql<
      Array<{ intent_status: string; contact_status: string; outbox_status: string }>
    >`
      SELECT ci.status AS intent_status, cps.contact_status, oe.status AS outbox_status
      FROM contact_intents ci
      JOIN candidate_position_states cps ON cps.id = ci.candidate_position_state_id
      JOIN outbox_events oe ON oe.aggregate_id = ci.id
      WHERE ci.id = ${staleFakeDispatch.id}::uuid
    `;
    assert.deepEqual(fakeRecoveryRows[0], {
      intent_status: "ready",
      contact_status: "queued",
      outbox_status: "pending"
    });
    const fakeUncertainRows = await sql<Array<{ event_count: number }>>`
      SELECT COUNT(*)::int AS event_count
      FROM integration_outbox_events
      WHERE correlation_id = ${fixture.contactEventId}::uuid
        AND event_type = 'contact.uncertain.v1'
    `;
    assert.equal(fakeUncertainRows[0]?.event_count, 0);

    const fakeDispatch = await m2Repository.claimContactDispatch(
      fixture.workerId,
      "fake",
      fixture.bossAccountId
    );
    assert(fakeDispatch);
    await sql.begin(async (transaction) => {
      await transaction`
        UPDATE contact_intents SET transport_mode = 'real'
        WHERE id = ${fakeDispatch.id}::uuid
      `;
      await transaction`
        UPDATE contact_authorizations SET transport_mode = 'real'
        WHERE id = ${fixture.authorizationId}::uuid
      `;
    });
    await expectContactPolicyBlock(
      () =>
        m2Repository.assertContactDispatchAllowed({
          job: { ...fakeDispatch, transportMode: "real" },
          now: new Date().toISOString(),
          localMinuteOfDay: 12 * 60
        }),
      "deferred",
      "authoritative_boss_account_health_unavailable"
    );
    await sql.begin(async (transaction) => {
      await transaction`
        UPDATE contact_intents SET transport_mode = 'fake'
        WHERE id = ${fakeDispatch.id}::uuid
      `;
      await transaction`
        UPDATE contact_authorizations SET transport_mode = 'fake'
        WHERE id = ${fixture.authorizationId}::uuid
      `;
    });
    await m2Repository.finishContactDispatch({
      job: fakeDispatch,
      result: "simulated",
      externalMessage: "fake-smoke-simulated-without-network"
    });

    const contactOutbound = await sql<
      Array<{ event_type: string; event_count: number }>
    >`
      SELECT event_type, COUNT(*)::int AS event_count
      FROM integration_outbox_events
      WHERE correlation_id = ${fixture.contactEventId}::uuid
      GROUP BY event_type
    `;
    assertExactlyOnce(contactOutbound, ["contact.queued.v1", "contact.simulated.v1"]);
    const contactRouteRows = await sql<
      Array<{
        odoo_database_uuid: string;
        odoo_job_id: number;
        odoo_applicant_id: number;
        boss_account_id: string;
        candidate_state_id: string;
        authorization_id: string;
        contact_policy_version_id: string;
        transport_mode: string;
      }>
    >`
      SELECT payload ->> 'odooDatabaseUuid' AS odoo_database_uuid,
        (payload ->> 'odooJobId')::int AS odoo_job_id,
        (payload ->> 'odooApplicantId')::int AS odoo_applicant_id,
        payload ->> 'bossAccountId' AS boss_account_id,
        payload ->> 'candidateStateId' AS candidate_state_id,
        payload ->> 'authorizationId' AS authorization_id,
        payload ->> 'contactPolicyVersionId' AS contact_policy_version_id,
        payload ->> 'transportMode' AS transport_mode
      FROM integration_outbox_events
      WHERE correlation_id = ${fixture.contactEventId}::uuid
        AND event_type = 'contact.simulated.v1'
    `;
    assert.deepEqual(contactRouteRows[0], {
      odoo_database_uuid: fixture.odooDatabaseUuid,
      odoo_job_id: odooJobId,
      odoo_applicant_id: odooApplicantId,
      boss_account_id: fixture.bossAccountId,
      candidate_state_id: stateId,
      authorization_id: fixture.authorizationId,
      contact_policy_version_id: externalPolicyVersionId,
      transport_mode: "fake"
    });
    const finalRows = await sql<
      Array<{
        intent_status: string;
        transport_mode: string;
        contact_status: string;
        attempt_results: string[];
        fake_attempt_count: number;
      }>
    >`
      SELECT ci.status AS intent_status, ci.transport_mode, cps.contact_status,
        ARRAY_AGG(ca2.result ORDER BY ca2.attempt_no) AS attempt_results,
        COUNT(*) FILTER (WHERE ca2.transport = 'fake')::int AS fake_attempt_count
      FROM contact_intents ci
      JOIN candidate_position_states cps ON cps.id = ci.candidate_position_state_id
      JOIN contact_attempts ca2 ON ca2.contact_intent_id = ci.id
      WHERE ci.id = ${firstContact.resourceId}::uuid
      GROUP BY ci.id, cps.id
    `;
    assert.equal(finalRows[0]?.intent_status, "simulated");
    assert.equal(finalRows[0]?.transport_mode, "fake");
    assert.equal(finalRows[0]?.contact_status, "simulated");
    assert.deepEqual(finalRows[0]?.attempt_results, ["deferred", "deferred", "simulated"]);
    assert.equal(finalRows[0]?.fake_attempt_count, 3);
    const fakeQuota = await sql<Array<{ used: number; reserved: number }>>`
      SELECT COALESCE(SUM(used), 0)::int AS used,
        COALESCE(SUM(reserved), 0)::int AS reserved
      FROM quota_counters
      WHERE (scope_type = 'account' AND scope_id = ${fakeDispatch.bossAccountId})
        OR (
          scope_type = 'position'
          AND scope_id = (
            SELECT position_id::text FROM candidate_position_states
            WHERE id = ${fakeDispatch.candidateStateId}::uuid
          )
        )
        OR (scope_type = 'task' AND scope_id = ${fakeDispatch.taskId})
    `;
    assert.equal(fakeQuota[0]?.used, 0);
    assert.equal(fakeQuota[0]?.reserved, 0);
    const fakeReservations = await sql<Array<{ reservation_count: number }>>`
      SELECT COUNT(*)::int AS reservation_count
      FROM contact_quota_reservations
      WHERE contact_intent_id = ${fakeDispatch.id}::uuid
    `;
    assert.equal(fakeReservations[0]?.reservation_count, 0);
    assert.equal(networkAttemptCount, 0);

    const cancellationRequest = parseOdooInboundEvent({
      eventId: fixture.cancellationRequestEventId,
      eventType: "screening.run.requested.v1",
      aggregateType: "boss.forge.screening.run",
      aggregateId: fixture.cancellationRequestId,
      aggregateVersion: 1,
      occurredAt,
      payload: {
        requestId: fixture.cancellationRequestId,
        odooDatabaseUuid: fixture.odooDatabaseUuid,
        odooCompanyId: 1,
        odooJobId,
        requestedById: fixture.requestedById,
        execution: {
          mode: "immediate",
          source: "recommend",
          searchKeyword: null,
          scheduledFor: null
        },
        rule: {
          versionId: externalRuleVersionId,
          version: 1,
          schemaVersion: "1.0",
          dictionaryVersion: "builtin.v1",
          config: legacyRuleConfig
        }
      }
    });
    const cancellationTask = await integrationRepository.handleInboundEvent(cancellationRequest);
    const cancellationEventInput = {
      eventId: fixture.cancellationEventId,
      eventType: "screening.run.cancelled.v1" as const,
      aggregateType: "boss.forge.screening.run",
      aggregateId: fixture.cancellationRequestId,
      aggregateVersion: 2,
      occurredAt: new Date().toISOString(),
      payload: {
        requestId: fixture.cancellationRequestId,
        odooDatabaseUuid: fixture.odooDatabaseUuid,
        odooJobId,
        cancelledById: fixture.requestedById,
        cancelledAt: new Date().toISOString()
      }
    };
    const cancellationEvent = parseOdooInboundEvent(cancellationEventInput);
    const firstCancellation = await integrationRepository.handleInboundEvent(cancellationEvent);
    const replayedCancellation = await integrationRepository.handleInboundEvent(cancellationEvent);
    assert.equal(firstCancellation.resourceId, cancellationTask.resourceId);
    assert.equal(replayedCancellation.replayed, true);
    const cancelledRows = await sql<Array<{ status: string }>>`
      SELECT status FROM tasks WHERE id = ${cancellationTask.resourceId}::uuid
    `;
    assert.equal(cancelledRows[0]?.status, "cancelled");
    const cancellationOutbound = await sql<
      Array<{ event_type: string; event_count: number; completion_status: string | null }>
    >`
      SELECT event_type, COUNT(*)::int AS event_count,
        MAX(payload ->> 'status') AS completion_status
      FROM integration_outbox_events
      WHERE correlation_id = ${fixture.cancellationEventId}::uuid
      GROUP BY event_type
    `;
    assertExactlyOnce(cancellationOutbound, ["screening.run.completed.v1"]);
    assert.equal(cancellationOutbound[0]?.completion_status, "cancelled");

    const mismatchedCancellation = parseOdooInboundEvent({
      ...cancellationEventInput,
      payload: {
        ...cancellationEventInput.payload,
        cancelledById: `${fixture.requestedById}-mutated`
      }
    });
    await assert.rejects(
      () => integrationRepository.handleInboundEvent(mismatchedCancellation),
      /different immutable envelope/
    );
    const immutableInbox = await sql<Array<{ status: string }>>`
      SELECT status FROM integration_inbox_events
      WHERE event_id = ${fixture.cancellationEventId}::uuid
    `;
    assert.equal(immutableInbox[0]?.status, "completed");

    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "fake-only",
          realGreetingEnabled: false,
          networkAttempts: networkAttemptCount,
          positionId: firstJob.resourceId,
          taskId: task.id,
          candidateStateId: stateId,
          contactIntentId: fakeDispatch.id,
          screeningEvents: screeningOutbound.map((row) => row.event_type).sort(),
          contactEvents: contactOutbound.map((row) => row.event_type).sort(),
          cancellationEvent: cancellationOutbound[0]?.event_type
        },
        null,
        2
      )
    );
  } finally {
    globalThis.fetch = originalFetch;
    try {
      await cleanup(sql, fixture);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
