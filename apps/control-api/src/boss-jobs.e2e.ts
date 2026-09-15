import assert from "node:assert/strict";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertIsolatedTestDatabase } from "@boss-forge/data";
import { resumeViewPolicyFromEnvironment, type BossJobCatalog } from "@boss-forge/contracts";
import { startBossBrowserControlServer, bossBrowserControlSocketPath, BossBrowserControlError } from "@boss-forge/boss-cli-adapter";

assertIsolatedTestDatabase(process.env, { contactSideEffects: false });
const api = process.env.CONTROL_API_URL!;
const runtime = process.env.BOSS_FORGE_RUNTIME_DIR!;
assert(api && new URL(api).hostname === "127.0.0.1" && runtime?.startsWith("/tmp/"));
await mkdir(runtime, { recursive: true });
const statusFile = join(runtime, "boss-login-status.json");
let token = "";
async function request(path: string, body?: unknown) {
  const response = await fetch(`${api}${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}
const login = await request("/api/auth/login", { email: "admin@boss-forge.internal", password: "ChangeMe-BossForge-Internal!" });
assert.equal(login.status, 200); token = login.data.token;
assert.equal((await request("/api/boss/positions/sync", {})).status, 409, "Logged out sync must show a login instruction");
await writeFile(statusFile, JSON.stringify({ state: "authenticated", message: "Isolated test double", updatedAt: new Date().toISOString(),
  releaseId: "unversioned", contactDispatchMode: "disabled", resumePolicy: resumeViewPolicyFromEnvironment(process.env),
  verification: { browserAuthenticated: true, workerHeartbeatFresh: true } }));
let busy = false;
let catalog: BossJobCatalog = { complete: true, jobs: [
  { id: "e2e-boss-ops", name: "运营专员", status: "开放中" },
  { id: "e2e-boss-design", name: "设计师", status: "开放中" },
] };
const server = await startBossBrowserControlServer({ socketPath: bossBrowserControlSocketPath(runtime), accountId: "boss-account-01",
  positions: async () => { if (busy) throw new BossBrowserControlError("busy", "Busy"); return catalog; },
  greetingPreview: async () => { throw new Error("No contact actions in this test"); },
});
try {
  const sync = await request("/api/boss/positions/sync", {});
  assert.equal(sync.status, 200, JSON.stringify(sync.data)); assert.equal(sync.data.count, 2);
  const ops = sync.data.positions.find((p: { bossJobId?: string }) => p.bossJobId === "e2e-boss-ops");
  const design = sync.data.positions.find((p: { bossJobId?: string }) => p.bossJobId === "e2e-boss-design");
  assert(ops && design);
  const repeat = await request("/api/boss/positions/sync", {}); assert.equal(repeat.data.created, 0);
  busy = true;
  const blocked = await request("/api/boss/positions/sync", {}); assert.equal(blocked.status, 409); assert.match(blocked.data.message, /正在执行筛选/);
  busy = false;
  catalog = { complete: false, jobs: [catalog.jobs[0]!] };
  const partial = await request("/api/boss/positions/sync", {}); assert.notEqual(partial.status, 200);
  assert.equal((await request("/api/positions")).data.positions.find((p: { id: string }) => p.id === design.id).status, "active");
  const email = `new-hr-${randomUUID()}@example.invalid`;
  const hr = await request("/api/team/users", { email, displayName: "新 HR", role: "recruiter", password: "HrIntegration!123" });
  assert.equal(hr.status, 201);
  for (const p of [ops, design]) {
    assert.equal((await request(`/api/positions/${p.id}/members`, { userId: hr.data.user.id, memberRole: "recruiter" })).status, 200);
    assert.equal((await request(`/api/positions/${p.id}/rules`, { name: `${p.name}要求`, config: { requiredCapabilities: [{ capability: "tem8", minimumConfidence: p.id === ops.id ? 0.8 : 0.9 }] }, dictionaryVersion: "e2e.1", lifecycleStatus: "published" })).status, 201);
  }
  const hrLogin = await request("/api/auth/login", { email, password: "HrIntegration!123" }); token = hrLogin.data.token;
  const dashboard = await request("/api/dashboard"); assert.equal(dashboard.data.positions.length, 2);
  assert.equal((await request("/api/boss/positions/sync", {})).status, 403);
  const first = await request("/api/tasks", { positionId: ops.id, source: "recommend" });
  const second = await request("/api/tasks", { positionId: design.id, source: "recommend" });
  assert.equal(first.status, 201); assert.equal(second.status, 201);
  assert.equal(first.data.task.bossJobId, "e2e-boss-ops"); assert.equal(second.data.task.bossJobId, "e2e-boss-design");
  assert.notEqual(first.data.task.ruleVersionId, second.data.task.ruleVersionId);
  console.log("BOSS jobs API E2E passed with a browser-control test double: login guidance, sync/repeat/busy/partial, new HR, assignment, independent rules and two bound task sources. No BOSS browser or contact action executed.");
} finally { await server.close(); await unlink(statusFile); }
