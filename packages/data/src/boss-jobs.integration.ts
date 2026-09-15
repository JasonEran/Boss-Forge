import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertIsolatedTestDatabase, createDatabase, BossForgeRepository, DepartmentAtsRepository, M2Repository, type SessionPrincipal } from "./index.js";

assertIsolatedTestDatabase(process.env, { contactSideEffects: false });
const sql = createDatabase();
try {
  const ats = new DepartmentAtsRepository(sql);
  const repository = new BossForgeRepository(sql);
  const m2 = new M2Repository(sql);
  await ats.ensureBootstrap({ departmentName: "Jobs test", adminEmail: "jobs-test@example.invalid", adminName: "Jobs Admin", password: "JobsIntegration!123" });
  const admin = (await sql<SessionPrincipal[]>`SELECT id AS "userId", department_id AS "departmentId", email, display_name AS "displayName", role FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1`)[0]!;
  const account = `integration-account-jobs-${randomUUID()}`;
  const legacy = await ats.createAssignedPosition(admin, { bossAccountId: account, name: "海外运营" });
  const rule = await repository.createRuleVersion({ positionId: legacy.id, name: "英语要求", config: { requiredCapabilities: [{ capability: "tem8", minimumConfidence: 0.8 }] }, dictionaryVersion: "test.1", createdBy: admin.userId });
  const historicalTask = await repository.createImmediateTask({ idempotencyKey: randomUUID(), positionId: legacy.id, source: "recommend", createdBy: admin.userId });
  const catalog = { complete: true, jobs: [
    { id: "boss-a", name: "海外运营", status: "开放中" },
    { id: "boss-b", name: "产品经理", status: "开放中" },
    { id: "boss-c", name: "同名岗位", status: "开放中" },
    { id: "boss-d", name: "同名岗位", status: "已关闭" },
    { id: "boss-e", name: "审核中岗位", status: "待开放" },
  ] };
  const synced = await ats.syncBossPositions(admin, account, catalog);
  assert.deepEqual(synced, { count: 3, created: 2, linked: 1 });
  const scoped = () => repository.listPositions().then((all) => all.filter((p) => p.bossAccountId === account));
  let positions = await scoped();
  assert.equal(positions.find((p) => p.bossJobId === "boss-a")?.id, legacy.id, "Unique legacy match retains position ID");
  assert.equal(positions.filter((p) => p.name === "同名岗位").length, 1);
  assert.equal(positions.find((p) => p.bossJobId === "boss-c")?.bossJobNameUnique, false);
  assert(!positions.some((p) => p.bossJobId === "boss-d" || p.bossJobId === "boss-e"), "Unopened and closed jobs are not imported");
  assert.equal((await sql`SELECT active_version_id FROM rule_sets WHERE position_id = ${legacy.id}`)[0]!.active_version_id, rule.id);
  assert.equal((await sql`SELECT source_job_id FROM tasks WHERE id = ${historicalTask.id}`)[0]!.source_job_id, null, "Sync does not rewrite historical source");
  assert.equal((await ats.syncBossPositions(admin, account, catalog)).created, 0, "Repeated sync is idempotent");
  await ats.syncBossPositions(admin, account, { ...catalog, jobs: catalog.jobs.map((j) => j.id === "boss-c" ? { ...j, status: "已关闭" } : j) });
  assert.equal((await scoped()).find((p) => p.bossJobId === "boss-c")?.status, "closed", "Existing closed job is retained");
  await ats.syncBossPositions(admin, account, { ...catalog, jobs: catalog.jobs.map((j) => j.id === "boss-d" ? { ...j, status: "开放中" } : j) });
  assert.equal((await scoped()).find((p) => p.bossJobId === "boss-d")?.status, "active", "A newly opened job is imported");
  const beforeFailedSync = await scoped();
  await assert.rejects(ats.syncBossPositions(admin, account, { jobs: [catalog.jobs[0]!], complete: false }), /完整读取/);
  assert.deepEqual(await scoped(), beforeFailedSync, "Partial catalog does not mutate positions");
  const task = await repository.createImmediateTask({ idempotencyKey: randomUUID(), positionId: legacy.id, source: "recommend", createdBy: admin.userId });
  assert.equal(task.bossJobId, "boss-a"); assert.equal(task.bossJobNameUnique, true);
  assert.equal(task.ruleVersionId, rule.id);
  await ats.syncBossPositions(admin, account, { ...catalog, jobs: catalog.jobs.map((j) => j.id === "boss-a" ? { ...j, name: "海外运营新版" } : j) });
  const frozen = (await sql`SELECT source_job_id, source_job_name FROM tasks WHERE id = ${task.id}`)[0]!;
  assert.equal(frozen.source_job_id, "boss-a"); assert.equal(frozen.source_job_name, "海外运营");
  await ats.updatePosition(admin, legacy.id, { name: "不能更改来源", bossJobKeyword: "错误关键词", ownerName: "新负责人" });
  assert.equal((await scoped()).find((p) => p.id === legacy.id)?.name, "海外运营新版");

  const oldDifferentName = await ats.createAssignedPosition(admin, { bossAccountId: account, name: "内部产品岗" });
  const imported = positions.find((p) => p.bossJobId === "boss-b")!;
  const email = `jobs-hr-${randomUUID()}@example.invalid`;
  await ats.createUser(admin, { email, displayName: "新 HR", role: "recruiter", password: "JobsIntegration!123" });
  const hr = (await sql<SessionPrincipal[]>`SELECT id AS "userId", department_id AS "departmentId", email, display_name AS "displayName", role FROM users WHERE email = ${email}`)[0]!;
  assert.equal((await ats.positionIds(hr)).length, 0);
  await ats.assignPosition(admin, imported.id, hr.userId, "recruiter");
  await ats.bindLegacyBossPosition(admin, oldDifferentName.id, imported.id);
  assert.equal((await ats.positionIds(hr))[0], oldDifferentName.id, "Binding preserves the new HR membership");
  positions = await scoped();
  assert(!positions.some((p) => p.id === imported.id));
  assert.equal(positions.find((p) => p.id === oldDifferentName.id)?.bossJobId, "boss-b");
  await assert.rejects(ats.syncBossPositions(hr, account, catalog), /Manager/);
  await assert.rejects(ats.assertPosition(hr, legacy.id));
  await repository.createRuleVersion({ positionId: oldDifferentName.id, name: "产品技能", config: { requiredCapabilities: [{ capability: "tem8", minimumConfidence: 0.9 }] }, dictionaryVersion: "test.2", createdBy: admin.userId });
  const hrTask = await repository.createImmediateTask({ idempotencyKey: randomUUID(), positionId: oldDifferentName.id, source: "recommend", createdBy: hr.userId });
  assert.equal(hrTask.bossJobId, "boss-b"); assert.notEqual(hrTask.ruleVersionId, task.ruleVersionId);

  const schedule = await m2.createSchedule({ idempotencyKey: randomUUID(), positionId: oldDifferentName.id, source: "recommend", frequency: "once", timezone: "Asia/Shanghai", nextRunAt: new Date(Date.now() - 1000).toISOString(), createdBy: hr.userId });
  assert.equal(await m2.materializeDueSchedules(), 1);
  const scheduled = (await sql`SELECT source_job_id FROM tasks WHERE schedule_id = ${schedule.id}`)[0]!;
  assert.equal(scheduled.source_job_id, "boss-b");
  await ats.syncBossPositions(admin, account, { complete: true, jobs: catalog.jobs.filter((j) => j.id !== "boss-b") });
  assert.equal((await scoped()).find((p) => p.id === oldDifferentName.id)?.status, "paused");
  await assert.rejects(repository.createImmediateTask({ idempotencyKey: randomUUID(), positionId: oldDifferentName.id, source: "recommend", createdBy: hr.userId }));
  assert.equal((await sql`SELECT count(*)::int AS n FROM tasks WHERE position_id = ${oldDifferentName.id}`)[0]!.n, 2, "Missing BOSS job preserves history");
  console.log("BOSS jobs integration passed: sync, repeat, partial failure, duplicate names, legacy binding, history/rules, HR assignment, task/schedule source snapshots, inactive jobs.");
} finally { await sql.end(); }
