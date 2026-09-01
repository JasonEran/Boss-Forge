import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  AuthorizationError,
  BossForgeRepository,
  DepartmentAtsRepository,
  M2Repository,
  OptimisticLockError,
  createDatabase,
  parseRuleConfig,
  type RuleConfig
} from "@boss-forge/data";
import { evaluateCandidate } from "@boss-forge/m1-core";
import type { ParsedCandidate } from "@boss-forge/contracts";

const host = process.env.CONTROL_API_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.CONTROL_API_PORT ?? "3100");
const webOrigin = process.env.CONTROL_WEB_ORIGIN?.trim() || "http://localhost:3000";
const sql = createDatabase();
const repository = new BossForgeRepository(sql);
const m2Repository = new M2Repository(sql);
const atsRepository = new DepartmentAtsRepository(sql);

type JsonObject = Record<string, unknown>;

function send(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": webOrigin,
    vary: "origin"
  });
  response.end(JSON.stringify(payload));
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  return value.trim() || null;
}

function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean.`);
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${field} must be an array of strings.`);
  }
  return value;
}

function shanghaiMinuteOfDay(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

function ruleConfig(value: unknown): RuleConfig {
  return parseRuleConfig(value);
}

async function readJson(
  request: IncomingMessage,
  maxBytes = 64 * 1024
): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) throw new Error(`Request body exceeds ${maxBytes} bytes.`);
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("JSON body must be an object.");
  }
  return value as JsonObject;
}

function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

