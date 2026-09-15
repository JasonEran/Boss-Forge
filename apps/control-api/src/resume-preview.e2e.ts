import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertIsolatedTestDatabase, createDatabase, BossForgeRepository, DepartmentAtsRepository, M2Repository, parseRuleConfig, type SessionPrincipal } from '@boss-forge/data';
import { evaluateCandidate } from '@boss-forge/m1-core';
import { planBossRecommendationFilters } from '@boss-forge/contracts';

assertIsolatedTestDatabase(process.env, { contactSideEffects: false });
const api = process.env.CONTROL_API_URL!;
assert(new URL(api).hostname === '127.0.0.1');
const dir = process.env.BOSS_CAPTURE_TEST_OUTPUT!;
const path = join(dir, 'fixture.png');
const manifest = JSON.parse(await readFile(path + '.manifest.json', 'utf8'));
const sql = createDatabase();
let token = '';
async function request(route: string, body?: unknown) {
  return fetch(api + route, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
try {
  const repo = new BossForgeRepository(sql), ats = new DepartmentAtsRepository(sql), m2 = new M2Repository(sql);
  const admin = (await sql<SessionPrincipal[]>`SELECT id AS "userId", department_id AS "departmentId", email, display_name AS "displayName", role FROM users WHERE role = 'admin' LIMIT 1`)[0]!;
  assert(admin);
  const position = await ats.createAssignedPosition(admin, { bossAccountId: 'integration-resume-test', name: '简历预览验证岗位', ownerName: '测试 HR' });
  await sql`UPDATE positions SET boss_job_id = 'resume-test-job', boss_job_keyword = '简历预览验证岗位', boss_job_status = '开放中' WHERE id = ${position.id}`;
  const config = parseRuleConfig({ schemaVersion: '1.1', screeningFlow: 'boss_then_resume', bossRecommendationFilters: { mode: 'custom', fields: { degree: ['本科'], experience: ['3-5年'] } }, root: { operator: 'AND', children: [{ type: 'english_credential', accepted: ['tem8'], mode: 'any', minimumConfidence: 0.85, unknownPolicy: 'manual_review' }] } });
  await repo.createRuleVersion({ positionId: position.id, name: 'BOSS 筛选 + 证书核验', config, dictionaryVersion: 'test', createdBy: admin.userId });
  await assert.rejects(repo.createImmediateTask({ idempotencyKey: randomUUID(), positionId: position.id, source: 'search', searchKeyword: '运营', createdBy: admin.userId }), /推荐牛人/);
  await assert.rejects(m2.createSchedule({ idempotencyKey: randomUUID(), positionId: position.id, source: 'search', searchKeyword: '运营', frequency: 'once', timezone: 'Asia/Shanghai', nextRunAt: new Date(Date.now()+60000).toISOString(), createdBy: admin.userId }), /推荐牛人/);
  await repo.createImmediateTask({ idempotencyKey: randomUUID(), positionId: position.id, source: 'recommend', createdBy: admin.userId });
  const task = await repo.claimNextTask('resume-test-worker', position.bossAccountId); assert(task);
  const plan = planBossRecommendationFilters(config);
  const candidate = { index: 1, source: 'recommend' as const, name: '长简历测试样本', fields: {}, evidence: [], raw: '测试样本：未重复提供 BOSS 已筛的学历与经验' };
  await repo.completeTask(task, [evaluateCandidate(candidate, config, '', [], plan)], position.name, plan);
  const job = await repo.claimNextResumeScreening('resume-test-worker', position.bossAccountId); assert(job);
  await repo.saveResumeScreenshot({ stateId: job.stateId, taskId: job.taskId, workerId: 'resume-test-worker', screenshotPath: path });
  // The capture is available before OCR / the final decision is persisted.
  assert.equal((await repo.getCandidateDetail(job.stateId))!.resumeScreenshotAvailable, true);
  const text = '教育经历、工作经历、海外运营项目经历；已通过英语专业八级';
  const result = evaluateCandidate(job.candidate, config, text, [], job.sourceBossFilters);
  assert.equal(result.decision, 'matched');
  await repo.completeResumeScreening({ job, record: result, screenshotPath: path, resumeTextHash: createHash('sha256').update(text).digest('hex'), workerId: 'resume-test-worker' });
  const route = `/api/candidate-position-states/${job.stateId}/resume-preview`;
  assert.equal((await request(route)).status, 401);
  const login = await request('/api/auth/login', { email: 'admin@boss-forge.internal', password: 'ChangeMe-BossForge-Internal!' }); assert.equal(login.status, 200); token = (await login.json()).token;
  const metadata = await request(route); assert.equal(metadata.status, 200); const data = await metadata.json();
  assert.equal(data.complete, true); assert.equal(data.parts.length, manifest.parts.length); assert(!JSON.stringify(data).includes(path));
  for (const part of data.parts) { const image = await request(route + '/' + part.index); assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png'); assert(Buffer.from(await image.arrayBuffer()).equals(await readFile(join(dir,manifest.parts[part.index].file)))); }
  assert.equal((await request(route + '/999')).status, 404);
  assert.equal((await request(route + '/0?capture=old-capture')).status, 409);
  assert.equal((await request(route + '/0?capture=' + data.captureId)).status, 200);
  await writeFile('/tmp/boss-resume-ui-fixture.json', JSON.stringify({ stateId: job.stateId, positionId: position.id, token, api }), { mode: 0o600 });
  const email = `unassigned-${randomUUID()}@example.invalid`;
  await ats.createUser(admin, { email, displayName: '未分配测试 HR', role: 'recruiter', password: 'ResumeTest!123' });
  token = (await (await request('/api/auth/login', { email, password: 'ResumeTest!123' })).json()).token;
  assert.equal((await request(route)).status, 403); assert.equal((await request(route + '/0')).status, 403);
  console.log(JSON.stringify({ ok: true, parts: data.parts.length, officialAndSupplementaryMatched: true, duplicateSearchRejected: true, screenshotSavedBeforeOcr: true, authenticatedImagesVerified: true, otherHrDenied: true }));
} finally { await sql.end(); }
