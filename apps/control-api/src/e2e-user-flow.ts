import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  BossForgeRepository,
  createDatabase,
  type CandidateEvaluationRecord
} from "@boss-forge/data";

const api = process.env.CONTROL_API_URL?.trim() || "http://127.0.0.1:3100";
let authToken: string | null = null;
let authenticatedUserId: string | null = null;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (authToken) headers.set("authorization", `Bearer ${authToken}`);
  const response = await fetch(`${api}${path}`, { ...init, headers });
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
  let isolatedPositionId: string | null = null;
  let crossPositionStateId: string | null = null;
  let departmentId: string | null = null;
  let semanticCatalogId: string | null = null;
  let evaluationSetId: string | null = null;
  let talentTagId: string | null = null;
  let exportId: string | null = null;
  const recruiterEmail = `e2e-recruiter-${suffix}@boss-forge.internal`;
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
    const unauthenticated = await fetch(`${api}/api/dashboard`);
    assert.equal(unauthenticated.status, 401, "Dashboard must reject anonymous access.");
    const login = await request<{ token: string; principal: { userId: string; departmentId: string } }>("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: process.env.BOSS_FORGE_BOOTSTRAP_ADMIN_EMAIL ?? "admin@boss-forge.internal",
        password: process.env.BOSS_FORGE_BOOTSTRAP_PASSWORD ?? "ChangeMe-BossForge-Internal!"
      })
    });
    authToken = login.token;
    authenticatedUserId = login.principal.userId;
    departmentId = login.principal.departmentId;
    const adminToken = login.token;
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

    const recruiter = await request<{ user: { id: string } }>("/api/team/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: recruiterEmail,
        displayName: "E2E 招聘专员",
        role: "recruiter",
        password: "E2E-Recruiter-Password!"
      })
    });
    await request(`/api/positions/${positionId}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: recruiter.user.id, memberRole: "recruiter" })
    });
    const isolated = await request<{ position: { id: string } }>("/api/positions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bossAccountId: accountId,
        name: `E2E 隔离岗位 ${suffix.slice(0, 8)}`,
        ownerName: "ignored"
      })
    });
    isolatedPositionId = isolated.position.id;
    const recruiterLogin = await request<{ token: string }>("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: recruiterEmail, password: "E2E-Recruiter-Password!" })
    });
    authToken = recruiterLogin.token;
    const recruiterDashboard = await request<{ positions: Array<{ id: string }> }>("/api/dashboard");
    assert.deepEqual(recruiterDashboard.positions.map((item) => item.id), [positionId]);
    const forbidden = await fetch(`${api}/api/positions/${isolatedPositionId}/rules`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${authToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name: "越权规则",
        config: { requiredCapabilities: [{ capability: "tem8", minimumConfidence: 0.8 }] },
        dictionaryVersion: "e2e.forbidden"
      })
    });
    assert.equal(forbidden.status, 401, "Recruiter must not modify an unassigned position.");
    authToken = adminToken;

    const baselineDraft = await request<{ version: { id: string } }>(`/api/positions/${positionId}/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "E2E TEM8 硬性条件",
        config: { requiredCapabilities: [{ capability: "tem8", minimumConfidence: 0.86 }] },
        dictionaryVersion: "e2e.1",
        createdBy: "e2e:hr"
      })
    });
    await request(`/api/rules/versions/${baselineDraft.version.id}/lifecycle`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "pending_approval" })
    });
    await request(`/api/rules/versions/${baselineDraft.version.id}/lifecycle`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "published" })
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

    const pipeline = await request<{ items: Array<{ stateId: string; candidateId: string }> }>(
      `/api/pipeline?positionId=${positionId}`
    );
    const pipelineCandidate = pipeline.items.find((item) => item.stateId === candidate.stateId);
    assert(pipelineCandidate);
    crossPositionStateId = randomUUID();
    await sql`
      INSERT INTO candidate_position_states (
        id, position_id, candidate_id, latest_task_id, latest_snapshot_id, rule_version_id,
        rule_decision, rule_confidence, review_status, contact_status
      )
      SELECT ${crossPositionStateId}, ${isolatedPositionId}, candidate_id, latest_task_id,
        latest_snapshot_id, rule_version_id, rule_decision, rule_confidence, 'pending', 'not_contacted'
      FROM candidate_position_states WHERE id = ${candidate.stateId}
    `;
    const crossPosition = await request<{ profiles: Array<{ candidateId: string; applications: number; applicationViews: unknown[] }> }>("/api/collaboration");
    const sharedProfile = crossPosition.profiles.find((item) => item.candidateId === pipelineCandidate.candidateId);
    assert.equal(sharedProfile?.applications, 2);
    assert.equal(sharedProfile?.applicationViews.length, 2);
    await request(`/api/pipeline/${candidate.stateId}/stage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage: "review" })
    });
    await request(`/api/pipeline/${candidate.stateId}/notes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "E2E 协作备注", mentionedUserIds: [recruiter.user.id] })
    });
    await request(`/api/collaboration/states/${candidate.stateId}/attachments`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileName: "e2e-portfolio.pdf", mimeType: "application/pdf", storagePath: "/internal/e2e.pdf", sizeBytes: 123 })
    });
    const work = await request<{ workItem: { id: string } }>("/api/collaboration/work-items", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ stateId: candidate.stateId, assignedTo: recruiter.user.id, title: "E2E 跟进", dueAt: new Date(Date.now() + 3_600_000).toISOString() })
    });
    await request(`/api/collaboration/work-items/${work.workItem.id}/complete`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    });
    const interview = await request<{ interview: { id: string } }>("/api/collaboration/interviews", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ stateId: candidate.stateId, startsAt: new Date(Date.now() + 7_200_000).toISOString(), endsAt: new Date(Date.now() + 10_800_000).toISOString(), location: "E2E 会议室", participantIds: [authenticatedUserId] })
    });
    await request(`/api/collaboration/interviews/${interview.interview.id}/feedback`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ recommendation: "yes", score: 5, strengths: "证据清晰", concerns: "无" })
    });
    const collaboration = await request<{ activities: unknown[]; notes: unknown[]; attachments: unknown[]; workItems: unknown[]; interviews: unknown[] }>(`/api/collaboration?stateId=${candidate.stateId}`);
    assert(collaboration.activities.length && collaboration.notes.length && collaboration.attachments.length && collaboration.workItems.length && collaboration.interviews.length);

    const rulesBefore = await request<{ versions: Array<{ id: string; positionId: string; status: string }> }>("/api/rules/workspace");
    const baselineRule = rulesBefore.versions.find((item) => item.positionId === positionId && item.status === "published");
    assert(baselineRule);
    const draft = await request<{ version: { id: string } }>("/api/rules/drafts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        positionId, name: "E2E 复合规则", dictionaryVersion: "e2e.visual.2",
        config: { schemaVersion: "1.1", name: "E2E 复合规则", root: { operator: "AND", children: [
          { type: "tem8", minimumConfidence: 0.86, unknownPolicy: "manual_review" },
          { type: "range", field: "yearsOfExperience", minimum: 6, unknownPolicy: "manual_review" }
        ] } }
      })
    });
    const replay = await request<{ replay: { sampleSize: number; changedCount: number } }>("/api/rules/replays", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ positionId, baselineVersionId: baselineRule.id, candidateVersionId: draft.version.id })
    });
    assert.equal(replay.replay.sampleSize, 1);
    assert(replay.replay.changedCount >= 1, "Changed rule must produce a replay difference.");
    await request(`/api/rules/versions/${draft.version.id}/lifecycle`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "pending_approval" })
    });
    await request(`/api/rules/versions/${draft.version.id}/lifecycle`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "published" })
    });
    await request("/api/rules/templates", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `E2E 部门模板 ${suffix}`, description: "E2E", config: { schemaVersion: "1.1", root: { operator: "AND", children: [{ type: "tem8", minimumConfidence: 0.8, unknownPolicy: "manual_review" }] } } })
    });

    const catalog = await request<{ catalog: { id: string; versionId: string } }>("/api/semantic/catalogs", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `E2E 语义目录 ${suffix}`, promptTemplate: "严格引用原文；不确定返回 unknown。", modelName: "e2e-deterministic", entries: [{ canonical: "TEM8", aliases: ["TEM8", "英语专业八级", "英语八级"] }] })
    });
    semanticCatalogId = catalog.catalog.id;
    const evaluationSet = await request<{ set: { id: string } }>("/api/semantic/evaluation-sets", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `E2E 固定评估集 ${suffix}`, description: "E2E HR gold set" })
    });
    evaluationSetId = evaluationSet.set.id;
    await request("/api/semantic/evaluation-cases", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ setId: evaluationSetId, criterionId: "certificate.tem8", sourceText: "已通过英语专业八级", expectedResult: "matched" })
    });
    const semanticRun = await request<{ run: { metrics: { accuracy: number } } }>("/api/semantic/evaluation-runs", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ setId: evaluationSetId, catalogVersionId: catalog.catalog.versionId })
    });
    assert.equal(semanticRun.run.metrics.accuracy, 1);
    await request(`/api/semantic/versions/${catalog.catalog.versionId}/publish`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    });
    await request("/api/semantic/mode", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ positionId, mode: "active", catalogVersionId: catalog.catalog.versionId })
    });

    await request(`/api/candidate-position-states/${candidate.stateId}/reviews`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `e2e-review-${suffix}` },
      body: JSON.stringify({
        decision: "approved",
        note: "E2E 用户确认 TEM8 原文证据准确。",
        reviewerId: "e2e:hr",
        expectedVersion: candidate.stateVersion + 1
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

    await request("/api/operations/messages/sync", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ stateId: candidate.stateId, externalMessageId: `e2e-message-${suffix}`, direction: "inbound", body: "E2E 候选人回复", sentAt: new Date().toISOString() })
    });
    const tag = await request<{ tag: { id: string } }>("/api/operations/tags", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `E2E 标签 ${suffix}`, color: "blue" })
    });
    talentTagId = tag.tag.id;
    await request("/api/operations/tag-candidate", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ candidateId: pipelineCandidate.candidateId, tagId: talentTagId })
    });
    await request("/api/operations/account-health", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ bossAccountId: accountId, status: "healthy", authoritative: true, reason: "E2E health probe", checkedAt: new Date().toISOString() })
    });
    const exported = await request<{ export: { id: string; rowCount: number } }>("/api/operations/export", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ format: "json" })
    });
    assert(exported.export.rowCount >= 1);
    exportId = exported.export.id;
    assert(departmentId);
    const control = (scopeType: string, scopeId: string, enabled: boolean, approvalRequired: boolean, emergencyStop = false) =>
      request("/api/automation/controls", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scopeType, scopeId, enabled, approvalRequired, emergencyStop, policy: { dailyLimit: 50, hourlyLimit: 10, cooldownMinutes: 30, startMinute: 0, endMinute: 1440 } }) });
    await control("global", "global", true, false);
    await control("department", departmentId, true, false);
    await control("position", positionId, true, true);
    const approval = await request<{ approval: { id: string } }>("/api/automation/approval-requests", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scopeType: "position", scopeId: positionId, justification: "E2E 准确率与人工授权已通过" })
    });
    await request(`/api/automation/approval-requests/${approval.approval.id}/decision`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approved", note: "E2E approval" })
    });
    const ready = await request<{ ready: boolean }>(`/api/automation/readiness?positionId=${positionId}`);
    assert.equal(ready.ready, true);
    const simulation = await request<{ simulated: boolean; realGreetingExecuted: boolean }>("/api/automation/simulate", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ positionId, candidateId: pipelineCandidate.candidateId })
    });
    assert.equal(simulation.simulated, true); assert.equal(simulation.realGreetingExecuted, false);
    await request("/api/talent/do-not-contact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ candidateId: pipelineCandidate.candidateId, active: true, reason: "E2E DNC" }) });
    const dncBlocked = await request<{ ready: boolean; reasons: string[] }>(`/api/automation/readiness?positionId=${positionId}&candidateId=${pipelineCandidate.candidateId}`);
    assert.equal(dncBlocked.ready, false); assert(dncBlocked.reasons.some((reason) => reason.includes("Do-Not-Contact")));
    await request("/api/talent/do-not-contact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ candidateId: pipelineCandidate.candidateId, active: false, reason: "E2E clear" }) });
    await control("position", positionId, false, true, true);
    const stopped = await request<{ ready: boolean }>(`/api/automation/readiness?positionId=${positionId}`);
    assert.equal(stopped.ready, false);

    const dashboardAfter = await request<{
      candidates: Array<{ stateId: string; reviewStatus: string; contactStatus: string }>;
      contactIntents: Array<{ candidateStateId: string; status: string }>;
      auditLogs: Array<{ actorId: string; action: string }>;
    }>("/api/dashboard");
    const approved = dashboardAfter.candidates.find((item) => item.stateId === candidate.stateId);
    assert.equal(approved?.reviewStatus, "approved");
    assert.equal(approved?.contactStatus, "queued");
    assert(dashboardAfter.contactIntents.some((item) => item.candidateStateId === candidate.stateId));
    assert(dashboardAfter.auditLogs.some((item) => item.actorId === authenticatedUserId));

    console.log(
      JSON.stringify({
        ok: true,
        flow: [
          "authenticated_department_session",
          "cross_position_access_denied",
          "pipeline_notes_attachments_work_items_interview_feedback",
          "rule_lifecycle_template_replay",
          "semantic_catalog_evaluation_active_gate",
          "boss_reply_talent_tag_health_export",
          "multi_level_controls_approval_dnc_emergency_stop",
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
    if (crossPositionStateId) await sql`DELETE FROM candidate_position_states WHERE id = ${crossPositionStateId}`;
    if (positionId) {
      await sql`DELETE FROM contact_approval_requests WHERE scope_id = ${positionId}`;
      await sql`DELETE FROM contact_controls WHERE scope_type = 'position' AND scope_id = ${positionId}`;
      await sql`DELETE FROM rule_replay_runs WHERE position_id = ${positionId}`;
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
        await transaction`DELETE FROM positions WHERE id = ${positionId}`;
        await transaction`DELETE FROM audit_logs WHERE actor_id = 'e2e:hr'`;
      });
    }
    if (departmentId) {
      await sql`DELETE FROM contact_controls WHERE scope_type = 'department' AND scope_id = ${departmentId} AND updated_by = ${authenticatedUserId}`;
      await sql`
        UPDATE contact_controls SET enabled = false, approval_required = true, approved_by = NULL,
          approved_at = NULL, emergency_stop = false, version = version + 1, updated_at = now()
        WHERE scope_type = 'global' AND scope_id = 'global'
      `;
    }
    if (evaluationSetId) await sql`DELETE FROM semantic_evaluation_sets WHERE id = ${evaluationSetId}`;
    if (semanticCatalogId) await sql`DELETE FROM semantic_catalogs WHERE id = ${semanticCatalogId}`;
    if (talentTagId) await sql`DELETE FROM talent_tags WHERE id = ${talentTagId}`;
    if (exportId) await sql`DELETE FROM data_export_jobs WHERE id = ${exportId}`;
    await sql`DELETE FROM rule_templates WHERE name = ${`E2E 部门模板 ${suffix}`}`;
    await sql`DELETE FROM account_health WHERE boss_account_id = ${accountId}`;
    if (isolatedPositionId) {
      await sql`DELETE FROM positions WHERE id = ${isolatedPositionId}`;
    }
    await sql`DELETE FROM candidates WHERE fingerprint = ${fingerprint}`;
    await sql`DELETE FROM users WHERE email = ${recruiterEmail}`;
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