async function principal(request: IncomingMessage) {
  const token = bearerToken(request);
  if (!token) throw new AuthorizationError("Authentication required.");
  return atsRepository.authenticate(token);
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": webOrigin,
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers":
        "content-type,idempotency-key,authorization,x-correlation-id",
      vary: "origin"
    });
    response.end();
    return;
  }
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  if (request.method === "GET" && url.pathname === "/health") {
    await sql`SELECT 1`;
    send(response, 200, { ok: true, service: "boss-forge-control-api" });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJson(request);
    send(response, 200, await atsRepository.login(text(body.email, "email"), text(body.password, "password")));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/auth/me") {
    send(response, 200, { user: await principal(request) });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    const token = bearerToken(request);
    if (token) await atsRepository.logout(token);
    send(response, 200, { ok: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/team/users") {
    const user = await principal(request);
    send(response, 200, { users: await atsRepository.listUsers(user) });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/team/users") {
    const user = await principal(request);
    const body = await readJson(request);
    const role = text(body.role, "role");
    if (!["admin", "recruiting_lead", "recruiter", "interviewer"].includes(role)) {
      throw new Error("role must be a supported department role.");
    }
    const created = await atsRepository.createUser(user, {
      email: text(body.email, "email"),
      displayName: text(body.displayName, "displayName"),
      role: role as "admin" | "recruiting_lead" | "recruiter" | "interviewer",
      password: text(body.password, "password")
    });
    send(response, 201, { user: created });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/pipeline") {
    const user = await principal(request);
    send(response, 200, await atsRepository.listPipeline(user, {
      ...(url.searchParams.get("positionId") ? { positionId: url.searchParams.get("positionId")! } : {}),
      ...(url.searchParams.get("stage") ? { stage: url.searchParams.get("stage")! } : {}),
      ...(url.searchParams.get("query") ? { query: url.searchParams.get("query")! } : {}),
      sort: url.searchParams.get("sort") === "name" ? "name" : "updated",
      direction: url.searchParams.get("direction") === "asc" ? "asc" : "desc",
      limit: Number(url.searchParams.get("limit") ?? "50"),
      offset: Number(url.searchParams.get("offset") ?? "0")
    }));
    return;
  }
  const stageMatch = url.pathname.match(/^\/api\/pipeline\/([0-9a-f-]+)\/stage$/i);
  if (request.method === "POST" && stageMatch) {
    const user = await principal(request);
    const body = await readJson(request);
    await atsRepository.moveStage(user, stageMatch[1]!, text(body.stage, "stage"), optionalText(body.rejectionReason, "rejectionReason"));
    send(response, 200, { ok: true });
    return;
  }
  const noteMatch = url.pathname.match(/^\/api\/pipeline\/([0-9a-f-]+)\/notes$/i);
  if (request.method === "POST" && noteMatch) {
    const user = await principal(request);
    const body = await readJson(request);
    const mentioned = Array.isArray(body.mentionedUserIds)
      ? body.mentionedUserIds.filter((item): item is string => typeof item === "string")
      : [];
    send(response, 201, { note: await atsRepository.addNote(user, noteMatch[1]!, text(body.body, "body"), mentioned) });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/talent/do-not-contact") {
    const user = await principal(request);
    const body = await readJson(request);
    if (typeof body.active !== "boolean") throw new Error("active must be a boolean.");
    await atsRepository.setDoNotContact(user, text(body.candidateId, "candidateId"), body.active, text(body.reason, "reason"));
    send(response, 200, { ok: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/analytics") {
    send(response, 200, await atsRepository.analytics(await principal(request)));
    return;
  }
  const currentUser = await principal(request);
  if (request.method === "GET" && url.pathname === "/api/department/workspace") {
    send(response, 200, await atsRepository.departmentWorkspace(currentUser));
    return;
  }
  const userStatusMatch = url.pathname.match(/^\/api\/team\/users\/([0-9a-f-]+)\/status$/i);
  if (request.method === "POST" && userStatusMatch) {
    const body = await readJson(request);
    const status = text(body.status, "status");
    if (status !== "active" && status !== "disabled") throw new Error("status must be active or disabled.");
    await atsRepository.updateUserStatus(currentUser, userStatusMatch[1]!, status);
    send(response, 200, { ok: true }); return;
  }
  if (request.method === "POST" && url.pathname === "/api/pipeline/stages") {
    const body = await readJson(request);
    await atsRepository.upsertStage(currentUser, {
      key: text(body.key, "key"), label: text(body.label, "label"),
      order: integer(body.order, "order"), terminal: boolean(body.terminal, "terminal")
    });
    send(response, 200, { ok: true }); return;
  }
  if (request.method === "GET" && url.pathname === "/api/collaboration") {
    send(response, 200, await atsRepository.collaborationWorkspace(currentUser, url.searchParams.get("stateId") ?? undefined));
    return;
  }
  const attachmentMatch = url.pathname.match(/^\/api\/collaboration\/states\/([0-9a-f-]+)\/attachments$/i);
  if (request.method === "POST" && attachmentMatch) {
    const body = await readJson(request);
    send(response, 201, { attachment: await atsRepository.addAttachment(currentUser, attachmentMatch[1]!, {
      fileName: text(body.fileName, "fileName"), mimeType: text(body.mimeType, "mimeType"),
      storagePath: text(body.storagePath, "storagePath"), sizeBytes: nonNegativeInteger(body.sizeBytes, "sizeBytes")
    }) }); return;
  }
  if (request.method === "POST" && url.pathname === "/api/collaboration/work-items") {
    const body = await readJson(request);
    send(response, 201, { workItem: await atsRepository.createWorkItem(currentUser, {
      positionId: optionalText(body.positionId, "positionId"), stateId: optionalText(body.stateId, "stateId"),
      assignedTo: text(body.assignedTo, "assignedTo"), title: text(body.title, "title"),
      description: optionalText(body.description, "description") ?? "", dueAt: optionalText(body.dueAt, "dueAt")
    }) }); return;
  }
  const workDoneMatch = url.pathname.match(/^\/api\/collaboration\/work-items\/([0-9a-f-]+)\/complete$/i);
  if (request.method === "POST" && workDoneMatch) {
    await atsRepository.completeWorkItem(currentUser, workDoneMatch[1]!); send(response, 200, { ok: true }); return;
  }
  if (request.method === "POST" && url.pathname === "/api/collaboration/interviews") {
    const body = await readJson(request);
    send(response, 201, { interview: await atsRepository.scheduleInterview(currentUser, {
      stateId: text(body.stateId, "stateId"), startsAt: text(body.startsAt, "startsAt"), endsAt: text(body.endsAt, "endsAt"),
      location: optionalText(body.location, "location"), meetingUrl: optionalText(body.meetingUrl, "meetingUrl"),
      participantIds: stringArray(body.participantIds ?? [], "participantIds")
    }) }); return;
  }
  const feedbackMatch = url.pathname.match(/^\/api\/collaboration\/interviews\/([0-9a-f-]+)\/feedback$/i);
  if (request.method === "POST" && feedbackMatch) {
    const body = await readJson(request); const recommendation = text(body.recommendation, "recommendation");
    if (!["strong_yes", "yes", "mixed", "no", "strong_no"].includes(recommendation)) throw new Error("recommendation must be supported.");
    const score = integer(body.score, "score"); if (score > 5) throw new Error("score must be between 1 and 5.");
    await atsRepository.submitInterviewFeedback(currentUser, { interviewId: feedbackMatch[1]!, recommendation, score,
      strengths: optionalText(body.strengths, "strengths") ?? "", concerns: optionalText(body.concerns, "concerns") ?? "" });
    send(response, 200, { ok: true }); return;
  }
  if (request.method === "GET" && url.pathname === "/api/rules/workspace") {
    send(response, 200, await atsRepository.ruleWorkspace(currentUser)); return;
  }
  if (request.method === "POST" && url.pathname === "/api/rules/drafts") {
    const body = await readJson(request); const config = ruleConfig(body.config);
    send(response, 201, { version: await atsRepository.createRuleDraft(currentUser, {
      positionId: text(body.positionId, "positionId"), name: text(body.name, "name"), config,
      dictionaryVersion: text(body.dictionaryVersion, "dictionaryVersion"), parentVersionId: optionalText(body.parentVersionId, "parentVersionId")
    }) }); return;
  }
  const lifecycleMatch = url.pathname.match(/^\/api\/rules\/versions\/([0-9a-f-]+)\/lifecycle$/i);
  if (request.method === "POST" && lifecycleMatch) {
    const body = await readJson(request); const status = text(body.status, "status");
    if (!["draft", "pending_approval", "published", "retired"].includes(status)) throw new Error("status must be a rule lifecycle status.");
    await atsRepository.setRuleLifecycle(currentUser, lifecycleMatch[1]!, status as "draft" | "pending_approval" | "published" | "retired");
    send(response, 200, { ok: true }); return;
  }
  if (request.method === "POST" && url.pathname === "/api/rules/templates") {
    const body = await readJson(request); const config = ruleConfig(body.config);
    send(response, 201, { template: await atsRepository.createRuleTemplate(currentUser, {
      name: text(body.name, "name"), description: optionalText(body.description, "description") ?? "", config
    }) }); return;
  }
  if (request.method === "POST" && url.pathname === "/api/rules/replays") {
    const body = await readJson(request); const positionId = text(body.positionId, "positionId");
    const baselineVersionId = text(body.baselineVersionId, "baselineVersionId");
    const candidateVersionId = text(body.candidateVersionId, "candidateVersionId");
    const prepared = await atsRepository.ruleReplayInput(currentUser, positionId, baselineVersionId, candidateVersionId) as {
      versions: Array<{ id: string; config: RuleConfig }>; samples: Array<{ stateId: string; name: string; source: "recommend" | "search"; fields: Record<string, string>; evidence: string[]; raw: string }>
    };
    const baseline = prepared.versions.find((item) => item.id === baselineVersionId)!;
    const candidate = prepared.versions.find((item) => item.id === candidateVersionId)!;
    const changes: Array<{ stateId: string; from: string; to: string }> = [];
    prepared.samples.forEach((sample, index) => {
      const parsed: ParsedCandidate = { index, name: sample.name, source: sample.source, fields: sample.fields, evidence: sample.evidence, raw: sample.raw };
      const from = evaluateCandidate(parsed, baseline.config).decision;
      const to = evaluateCandidate(parsed, candidate.config).decision;
      if (from !== to) changes.push({ stateId: sample.stateId, from, to });
    });
    send(response, 201, { replay: await atsRepository.saveRuleReplay(currentUser, {
      positionId, baselineVersionId, candidateVersionId, sampleSize: prepared.samples.length,
      changedCount: changes.length, summary: { changes: changes.slice(0, 100), stableCount: prepared.samples.length - changes.length }
    }) }); return;
  }
  if (request.method === "GET" && url.pathname === "/api/semantic/workspace") {
    send(response, 200, await atsRepository.semanticWorkspace(currentUser)); return;
  }
  if (request.method === "POST" && url.pathname === "/api/semantic/catalogs") {
    const body = await readJson(request);
    send(response, 201, { catalog: await atsRepository.createSemanticCatalog(currentUser, {
      name: text(body.name, "name"), promptTemplate: text(body.promptTemplate, "promptTemplate"),
      modelName: optionalText(body.modelName, "modelName"), entries: body.entries ?? []
    }) }); return;
  }
  const publishSemanticMatch = url.pathname.match(/^\/api\/semantic\/versions\/([0-9a-f-]+)\/publish$/i);
  if (request.method === "POST" && publishSemanticMatch) {
    await atsRepository.publishSemanticVersion(currentUser, publishSemanticMatch[1]!); send(response, 200, { ok: true }); return;
  }
  if (request.method === "POST" && url.pathname === "/api/semantic/evaluation-sets") {
    const body = await readJson(request); send(response, 201, { set: await atsRepository.createEvaluationSet(currentUser, {
      name: text(body.name, "name"), description: optionalText(body.description, "description") ?? ""
    }) }); return;
  }
  if (request.method === "POST" && url.pathname === "/api/semantic/evaluation-cases") {
    const body = await readJson(request); const expectedResult = text(body.expectedResult, "expectedResult");
    if (!["matched", "not_matched", "unknown"].includes(expectedResult)) throw new Error("expectedResult must be supported.");
    send(response, 201, { evaluationCase: await atsRepository.addEvaluationCase(currentUser, {
      setId: text(body.setId, "setId"), criterionId: text(body.criterionId, "criterionId"),
      sourceText: text(body.sourceText, "sourceText"), expectedResult, expectedValue: body.expectedValue
    }) }); return;
  }
  if (request.method === "POST" && url.pathname === "/api/semantic/evaluation-runs") {
    const body = await readJson(request); send(response, 201, { run: await atsRepository.runSemanticEvaluation(currentUser, {
      setId: text(body.setId, "setId"), catalogVersionId: text(body.catalogVersionId, "catalogVersionId")
    }) }); return;
  }
  if (request.method === "POST" && url.pathname === "/api/semantic/mode") {
    const body = await readJson(request); const mode = text(body.mode, "mode");
    if (!["off", "shadow", "active"].includes(mode)) throw new Error("mode must be off, shadow or active.");
    await atsRepository.setSemanticMode(currentUser, { positionId: text(body.positionId, "positionId"),
      mode: mode as "off" | "shadow" | "active", catalogVersionId: optionalText(body.catalogVersionId, "catalogVersionId") });
    send(response, 200, { ok: true }); return;
  }
  if (request.method === "GET" && url.pathname === "/api/operations/workspace") {
    send(response, 200, await atsRepository.operationsWorkspace(currentUser)); return;
  }
  if (request.method === "POST" && url.pathname === "/api/operations/messages/sync") {
    const body = await readJson(request); const direction = text(body.direction, "direction");
    if (direction !== "inbound" && direction !== "outbound") throw new Error("direction must be inbound or outbound.");
    send(response, 201, { message: await atsRepository.syncInboundMessage(currentUser, {
      stateId: text(body.stateId, "stateId"), externalMessageId: text(body.externalMessageId, "externalMessageId"),
      direction, body: text(body.body, "body"), sentAt: text(body.sentAt, "sentAt")
    }) }); return;
  }
  if (request.method === "POST" && url.pathname === "/api/operations/tags") {
    const body = await readJson(request); send(response, 201, { tag: await atsRepository.createTalentTag(currentUser, {
      name: text(body.name, "name"), color: optionalText(body.color, "color") ?? "slate"
    }) }); return;
  }
  if (request.method === "POST" && url.pathname === "/api/operations/tag-candidate") {
    const body = await readJson(request); await atsRepository.tagCandidate(currentUser, text(body.candidateId, "candidateId"), text(body.tagId, "tagId"));
    send(response, 200, { ok: true }); return;
  }
  if (request.method === "POST" && url.pathname === "/api/operations/account-health") {
    const body = await readJson(request); const status = text(body.status, "status");
    if (!["healthy", "degraded", "blocked", "unknown"].includes(status)) throw new Error("status must be supported.");
    await atsRepository.updateAccountHealth(currentUser, { bossAccountId: text(body.bossAccountId, "bossAccountId"), status,
      authoritative: boolean(body.authoritative, "authoritative"), reason: optionalText(body.reason, "reason"), checkedAt: text(body.checkedAt, "checkedAt") });
    send(response, 200, { ok: true }); return;
  }
  const alertAckMatch = url.pathname.match(/^\/api\/operations\/alerts\/([0-9a-f-]+)\/acknowledge$/i);
  if (request.method === "POST" && alertAckMatch) {
    await atsRepository.acknowledgeAlert(currentUser, alertAckMatch[1]!); send(response, 200, { ok: true }); return;
  }
  if (request.method === "POST" && url.pathname === "/api/operations/export") {
    const body = await readJson(request); const format = text(body.format, "format");
    if (format !== "json" && format !== "csv") throw new Error("format must be json or csv.");
    send(response, 201, { export: await atsRepository.exportDepartment(currentUser, format) }); return;
  }
  if (request.method === "POST" && url.pathname === "/api/operations/retention") {
    const body = await readJson(request); const days = integer(body.retentionDays, "retentionDays");
    if (days < 30 || days > 3650) throw new Error("retentionDays must be between 30 and 3650.");
    await atsRepository.setRetention(currentUser, days); send(response, 200, { ok: true }); return;
  }
  if (request.method === "GET" && url.pathname === "/api/automation/workspace") {
    send(response, 200, await atsRepository.automationWorkspace(currentUser)); return;
  }
  if (request.method === "POST" && url.pathname === "/api/automation/controls") {
    const body = await readJson(request); const scopeType = text(body.scopeType, "scopeType");
    if (!["global", "department", "position", "task"].includes(scopeType)) throw new Error("scopeType must be supported.");
    await atsRepository.setContactControl(currentUser, { scopeType: scopeType as "global" | "department" | "position" | "task",
      scopeId: text(body.scopeId, "scopeId"), enabled: boolean(body.enabled, "enabled"),
      approvalRequired: boolean(body.approvalRequired, "approvalRequired"), policy: body.policy ?? {},
      emergencyStop: boolean(body.emergencyStop, "emergencyStop") });
    send(response, 200, { ok: true, sideEffectsMode: "fake_only" }); return;
  }
  if (request.method === "POST" && url.pathname === "/api/automation/approval-requests") {
    const body = await readJson(request); const scopeType = text(body.scopeType, "scopeType");
    if (!["department", "position", "task"].includes(scopeType)) throw new Error("scopeType must be department, position or task.");
    send(response, 201, { approval: await atsRepository.requestContactApproval(currentUser, {
      scopeType: scopeType as "department" | "position" | "task", scopeId: text(body.scopeId, "scopeId"), justification: text(body.justification, "justification")
    }) }); return;
  }
  const approvalDecisionMatch = url.pathname.match(/^\/api\/automation\/approval-requests\/([0-9a-f-]+)\/decision$/i);
  if (request.method === "POST" && approvalDecisionMatch) {
    const body = await readJson(request); const decision = text(body.decision, "decision");
    if (decision !== "approved" && decision !== "rejected") throw new Error("decision must be approved or rejected.");
    await atsRepository.decideContactApproval(currentUser, { requestId: approvalDecisionMatch[1]!, decision, note: optionalText(body.note, "note") ?? "" });
    send(response, 200, { ok: true }); return;
  }
  if (request.method === "GET" && url.pathname === "/api/automation/readiness") {
    send(response, 200, await atsRepository.contactReadiness(currentUser, {
      positionId: text(url.searchParams.get("positionId"), "positionId"), taskId: url.searchParams.get("taskId"), candidateId: url.searchParams.get("candidateId")
    })); return;
  }
  if (request.method === "POST" && url.pathname === "/api/automation/simulate") {
    const body = await readJson(request); const readiness = await atsRepository.contactReadiness(currentUser, {
      positionId: text(body.positionId, "positionId"), taskId: optionalText(body.taskId, "taskId"), candidateId: optionalText(body.candidateId, "candidateId")
    }) as { ready: boolean; reasons: string[] };
    send(response, readiness.ready ? 200 : 409, { simulated: readiness.ready, readiness, realGreetingExecuted: false, sideEffectsMode: "fake_only" }); return;
  }
  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    const allowedPositionIds = new Set(await atsRepository.positionIds(currentUser));
    const [dashboard, schedules, contactIntents, auditLogs] = await Promise.all([
      repository.getDashboard(),
      m2Repository.listSchedules(),
      m2Repository.listContactIntents(),
      m2Repository.listAuditLogs()
    ]);
    const positions = dashboard.positions.filter((item) => allowedPositionIds.has(item.id));
    const activeRules = dashboard.activeRules.filter((item) => allowedPositionIds.has(item.positionId));
    const tasks = dashboard.tasks.filter((item) => allowedPositionIds.has(item.positionId));
    const candidates = dashboard.candidates.filter((item) => allowedPositionIds.has(item.positionId));
    const scopedSchedules = schedules.filter((item) => allowedPositionIds.has(item.positionId));
    const scopedIntents = contactIntents.filter((item) =>
      candidates.some((candidate) => candidate.stateId === item.candidateStateId)
    );
    send(response, 200, {
      ...dashboard,
      metrics: {
        totalCandidates: candidates.length,
        matchedCandidates: candidates.filter((item) => item.ruleDecision === "matched").length,
        pendingReview: candidates.filter((item) => item.reviewStatus === "pending").length,
        contactedToday: candidates.filter((item) => item.contactStatus === "sent").length
      },
      positions, activeRules, tasks, candidates,
      schedules: scopedSchedules,
      contactIntents: scopedIntents,
      auditLogs: currentUser.role === "admin" || currentUser.role === "recruiting_lead"
        ? auditLogs
        : auditLogs.filter((item) => item.actorId === currentUser.userId)
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/positions") {
    const allowed = new Set(await atsRepository.positionIds(currentUser));
    send(response, 200, { positions: (await repository.listPositions()).filter((item) => allowed.has(item.id)) });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/positions") {
    const body = await readJson(request);
    const position = await repository.createPosition({
      bossAccountId: text(body.bossAccountId, "bossAccountId"),
      name: text(body.name, "name"),
      bossJobKeyword: optionalText(body.bossJobKeyword, "bossJobKeyword"),
      ownerName: currentUser.displayName
    });
    await atsRepository.adoptPosition(currentUser, position.id);
    send(response, 201, { position });
    return;
  }
  const ruleMatch = url.pathname.match(/^\/api\/positions\/([0-9a-f-]+)\/rules$/i);
  if (request.method === "POST" && ruleMatch) {
    await atsRepository.assertPosition(currentUser, ruleMatch[1]!);
    const body = await readJson(request);
    const version = await atsRepository.createRuleDraft(currentUser, {
      positionId: ruleMatch[1]!,
      name: text(body.name, "name"),
      config: ruleConfig(body.config),
      dictionaryVersion: text(body.dictionaryVersion, "dictionaryVersion"),
      parentVersionId: optionalText(body.parentVersionId, "parentVersionId")
    });
    send(response, 201, { version });
    return;
  }
  const memberMatch = url.pathname.match(/^\/api\/positions\/([0-9a-f-]+)\/members$/i);
  if (request.method === "POST" && memberMatch) {
    const body = await readJson(request);
    const memberRole = text(body.memberRole, "memberRole");
    if (!["owner", "recruiter", "interviewer", "viewer"].includes(memberRole)) {
      throw new Error("memberRole must be a supported position role.");
    }
    await atsRepository.assignPosition(
      currentUser,
      memberMatch[1]!,
      text(body.userId, "userId"),
      memberRole as "owner" | "recruiter" | "interviewer" | "viewer"
    );
    send(response, 200, { ok: true });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/tasks") {
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
      throw new Error("Idempotency-Key header is required.");
    }
    const body = await readJson(request);
    await atsRepository.assertPosition(currentUser, text(body.positionId, "positionId"));
    const source = text(body.source, "source");
    if (source !== "recommend" && source !== "search") {
      throw new Error("source must be recommend or search.");
    }
    const searchKeyword = optionalText(body.searchKeyword, "searchKeyword");
    if (source === "search" && !searchKeyword) {
      throw new Error("searchKeyword is required when source is search.");
    }
    const task = await repository.createImmediateTask({
      idempotencyKey: idempotencyKey.trim(),
      positionId: text(body.positionId, "positionId"),
      source,
      searchKeyword,
      createdBy: currentUser.userId
    });
    send(response, 201, { task });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/schedules") {
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
      throw new Error("Idempotency-Key header is required.");
    }
    const body = await readJson(request);
    await atsRepository.assertPosition(currentUser, text(body.positionId, "positionId"));
    const source = text(body.source, "source");
    if (source !== "recommend" && source !== "search") {
      throw new Error("source must be recommend or search.");
    }
    const frequency = text(body.frequency, "frequency");
    if (!["once", "daily", "weekdays", "weekly"].includes(frequency)) {
      throw new Error("frequency must be once, daily, weekdays or weekly.");
    }
    const searchKeyword = optionalText(body.searchKeyword, "searchKeyword");
    if (source === "search" && !searchKeyword) {
      throw new Error("searchKeyword is required when source is search.");
    }
    const nextRunAt = text(body.nextRunAt, "nextRunAt");
    if (Date.parse(nextRunAt) <= Date.now()) throw new Error("nextRunAt must be in the future.");
    const schedule = await m2Repository.createSchedule({
      idempotencyKey: idempotencyKey.trim(),
      positionId: text(body.positionId, "positionId"),
      source,
      searchKeyword,
      frequency: frequency as "once" | "daily" | "weekdays" | "weekly",
      timezone: "Asia/Shanghai",
      nextRunAt,
      createdBy: currentUser.userId
    });
    send(response, 201, { schedule });
    return;
  }
  const cancelScheduleMatch = url.pathname.match(/^\/api\/schedules\/([0-9a-f-]+)\/cancel$/i);
  if (request.method === "POST" && cancelScheduleMatch) {
    const body = await readJson(request);
    const scheduleAccess = await sql<Array<{ position_id: string }>>`
      SELECT position_id FROM schedules WHERE id = ${cancelScheduleMatch[1]!}
    `;
    if (!scheduleAccess[0]) throw new Error("Schedule was not found.");
    await atsRepository.assertPosition(currentUser, scheduleAccess[0].position_id);
    const schedule = await m2Repository.cancelSchedule({
      scheduleId: cancelScheduleMatch[1]!,
      expectedVersion: integer(body.expectedVersion, "expectedVersion"),
      actorId: currentUser.userId
    });
    send(response, 200, { schedule });
    return;
  }
  const candidateMatch = url.pathname.match(
    /^\/api\/candidate-position-states\/([0-9a-f-]+)$/i
  );
  if (request.method === "GET" && candidateMatch) {
    const candidate = await repository.getCandidateDetail(candidateMatch[1]!);
    if (!candidate) {
      send(response, 404, { error: "not_found", message: "Candidate state was not found." });
      return;
    }
    await atsRepository.assertPosition(currentUser, candidate.positionId);
    send(response, 200, { candidate });
    return;
  }
  const resumeScreeningMatch = url.pathname.match(
    /^\/api\/candidate-position-states\/([0-9a-f-]+)\/resume-screenings$/i
  );
  if (request.method === "POST" && resumeScreeningMatch) {
    const body = await readJson(request);
    const candidate = await repository.getCandidateDetail(resumeScreeningMatch[1]!);
    if (!candidate) throw new Error("Candidate state was not found.");
    await atsRepository.assertPosition(currentUser, candidate.positionId);
    await repository.requeueResumeScreening(
      resumeScreeningMatch[1]!,
      currentUser.userId
    );
    send(response, 202, { queued: true });
    return;
  }
  const previewMatch = url.pathname.match(
    /^\/api\/candidate-position-states\/([0-9a-f-]+)\/message-preview$/i
  );
  if (request.method === "GET" && previewMatch) {
    const candidate = await repository.getCandidateDetail(previewMatch[1]!);
    if (!candidate) throw new Error("Candidate state was not found.");
    await atsRepository.assertPosition(currentUser, candidate.positionId);
    send(response, 200, { preview: await m2Repository.previewMessage(previewMatch[1]!) });
    return;
  }
  const contactMatch = url.pathname.match(
    /^\/api\/candidate-position-states\/([0-9a-f-]+)\/contact-intents$/i
  );
  if (request.method === "POST" && contactMatch) {
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
      throw new Error("Idempotency-Key header is required.");
    }
    const body = await readJson(request);
    const candidate = await repository.getCandidateDetail(contactMatch[1]!);
    if (!candidate) throw new Error("Candidate state was not found.");
    await atsRepository.assertPosition(currentUser, candidate.positionId);
    await atsRepository.assertCandidateContactable(currentUser, contactMatch[1]!);
    const preview = await m2Repository.previewMessage(contactMatch[1]!);
    const requestedVersionId = text(body.templateVersionId, "templateVersionId");
    if (requestedVersionId !== preview.templateVersionId) {
      throw new Error("templateVersionId is no longer active; refresh the preview.");
    }
    if (!preview.renderedMessage.trim() || preview.renderedMessage.length > 500) {
      throw new Error("Rendered message must contain 1 to 500 characters.");
    }
    const now = new Date();
    const intent = await m2Repository.createManualContactIntent({
      stateId: contactMatch[1]!,
      idempotencyKey: idempotencyKey.trim(),
      templateVersionId: preview.templateVersionId,
      renderedMessage: preview.renderedMessage,
      createdBy: currentUser.userId,
      localMinuteOfDay: shanghaiMinuteOfDay(now),
      now: now.toISOString()
    });
    send(response, 201, { intent, realGreetingEnabled: false });
    return;
  }
  const reviewMatch = url.pathname.match(
    /^\/api\/candidate-position-states\/([0-9a-f-]+)\/reviews$/i
  );
  if (request.method === "POST" && reviewMatch) {
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
      throw new Error("Idempotency-Key header is required.");
    }
    const body = await readJson(request);
    const candidate = await repository.getCandidateDetail(reviewMatch[1]!);
    if (!candidate) throw new Error("Candidate state was not found.");
    await atsRepository.assertPosition(currentUser, candidate.positionId);
    const decision = text(body.decision, "decision");
    if (decision !== "approved" && decision !== "rejected") {
      throw new Error("decision must be approved or rejected.");
    }
    const correctionCode = optionalText(body.correctionCode, "correctionCode");
    const allowedCorrectionCodes = [
      "alias_missing",
      "negative_detection",
      "concept_confusion",
      "other"
    ];
    if (correctionCode && !allowedCorrectionCodes.includes(correctionCode)) {
      throw new Error("correctionCode must be a supported correction code.");
    }
    const review = await repository.reviewCandidate({
      stateId: reviewMatch[1]!,
      idempotencyKey: idempotencyKey.trim(),
      decision,
      note: optionalText(body.note, "note") ?? "",
      correctionCode,
      reviewerId: currentUser.userId,
      expectedVersion: integer(body.expectedVersion, "expectedVersion")
    });
    send(response, 201, { review });
    return;
  }
  send(response, 404, { error: "not_found" });
}

