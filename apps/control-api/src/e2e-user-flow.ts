import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  BossForgeRepository,
  createDatabase,
  type CandidateEvaluationRecord
} from "@boss-forge/data";

const api = process.env.CONTROL_API_URL?.trim() || "http://127.0.0.1:3100";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${api}${path}`, init);
  const payload = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(`${path}: ${payload.message ?? `HTTP ${response.status}`}`);
  return payload;
}

async function main(): Promise<void> {
  const sql = createDatabase();
  const repository = new BossForgeRepository(sql);
  const suffix = randomUUID();
  const accountId = `e2e-account-${suffix}`;
  const fingerprint = `e2e-fingerprint-${suffix}`;
  let positionId: string | null = null;
  const contactWindowRows = await sql<
    Array<{ allowed_start_minute: number; allowed_end_minute: number }>
  >`
    SELECT allowed_start_minute, allowed_end_minute
    FROM contact_settings WHERE id = 'global'
  `;
  const originalContactWindow = contactWindowRows[0];
  assert(originalContactWindow, "Global contact settings must exist before E2E.");
  const shanghaiNow = new Date(Date.now() + 8 * 60 * 60 * 1_000);
  const shanghaiMinute = shanghaiNow.getUTCHours() * 60 + shanghaiNow.getUTCMinutes();
  const e2eWindowStart = (shanghaiMinute + 1_435) % 1_440;
  const e2eWindowEnd = (shanghaiMinute + 60) % 1_440;
  await sql`
    UPDATE contact_settings
    SET allowed_start_minute = ${e2eWindowStart},
      allowed_end_minute = ${e2eWindowEnd}, updated_at = now()
    WHERE id = 'global'
  `;
  try {
    const queued = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM tasks WHERE status = 'queued'
    `;
    assert.equal(queued[0]?.count, 0, "E2E requires an idle collection queue.");

    const positionPayload = await request<{ position: { id: string; name: string } }>(
      "/api/positions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bossAccountId: accountId,
          name: `E2E 海外运营 ${suffix.slice(0, 8)}`,
          bossJobKeyword: "海外运营",
          ownerName: "E2E HR"
        })
      }
    );
    positionId = positionPayload.position.id;

    await request(`/api/positions/${positionId}/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "E2E TEM8 硬性条件",
        config: { requiredCapabilities: [{ capability: "tem8", minimumConfidence: 0.86 }] },
        dictionaryVersion: "e2e.1",
        createdBy: "e2e:hr"
      })
    });

    const taskPayload = await request<{ task: { id: string } }>("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `e2e-task-${suffix}` },
      body: JSON.stringify({
        positionId,
        source: "recommend",
        createdBy: "e2e:hr"
      })
    });
    const task = await repository.claimNextTask("e2e-worker", accountId);
    assert(task);
    assert.equal(task.id, taskPayload.task.id);
    const evaluation: CandidateEvaluationRecord = {
        sourceReference: `e2e:${suffix}`,
        source: "recommend",
        displayName: "E2E 候选人",
        fingerprint,
        rawFields: { 信息: "5年海外运营经验", 期望: "海外运营", 证书: "TEM8" },
        sourceEvidence: ["英语专业八级（TEM-8）"],
        rawText: "5年海外运营经验，已通过英语专业八级（TEM-8）。",
        decision: "matched",
        confidence: 0.99,
        capabilityId: "language.english.tem8",
        canonicalLabel: "TEM-8",
        dictionaryVersion: "e2e.1",
        currentEnglishLevel: "TEM-8（英语专业八级）",
        reasonCodes: ["confirmed_alias"],
        evidence: [
          {
            sourceText: "英语专业八级（TEM-8）",
            normalizedAlias: "TEM-8",
            status: "positive",
            confidence: 0.99
          }
        ]
      };
    await repository.completeTask(task, [evaluation]);
    const resumeJob = await repository.claimNextResumeScreening("e2e-worker", accountId);
    assert(resumeJob);
    await repository.completeResumeScreening({
      job: resumeJob,
      record: evaluation,
      screenshotPath: "/tmp/e2e-resume.png",
      resumeTextHash: `e2e-resume-hash-${suffix}`,
      workerId: "e2e-worker"
    });

    const dashboardBefore = await request<{
      candidates: Array<{
        stateId: string;
        name: string;
        stateVersion: number;
        reviewStatus: string;
        resumeScreeningStatus: string;
        currentEnglishLevel: string | null;
      }>;
    }>("/api/dashboard");
    const candidate = dashboardBefore.candidates.find((item) => item.name === "E2E 候选人");
    assert(candidate);
    assert.equal(candidate.reviewStatus, "pending");
    assert.equal(candidate.resumeScreeningStatus, "screened");
    assert.equal(candidate.currentEnglishLevel, "TEM-8（英语专业八级）");

    const detail = await request<{ candidate: { evidence: string[]; rawText: string } }>(
      `/api/candidate-position-states/${candidate.stateId}`
    );
    assert(detail.candidate.evidence.some((item) => item.includes("TEM-8")));

    await request(`/api/candidate-position-states/${candidate.stateId}/reviews`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `e2e-review-${suffix}` },
      body: JSON.stringify({
        decision: "approved",
        note: "E2E 用户确认 TEM8 原文证据准确。",
        reviewerId: "e2e:hr",
        expectedVersion: candidate.stateVersion
      })
    });

    const previewPayload = await request<{
      preview: { templateVersionId: string; renderedMessage: string };
    }>(`/api/candidate-position-states/${candidate.stateId}/message-preview`);
    assert(previewPayload.preview.renderedMessage.includes("E2E 候选人"));

    const intentPayload = await request<{
      intent: { status: string };
      realGreetingEnabled: boolean;
    }>(`/api/candidate-position-states/${candidate.stateId}/contact-intents`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `e2e-contact-${suffix}` },
      body: JSON.stringify({
        templateVersionId: previewPayload.preview.templateVersionId,
        createdBy: "e2e:hr"
      })
    });
    assert.equal(intentPayload.intent.status, "ready");
    assert.equal(intentPayload.realGreetingEnabled, false);

    const schedulePayload = await request<{ schedule: { id: string; version: number } }>(
      "/api/schedules",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `e2e-schedule-${suffix}`
        },
        body: JSON.stringify({
          positionId,
          source: "recommend",
          frequency: "weekdays",
          nextRunAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          createdBy: "e2e:hr"
        })
      }
    );
    await request(`/api/schedules/${schedulePayload.schedule.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: schedulePayload.schedule.version, actorId: "e2e:hr" })
    });

    const dashboardAfter = await request<{
      candidates: Array<{ stateId: string; reviewStatus: string; contactStatus: string }>;
      contactIntents: Array<{ candidateStateId: string; status: string }>;
      auditLogs: Array<{ actorId: string; action: string }>;
    }>("/api/dashboard");
    const approved = dashboardAfter.candidates.find((item) => item.stateId === candidate.stateId);
    assert.equal(approved?.reviewStatus, "approved");
    assert.equal(approved?.contactStatus, "queued");
    assert(dashboardAfter.contactIntents.some((item) => item.candidateStateId === candidate.stateId));
    assert(dashboardAfter.auditLogs.some((item) => item.actorId === "e2e:hr"));

    console.log(
      JSON.stringify({
        ok: true,
        flow: [
          "position_created",
          "rule_created",
          "immediate_task_created",
          "candidate_reviewed",
          "message_previewed",
          "contact_intent_created_without_real_greet",
          "schedule_created_and_cancelled",
          "audit_verified"
        ],
        realGreetingExecuted: false
      })
    );
  } finally {
    await sql`
      UPDATE contact_settings
      SET allowed_start_minute = ${originalContactWindow.allowed_start_minute},
        allowed_end_minute = ${originalContactWindow.allowed_end_minute},
        updated_at = now()
      WHERE id = 'global'
    `;
    if (positionId) {
      await sql.begin(async (transaction) => {
        await transaction`
          DELETE FROM outbox_events WHERE aggregate_id IN (
            SELECT ci.id FROM contact_intents ci JOIN candidate_position_states cps
              ON cps.id = ci.candidate_position_state_id WHERE cps.position_id = ${positionId}
          )
        `;
        await transaction`
          DELETE FROM contact_attempts WHERE contact_intent_id IN (
            SELECT ci.id FROM contact_intents ci JOIN candidate_position_states cps
              ON cps.id = ci.candidate_position_state_id WHERE cps.position_id = ${positionId}
          )
        `;
        await transaction`
          DELETE FROM contact_intents WHERE candidate_position_state_id IN (
            SELECT id FROM candidate_position_states WHERE position_id = ${positionId}
          )
        `;
        await transaction`
          DELETE FROM reviews WHERE candidate_position_state_id IN (
            SELECT id FROM candidate_position_states WHERE position_id = ${positionId}
          )
        `;
        await transaction`
          DELETE FROM match_evidence WHERE candidate_position_state_id IN (
            SELECT id FROM candidate_position_states WHERE position_id = ${positionId}
          )
        `;
        await transaction`DELETE FROM candidate_position_states WHERE position_id = ${positionId}`;
        await transaction`
          DELETE FROM candidate_snapshots WHERE task_id IN (
            SELECT id FROM tasks WHERE position_id = ${positionId}
          )
        `;
        await transaction`DELETE FROM tasks WHERE position_id = ${positionId}`;
        await transaction`DELETE FROM schedules WHERE position_id = ${positionId}`;
        await transaction`UPDATE rule_sets SET active_version_id = NULL WHERE position_id = ${positionId}`;
        await transaction`
          DELETE FROM rule_versions WHERE rule_set_id IN (
            SELECT id FROM rule_sets WHERE position_id = ${positionId}
          )
        `;
        await transaction`DELETE FROM rule_sets WHERE position_id = ${positionId}`;
        await transaction`DELETE FROM candidates WHERE fingerprint = ${fingerprint}`;
        await transaction`DELETE FROM positions WHERE id = ${positionId}`;
        await transaction`DELETE FROM audit_logs WHERE actor_id = 'e2e:hr'`;
      });
    }
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
