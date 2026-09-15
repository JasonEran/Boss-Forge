import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { evaluateCandidate } from "../../m1-core/src/index.js";
import { parseRecruitmentAssessment } from "@boss-forge/semantic-engine";
import { briefFixture } from "../../contracts/src/recruitment.test-fixture.js";
import { BossForgeRepository, DepartmentAtsRepository, M2Repository, RecruitmentRepository, createDatabase, parseRuleConfig, assertIsolatedTestDatabase, type SessionPrincipal } from "./index.js";

assertIsolatedTestDatabase(process.env, { contactSideEffects: true });
const sql = createDatabase();
const repository = new BossForgeRepository(sql);
const ats = new DepartmentAtsRepository(sql);
const contacts = new M2Repository(sql);
const ai = new RecruitmentRepository(sql);
const suffix = randomUUID();
try {
  await ats.ensureBootstrap({ departmentName: "体验验收", adminEmail: "recruitment-test@example.com", adminName: "验收管理员", password: "Local-Recruitment-Test-Only!" });
  const admin = (await sql`SELECT id, department_id, email, display_name FROM users WHERE role = 'admin' LIMIT 1`)[0]!;
  const principal: SessionPrincipal = { userId: admin.id, departmentId: admin.department_id, email: admin.email, displayName: admin.display_name, role: "admin" };
  const position = await repository.createPosition({ bossAccountId: `recruitment-test-${suffix}`, name: `海外内容运营验收 ${suffix.slice(0, 6)}`, ownerName: admin.display_name });
  await sql`UPDATE positions SET department_id = ${principal.departmentId}, owner_user_id = ${principal.userId}, boss_job_id = ${`job-${suffix}`}, boss_job_keyword = ${`job-${suffix}`} WHERE id = ${position.id}`;
  const config = parseRuleConfig({ schemaVersion: "1.0", root: { operator: "AND", children: [] }, screeningFlow: "boss_then_resume", bossRecommendationFilters: { mode: "custom", fields: {} }, recruitment: briefFixture });
  const rule = await repository.createRuleVersion({ positionId: position.id, name: "目标驱动筛选", config, dictionaryVersion: "test", createdBy: principal.userId });
  const task = await repository.createImmediateTask({ positionId: position.id, idempotencyKey: suffix, source: "recommend", createdBy: principal.userId, candidateLimit: 3 });
  const claimed = await repository.claimNextTask("test-worker", position.bossAccountId);
  assert.equal(claimed?.id, task.id);
  const resume = "负责海外社媒账号运营。独立策划并撰写英文内容。建立内容日历，三个月自然流量增长40%。";
  const candidates = ["10-15K", "8-12K", "9-11K"].map((salary, index) => ({ index: index + 1, name: ["预算超出示例", "目标相关示例", "低分复核示例"][index]!, source: "recommend" as const, sourceLocator: { kind: "boss_geek_id" as const, value: `test-${suffix}-${index}` }, fields: { 薪资: salary }, evidence: [], raw: resume }));
  await repository.completeTask(claimed!, candidates.map(candidate => evaluateCandidate(candidate, config)), position.name);
  let dashboard = await repository.getDashboard({ positionIds: [position.id] });
  const over = dashboard.candidates.find(item => item.name === "预算超出示例")!;
  assert.equal(over.resumeScreeningStatus, "screened");
  assert.equal(over.ruleDecision, "not_matched");
  assert.equal(over.salaryScreening?.upperYuan, 15000);
  assert.equal((await repository.getCandidateDetail(over.stateId))?.resumeScreenshotAvailable, false);
  for (let index = 0; index < 2; index++) {
    const job = await repository.claimNextResumeScreening("test-worker", position.bossAccountId);
    assert(job && job.candidateName !== "预算超出示例", "salary rejection must not claim or view a résumé");
    await repository.completeResumeScreening({ job, record: evaluateCandidate(job.candidate, config, resume), screenshotPath: null, resumeTextHash: `test-${index}`, workerId: "test-worker" });
  }
  assert.equal(await repository.claimNextResumeScreening("test-worker", position.bossAccountId), null);
  assert.equal((await sql`SELECT * FROM recruitment_assessments WHERE task_id = ${task.id}`).length, 2);
  const env = { BOSS_FORGE_SEMANTIC_ENABLED: "1", BOSS_FORGE_SEMANTIC_BASE_URL: "https://example.com/v1", BOSS_FORGE_SEMANTIC_API_KEY: "fixture", BOSS_FORGE_SEMANTIC_MODEL: "fixture" };
  let calls = 0;
  const score = async (input: Parameters<typeof parseRecruitmentAssessment>[1]) => {
    const high = calls++ === 0;
    return parseRecruitmentAssessment({ understanding: "招聘可独立产出英文内容并跟踪海外增长的运营。", summary: high ? "与目标有直接相关经历，建议核实具体贡献。" : "部分能力相关，但成果证据需要补充。", gaps: ["需要核实转化归因"], interviewQuestions: ["哪些成果由你独立完成？"], dimensions: [
      { key: "goals", score: high ? 35 : 15, reason: "有运营实践", evidence: ["负责海外社媒账号运营。"] },
      { key: "skills", score: high ? 30 : 20, reason: "有英文写作实践", evidence: ["独立策划并撰写英文内容。"] },
      { key: "delivery", score: high ? 20 : 15, reason: "成果归因待核实", evidence: ["三个月自然流量增长40%。"] },
    ] }, input);
  };
  await Promise.all([ai.processOne(env, input => score({ ...input, model: "fixture" })), ai.processOne(env, input => score({ ...input, model: "fixture" }))]);
  assert.equal(calls, 2, "parallel processors must claim distinct candidates");
  dashboard = await repository.getDashboard({ positionIds: [position.id] });
  const scored = dashboard.candidates.filter(item => item.assessment);
  assert.deepEqual(scored.map(item => item.assessment!.result!.score).sort(), [50, 85]);
  assert(scored.every(item => item.reviewStatus === 'pending'), "AI scores must preserve meaningful HR review");
  for (const candidate of scored) {
    await repository.reviewCandidate({ stateId: candidate.stateId, idempotencyKey: `${suffix}:${candidate.stateId}`, decision: 'approved', note: '验收：人工核实证据后通过', correctionCode: 'other', reviewerId: principal.userId, expectedVersion: candidate.stateVersion });
  }
  const savedA = await ats.savePositionMessageTemplate(principal, position.id, "你好，{{ candidate_name }}，我是{{ hr_name }}，想交流岗位。", "初次联系") as { activeVersionId: string };
  const savedB = await ats.savePositionMessageTemplate(principal, position.id, "你好，想邀请你了解我们的海外内容运营岗位。", "简短招呼") as { activeVersionId: string };
  assert.notEqual(savedA.activeVersionId, savedB.activeVersionId);
  assert.equal((await contacts.previewMessage(scored[0]!.stateId, savedA.activeVersionId, "王经理")).renderedMessage, `你好，${scored[0]!.name}，我是王经理，想交流岗位。`);
  assert.equal((await contacts.previewMessage(scored[0]!.stateId, savedB.activeVersionId)).renderedMessage, "你好，想邀请你了解我们的海外内容运营岗位。");
  const edited = await ats.savePositionMessageTemplate(principal, position.id, "你好，邀请进一步交流。", "初次联系") as { activeVersionId: string; version: number };
  assert.equal(edited.version, 2);
  await assert.rejects(contacts.previewMessage(scored[0]!.stateId, savedA.activeVersionId), /not found/);
  await assert.rejects(ats.createRuleDraft({ ...principal, role: 'recruiting_lead' }, { positionId: position.id, name: 'budget bypass', config: { ...config, recruitment: { ...briefFixture, salaryCeilingYuan: 15000 } }, dictionaryVersion: 'test' }), /只有管理员/);
  // Use existing contact policy in this disposable database; no BOSS transport.
  for (const [scopeType, scopeId] of [['global', 'global'], ['department', principal.departmentId], ['position', position.id], ['task', task.id]] as const) await ats.setContactControl(principal, { scopeType, scopeId, enabled: true, approvalRequired: false, policy: { testOnly: true }, emergencyStop: false });
  const created = [];
  for (const candidate of scored) {
    const preview = await contacts.previewMessage(candidate.stateId, savedB.activeVersionId);
    created.push(await contacts.createManualContactIntent({ stateId: candidate.stateId, actionKind: 'message', templateVersionId: preview.templateVersionId, providerJobId: null, providerGreetingId: null, renderedMessage: preview.renderedMessage, idempotencyKey: `contact-${suffix}-${candidate.stateId}`, createdBy: principal.userId, localMinuteOfDay: 720, now: new Date().toISOString(), intervalSeconds: 90 }));
  }
  const first = await contacts.claimContactDispatch('test-contact', 'fake', position.bossAccountId);
  assert(first);
  assert.equal(first.bossJobId, claimed!.bossJobId, 'contacts restore the frozen collection job ID');
  assert.equal(first.bossJobKeyword, claimed!.bossJobKeyword);
  assert.deepEqual(first.sourceBossFilters, claimed!.sourceBossFilters, 'contacts restore the original official filter snapshot');
  assert.equal(await contacts.claimContactDispatch('second-worker', 'fake', position.bossAccountId), null, 'same account must dispatch serially');
  await contacts.finishContactDispatch({ job: first, result: 'simulated', externalMessage: 'isolated test only' });
  assert.equal(await contacts.claimContactDispatch('test-contact', 'fake', position.bossAccountId), null, 'next contact must wait 90 seconds after completion');
  const remaining = created.find(item => item.id !== first.id)!;
  await contacts.cancelReadyContact(remaining.id, principal.userId);
  assert.equal((await contacts.listContactIntents({ positionIds: [position.id] })).find(item => item.id === remaining.id)?.status, 'cancelled');
  await sql`UPDATE recruitment_assessments SET status = 'failed', result = NULL, error = 'fixture model failure' WHERE candidate_position_state_id = ${scored[0]!.stateId}`;
  await ai.retry(scored[0]!.stateId, principal.userId);
  assert.equal(await ai.processOne(env, input => score({ ...input, model: 'fixture' })), true);
  assert.equal((await repository.getCandidateDetail(scored[0]!.stateId))?.assessment?.status, 'completed');
  // A newer screening task can replace the record while the provider is busy.
  // The late response must never revive that historical record's analysis.
  await sql`UPDATE recruitment_assessments SET status = 'failed', result = NULL WHERE candidate_position_state_id = ${scored[0]!.stateId}`;
  await ai.retry(scored[0]!.stateId, principal.userId);
  await ai.processOne(env, async input => {
    await sql`UPDATE candidate_position_states SET is_current = false WHERE id = ${scored[0]!.stateId}`;
    return score({ ...input, model: 'fixture' });
  });
  await ai.processOne(env, input => score({ ...input, model: 'fixture' }));
  const cancelled = (await sql`SELECT status, result FROM recruitment_assessments WHERE candidate_position_state_id = ${scored[0]!.stateId}`)[0]!;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.result, null);
  // Restore this isolated fixture for the interactive UI acceptance script.
  await sql`UPDATE candidate_position_states SET is_current = true WHERE id = ${scored[0]!.stateId}`;
  await sql`UPDATE recruitment_assessments SET status = 'failed' WHERE candidate_position_state_id = ${scored[0]!.stateId}`;
  await ai.retry(scored[0]!.stateId, principal.userId);
  await ai.processOne(env, input => score({ ...input, model: 'fixture' }));
  console.log(JSON.stringify({ ok: true, positionId: position.id, taskId: task.id, salaryFilteredWithoutView: true, frozenBrief: rule.id, aiQueueConcurrency: true, lowScoreReviewPreserved: true, multipleTemplatesAndVersioning: true, salaryAdminOnly: true, serialContactPacing: true, cancelPending: true, aiRetryWithoutBoss: true }));
} finally { await sql.end(); }