const server = createServer((request, response) => {
  void route(request, response).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const status =
      error instanceof AuthorizationError
        ? 401
        : error instanceof OptimisticLockError
        ? 409
        : message === "Invalid integration token."
          ? 401
        : message.includes("policy blocked") || message.includes("version conflict")
          ? 409
          : message.includes("not found")
            ? 404
            : message.includes("required") ||
                message.includes("must") ||
                message.includes("exceeds")
              ? 400
              : 500;
    const code =
      error instanceof AuthorizationError
        ? "unauthorized"
        : error instanceof OptimisticLockError
        ? "version_conflict"
        : status === 401
          ? "unauthorized"
        : status === 409
          ? "conflict"
          : status === 404
            ? "not_found"
            : status === 400
              ? "invalid_request"
              : "internal_error";
    send(response, status, { error: code, message });
  });
});

await atsRepository.ensureBootstrap({
  departmentName: process.env.BOSS_FORGE_BOOTSTRAP_DEPARTMENT?.trim() || "默认招聘部门",
  adminEmail: process.env.BOSS_FORGE_BOOTSTRAP_ADMIN_EMAIL?.trim() || "admin@boss-forge.internal",
  adminName: process.env.BOSS_FORGE_BOOTSTRAP_ADMIN_NAME?.trim() || "HR 管理员",
  password: process.env.BOSS_FORGE_BOOTSTRAP_PASSWORD?.trim() || "ChangeMe-BossForge-Internal!"
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ event: "control_api.ready", host, port, webOrigin }));
});

async function stop(): Promise<void> {
  server.close();
  await sql.end();
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
