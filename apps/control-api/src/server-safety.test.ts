import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const server = readFileSync(
  resolve(process.cwd(), "apps/control-api/src/server.ts"),
  "utf8"
);

describe("control API contact and mutation safety", () => {
  it("distinguishes unauthenticated requests from authenticated permission denials", () => {
    expect(server).toContain('throw new AuthenticationError("Authentication required.")');
    expect(server).toContain("error instanceof AuthenticationError");
    expect(server).toContain("error instanceof AuthorizationError");
    expect(server).toContain('? "forbidden"');
  });

  it("authorizes position creation before the first write", () => {
    const route = server.indexOf(
      'request.method === "POST" && url.pathname === "/api/positions"'
    );
    const guard = server.indexOf("assertManager(currentUser)", route);
    const write = server.indexOf("atsRepository.createAssignedPosition", route);
    expect(route).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(route);
    expect(write).toBeGreaterThan(guard);
  });

  it.each([
    'url.pathname === "/api/tasks"',
    'url.pathname === "/api/schedules"',
    "cancelScheduleMatch",
    "taskCommandMatch",
    "resumeScreeningMatch",
    "contactMatch",
    "const reviewMatch ="
  ])("guards recruiting mutation %s", (marker) => {
    const route = server.indexOf(marker);
    const guard = server.indexOf("assertRecruitingOperator(currentUser)", route);
    expect(route).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(route);
    expect(guard).toBeLessThan(route + 2_500);
  });

  it("requires a fresh explicit confirmation before a real contact intent", () => {
    expect(server).toContain("realContact && body.confirmRealContact !== true");
    expect(server).toContain("confirmRealContact must be true");
    expect(server).toContain("verifyContactPreviewApproval");
    expect(server).toContain('text(body.contactPreviewApprovalToken, "contactPreviewApprovalToken")');
    expect(server).toContain(
      "contactPreviewApprovalIdempotencyKey(actionKind, verifiedRealApproval.approvalId)"
    );
    expect(server).toContain(
      "contactPreviewApprovalSigningKeyFromEnvironment(process.env)"
    );
    expect(server).toContain("bossAccountId: preview.bossAccountId");
    expect(server).toContain("source: preview.source");
    expect(server).toContain("sourceLocator: requiredContactSourceLocator");
    expect(server).toContain("approvalId: issuedApproval.approval.approvalId");
    expect(server).toContain("readiness: {");
    expect(server).toContain("previewContactReadiness");
    expect(server).not.toContain("randomBytes(32)");
    expect(server).toContain("ContactPreviewApprovalConfigurationError");
    expect(server).toContain('"configuration_unavailable"');
  });

  it("keeps greeting and message as separately bound actions without implicit chaining", () => {
    expect(server).toContain("type ContactActionKind");
    expect(server).toContain('/(message|greet)-preview$');
    expect(server).toContain('const actionKind = contactActionKind(body.actionKind)');
    expect(server).toContain('actionKind: issuedApproval.approval.actionKind');
    expect(server).toContain('error: "greet_exact_content_unavailable"');
    expect(server).toContain("未签发许可，也未创建任务");
    expect(server).toContain("readExactBossGreeting");
    expect(server).toContain("requestBossGreetingPreviewViaIpc");
    expect(server).toContain("bossBrowserControlSocketPath(bossLoginRuntimeDirectory)");
    expect(server).not.toContain("runBossCommand(");
    expect(server).not.toContain("withBossAccountLock(");
    expect(server).toContain("providerJobId: greeting.jobId");
    expect(server).toContain("providerGreetingId: greeting.greetingId");
    expect(server).toContain("renderedMessage: greeting.body");
    expect(server).not.toContain("await adapter.greet");
  });

  it("requires exact versioned attestation before resolving an uncertain write", () => {
    const route = server.indexOf("const verifyContactNotSentMatch");
    const body = server.slice(route, route + 3_500);
    expect(body).toContain('integer(body.expectedVersion, "expectedVersion")');
    expect(body).toContain("actionKind: contactActionKind(body.actionKind)");
    expect(body).toContain('candidateStateId: text(body.candidateStateId, "candidateStateId")');
    expect(body).toContain('candidateId: text(body.candidateId, "candidateId")');
    expect(body).toContain('candidateName: text(body.candidateName, "candidateName")');
    expect(body).toContain('taskId: text(body.taskId, "taskId")');
    expect(body).toContain('bossAccountId: text(body.bossAccountId, "bossAccountId")');
    expect(body).toContain("body.templateVersionId");
    expect(body).toContain("body.providerJobId");
    expect(body).toContain("body.providerGreetingId");
    expect(body).toContain("body.renderedMessageSha256");
    expect(body).toContain("body.sourceLocatorSha256");
  });

  it("serializes safety-control mutations with the final external contact fence", () => {
    expect(server).toContain("withContactGlobalFence(() =>\n      atsRepository.setDoNotContact");
    expect(server).toContain("withContactGlobalFence(() => atsRepository.setContactControl");
    expect(server).toContain("withContactGlobalFence(() => atsRepository.decideContactApproval");
    expect(server).toContain("withContactGlobalFence(() => atsRepository.updateAccountHealth");
    expect(server).toContain("withContactGlobalFence(() =>\n      atsRepository.createAssignedPosition");
    expect(server).toContain("withContactGlobalFence(() =>\n      atsRepository.updatePosition");
    expect(server).toContain("withContactGlobalFence(() =>\n      repository.requeueResumeScreening");
    expect(server).toContain("withContactGlobalFence(() =>\n      repository.reviewCandidate");
    expect(server).toContain("withContactGlobalFence(() =>\n      command === \"cancel\"");
    expect(server).toContain("withContactGlobalFence(() =>\n      atsRepository.updateUserStatus");
  });

  it("publishes the compile-time contact capability and rejects unavailable enable flows", () => {
    const repository = readFileSync(
      resolve(process.cwd(), "packages/data/src/department-repository.ts"),
      "utf8"
    );
    expect(server).toContain("realContactTransportAvailable: REAL_CONTACT_TRANSPORT_AVAILABLE");
    expect(server).toContain("contactDispatchModeFromEnvironment(process.env)");
    expect(server).toContain('contactDispatchMode === "disabled"');
    expect(server).toContain("联系发送处理程序未启动；当前只能预览消息");
    expect(repository).toContain("input.enabled && !contactAuthorizationMutationAllowed()");
    expect(repository).toContain('input.decision === "approved" && !contactAuthorizationMutationAllowed()');
    expect(repository).toContain("assertIsolatedTestDatabase(process.env, { contactSideEffects: true })");
    expect(repository).toContain("不能创建开启授权");
  });

  it("does not downgrade a misconfigured real contact request into a fake intent", () => {
    const routeStart = server.indexOf(
      'if (request.method === "POST" && contactMatch)'
    );
    const routeEnd = server.indexOf("const verifyContactNotSentMatch", routeStart);
    const route = server.slice(routeStart, routeEnd);

    expect(route).toContain(
      'contactDispatchMode === "real" && !realGreetingEnabled()'
    );
    expect(route).toContain("真实联系配置不完整");
    expect(route.indexOf("真实联系配置不完整")).toBeLessThan(
      route.indexOf("const body = await readJson(request)")
    );
    expect(route.indexOf("真实联系配置不完整")).toBeLessThan(
      route.indexOf("createManualContactIntent")
    );
    expect(server).toContain('message.includes("真实联系配置不完整")');
    expect(server).toContain('status === 503\n                ? "configuration_unavailable"');
  });

  it("does not accept human-authored authoritative account health", () => {
    expect(server).toContain("authoritative must be false");
    expect(server).toContain("authoritative: false");
  });

  it("keeps unaccepted semantic evaluation in shadow mode", () => {
    const repository = readFileSync(
      resolve(process.cwd(), "packages/data/src/department-repository.ts"),
      "utf8"
    );
    expect(repository).toContain("SEMANTIC_ACTIVE_DECISIONS_AVAILABLE");
    expect(repository).toContain("当前只允许试运行");
  });

  it("publishes only the sanitized semantic provider readiness", () => {
    expect(server).toContain("semanticProviderReadinessFromEnvironment(process.env)");
    expect(server).toContain("providerReadiness:");
  });

  it("keeps semantic evaluation writes manager-only and department-scoped", () => {
    const repository = readFileSync(
      resolve(process.cwd(), "packages/data/src/department-repository.ts"),
      "utf8"
    );
    for (const method of [
      "async createEvaluationSet",
      "async addEvaluationCase",
      "async runSemanticEvaluation"
    ]) {
      const start = repository.indexOf(method);
      const guard = repository.indexOf("if (!canManage(principal.role))", start);
      expect(start).toBeGreaterThan(-1);
      expect(guard).toBeGreaterThan(start);
      expect(guard).toBeLessThan(start + 500);
    }
    const run = repository.indexOf("async runSemanticEvaluation");
    const nextMethod = repository.indexOf("async setSemanticMode", run);
    const body = repository.slice(run, nextMethod);
    expect(body).toContain("semantic_evaluation_sets");
    expect(body).toContain("department_id = ${principal.departmentId}");
  });

  it("keeps manual inbound injection behind the isolated contact-test gate", () => {
    const route = server.indexOf('url.pathname === "/api/operations/messages/sync"');
    const gate = server.indexOf('process.env.BOSS_FORGE_TEST_CONTACTS !== "1"', route);
    const write = server.indexOf("atsRepository.syncInboundMessage", route);
    expect(route).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(route);
    expect(write).toBeGreaterThan(gate);
  });

  it("publishes and enforces API/worker release and resume-policy consistency", () => {
    expect(server).toContain("runtimeMismatchReasons: consistency.reasons");
    expect(server).toContain("apiReleaseId: releaseId");
    expect(server).toContain("apiResumePolicy: resumeViewPolicyFromEnvironment(process.env)");
    expect(server).toContain("contact_dispatch_mode_mismatch");
    expect(server).toContain("await assertWorkerRuntimeConsistent()");
    expect(server).toContain("扫码登录状态无法验证，Worker 已暂停");
  });

  it("uses scoped dashboard queries and preserves database-calculated contact metrics", () => {
    expect(server).toContain(
      "repository.getDashboard({ positionIds: allowedPositionIdList, taskLimit: 100 })"
    );
    expect(server).toContain("repository.listPositions(allowed)");
    expect(server).toContain(
      "m2Repository.listContactIntents({ positionIds: allowedPositionIdList })"
    );
    expect(server).toContain("departmentId: currentUser.departmentId");
    expect(server).toContain("metrics: dashboard.metrics");
    expect(server).not.toContain(
      'contactedToday: candidates.filter((item) => item.contactStatus === "sent").length'
    );
  });

  it("exposes idempotent, versioned cancel and retry task recovery actions", () => {
    const route = server.indexOf("const taskCommandMatch");
    const idempotency = server.indexOf('request.headers["idempotency-key"]', route);
    const version = server.indexOf('integer(body.expectedVersion, "expectedVersion")', route);
    const access = server.indexOf("atsRepository.assertPosition(currentUser", route);
    const cancel = server.indexOf("repository.cancelTask(input)", route);
    const retry = server.indexOf("repository.retryTask(input)", route);
    expect(route).toBeGreaterThan(-1);
    expect(idempotency).toBeGreaterThan(route);
    expect(version).toBeGreaterThan(idempotency);
    expect(access).toBeGreaterThan(idempotency);
    expect(cancel).toBeGreaterThan(version);
    expect(retry).toBeGreaterThan(cancel);
  });

  it("creates and publishes the position rule in one server transaction", () => {
    const repository = readFileSync(
      resolve(process.cwd(), "packages/data/src/department-repository.ts"),
      "utf8"
    );
    const editor = readFileSync(
      resolve(process.cwd(), "apps/web/app/position-rule-dialog.tsx"),
      "utf8"
    );
    expect(server).toContain('lifecycleStatus: lifecycleStatus as "draft" | "pending_approval" | "published"');
    expect(repository).toContain('const lifecycleStatus = input.lifecycleStatus ?? "draft"');
    expect(repository).toContain("UPDATE rule_sets SET active_version_id");
    expect(editor).toContain("lifecycleStatus: canPublish ? 'published' : 'pending_approval'");
    expect(editor).not.toContain("rulePayload.version.id}/lifecycle");
  });
});
