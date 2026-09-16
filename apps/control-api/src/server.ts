import { loginRefreshPending } from './login-refresh-status.js';
import { workspaceActivityRoutes } from './workspace-activity-routes.js';
import { communicationRoutes } from './communication-routes.js';
import { lifecycleRoutes } from './lifecycle-routes.js';
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  AuthenticationError,
  AuthorizationError,
  BossForgeRepository,
  DepartmentAtsRepository,
  M2Repository,
  RecruitmentRepository,
  CommunicationRepository,
  LifecycleRepository,
  WorkspaceActivityRepository,
  OptimisticLockError,
  createDatabase,
  parseRuleConfig,
  type RuleConfig,
  type SessionPrincipal
} from "@boss-forge/data";
import { evaluateCandidate } from "@boss-forge/m1-core";
import { semanticProviderReadinessFromEnvironment } from "@boss-forge/semantic-engine";
import {
  readResumeArtifact,
  readResumePart,
  resolveResumeFile,
  BossBrowserControlError,
  requestBossPositionsViaIpc,
  requestBossFilterOptionsViaIpc,
  bossBrowserControlSocketPath,
  requestBossGreetingPreviewViaIpc,
  requestBossGreetingSaveViaIpc,
  withContactGlobalFence,
  type BossGreetingPreview
} from "@boss-forge/boss-cli-adapter";
import {
  screeningCandidateLimit,
  ScreeningLimitError,
  REAL_CONTACT_TRANSPORT_AVAILABLE,
  ContactPreviewApprovalConfigurationError,
  ContactPreviewApprovalError,
  contactDispatchModeFromEnvironment,
  contactMessageSha256,
  contactPreviewApprovalSigningKeyFromEnvironment,
  contactPreviewApprovalIdempotencyKey,
  contactSideEffectsModeFromEnvironment,
  contactSourceLocatorSha256,
  issueContactPreviewApproval,
  realContactEnabled,
  resumeViewPolicyState,
  resumeViewPolicyFromEnvironment,
  shanghaiDayStart,
  verifyContactPreviewApproval,
  type CandidateSourceLocator,
  type ContactActionKind,
  type ParsedCandidate
} from "@boss-forge/contracts";
import {
  generateSynonyms,
  SynonymModelUnavailableError
} from "./synonym-generator.js";

const host = process.env.CONTROL_API_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.CONTROL_API_PORT ?? "3100");
const webOrigin = process.env.CONTROL_WEB_ORIGIN?.trim() || "http://localhost:3000";
const bossLoginRuntimeDirectory = resolve(
  process.env.BOSS_FORGE_RUNTIME_DIR?.trim() || resolve(process.cwd(), ".boss-forge", "runtime")
);
const bossLoginStatusPath = join(bossLoginRuntimeDirectory, "boss-login-status.json");
const bossLoginImagePath = join(bossLoginRuntimeDirectory, "boss-login.png");
const bossLoginRefreshRequestPath = join(
  bossLoginRuntimeDirectory,
  "boss-login-refresh-request.json"
);
const sql = createDatabase();
const repository = new BossForgeRepository(sql);
const m2Repository = new M2Repository(sql);
const atsRepository = new DepartmentAtsRepository(sql);
const recruitmentRepository = new RecruitmentRepository(sql);
const communicationRepository = new CommunicationRepository(sql);
const lifecycleRepository = new LifecycleRepository(sql);
const workspaceActivityRepository = new WorkspaceActivityRepository(sql);
const releaseId = process.env.BOSS_FORGE_RELEASE_ID?.trim() || "unversioned";
const contactDispatchMode = contactDispatchModeFromEnvironment(process.env);

function realGreetingEnabled(): boolean {
  return (
    contactDispatchMode === "real" &&
    realContactEnabled(process.env)
  );
}

function sideEffectsMode(): ReturnType<typeof contactSideEffectsModeFromEnvironment> {
  return contactSideEffectsModeFromEnvironment(process.env);
}

async function readExactBossGreeting(input: {
  bossAccountId: string;
  bossJobKeyword: string | null;
}): Promise<BossGreetingPreview> {
  if (!input.bossJobKeyword?.trim()) {
    throw new Error("当前岗位没有配置可唯一定位的 BOSS 岗位名称，无法读取招呼语。");
  }
  const relay = await bossLoginRelayStatus();
  const consistency = runtimeConsistency(relay);
  if (relay.state !== "authenticated" || !consistency.consistent) {
    throw new Error("BOSS 登录或 Worker 状态未通过校验，暂时无法读取岗位招呼语。");
  }
  // The API container never owns or starts a browser. The authenticated
  // boss-login supervisor performs this read-only command over a private Unix
  // socket while holding the same account lock as its workers.
  const preview = await requestBossGreetingPreviewViaIpc({
    socketPath: bossBrowserControlSocketPath(bossLoginRuntimeDirectory),
    accountId: input.bossAccountId,
    jobKeyword: input.bossJobKeyword,
    timeoutMs: 40_000
  });
  // The supervisor has just checked this exact account over CDP and read BOSS.
  // Publish that successful probe before readiness uses its 30-minute cache.
  await m2Repository.recordVerifiedBossAccountHealth(input.bossAccountId, new Date().toISOString());
  return preview;
}

async function batchPreviews(principal: SessionPrincipal, input: { stateIds: string[]; actionKind: ContactActionKind; templateVersionId: string | null }) {
  if (input.stateIds.length < 1 || input.stateIds.length > 20 || new Set(input.stateIds).size !== input.stateIds.length) throw new Error("每批请选择 1–20 位不同候选人。");
  const previews = [];
  let greeting: BossGreetingPreview | null = null;
  let positionId: string | null = null;
  for (const stateId of input.stateIds) {
    const target = input.actionKind === "greet" ? await m2Repository.previewContactTarget(stateId) : await m2Repository.previewMessage(stateId, input.templateVersionId, principal.displayName);
    await atsRepository.assertCandidateContactable(principal, stateId);
    if (positionId && positionId !== target.positionId) throw new Error("请按岗位分别批量联系。");
    positionId = target.positionId;
    if (input.actionKind === "greet" && !greeting) greeting = await readExactBossGreeting(target);
    const message = input.actionKind === "message" ? target as Awaited<ReturnType<M2Repository['previewMessage']>> : null;
    const renderedMessage = greeting?.body ?? message!.renderedMessage;
    if (!renderedMessage.trim() || renderedMessage.length > 500) throw new Error("最终消息长度无效，请修改模板。");
    const now = new Date();
    const context = {
      actionKind: input.actionKind, approvedBy: principal.userId,
      candidateStateId: target.candidateStateId, candidateId: target.candidateId, candidateName: target.candidateName,
      positionId: target.positionId, positionName: target.positionName, taskId: target.taskId,
      bossAccountId: target.bossAccountId, source: target.source,
      sourceLocator: target.sourceLocator!, templateVersionId: message?.templateVersionId ?? null,
      providerJobId: greeting?.jobId ?? null, providerGreetingId: greeting?.greetingId ?? null, renderedMessage,
    };
    const readiness = await m2Repository.previewContactReadiness({ stateId, actionKind: input.actionKind, now: now.toISOString(), localMinuteOfDay: shanghaiMinuteOfDay(now) });
    const approval = realGreetingEnabled() ? issueContactPreviewApproval({ context: { ...context, sourceLocator: requiredContactSourceLocator(context.sourceLocator) }, signingKey: contactPreviewApprovalSigningKeyFromEnvironment(process.env), now, ttlMs: 10 * 60 * 1000 }) : null;
    previews.push({ context, readiness, approval });
  }
  return previews;
}

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

function sendPng(response: ServerResponse, image: Buffer): void {
  response.writeHead(200, {
    "content-type": "image/png",
    "content-length": String(image.byteLength),
    "cache-control": "no-store, max-age=0",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": webOrigin,
    vary: "origin"
  });
  response.end(image);
}

type BossLoginRelayState =
  | "offline"
  | "starting"
  | "refreshing"
  | "awaiting_scan"
  | "authenticated"
  | "risk_controlled"
  | "error";

type BossLoginRelayStatus = {
  state: BossLoginRelayState;
  message: string;
  updatedAt: string | null;
  imageAvailable: boolean;
  imageUpdatedAt: string | null;
  verification: Record<string, unknown> | null;
  releaseId: string | null;
  contactDispatchMode: string | null;
  resumePolicy: Record<string, unknown> | null;
};

function fileNotFound(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && error.code === "ENOENT"
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function runtimeConsistency(status: BossLoginRelayStatus): {
  consistent: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  const apiPolicy = resumeViewPolicyFromEnvironment(process.env);
  if (!status.releaseId) reasons.push("worker_release_unknown");
  else if (status.releaseId !== releaseId) reasons.push("release_mismatch");
  if (!status.contactDispatchMode) reasons.push("worker_contact_dispatch_mode_unknown");
  else if (status.contactDispatchMode !== contactDispatchMode) {
    reasons.push("contact_dispatch_mode_mismatch");
  }
  if (!status.resumePolicy) reasons.push("worker_resume_policy_unknown");
  else if (canonicalJson(status.resumePolicy) !== canonicalJson(apiPolicy)) {
    reasons.push("resume_policy_mismatch");
  }
  if (status.state === "authenticated") {
    if (
      status.verification?.browserAuthenticated !== true ||
      status.verification?.workerHeartbeatFresh !== true
    ) {
      reasons.push("worker_verification_incomplete");
    }
  }
  return { consistent: reasons.length === 0, reasons };
}

async function assertWorkerRuntimeConsistent(): Promise<void> {
  const status = await bossLoginRelayStatus();
  if (status.state === "offline") return;
  const consistency = runtimeConsistency(status);
  if (!consistency.consistent) {
    throw new Error(
      `Worker runtime mismatch; new BOSS work is paused: ${consistency.reasons.join(",")}`
    );
  }
}

async function bossLoginRelayStatus(): Promise<BossLoginRelayStatus> {
  try {
    const raw: unknown = JSON.parse(await readFile(bossLoginStatusPath, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("BOSS login relay status is invalid.");
    }
    const status = raw as Record<string, unknown>;
    const state = status.state;
    const message = status.message;
    const updatedAt = status.updatedAt;
    const verification =
      status.verification &&
      typeof status.verification === "object" &&
      !Array.isArray(status.verification)
        ? status.verification as Record<string, unknown>
        : null;
    const workerReleaseId =
      typeof status.releaseId === "string" && status.releaseId.trim()
        ? status.releaseId
        : null;
    const workerResumePolicy =
      status.resumePolicy &&
      typeof status.resumePolicy === "object" &&
      !Array.isArray(status.resumePolicy)
        ? status.resumePolicy as Record<string, unknown>
        : null;
    const workerContactDispatchMode =
      typeof status.contactDispatchMode === "string" && status.contactDispatchMode.trim()
        ? status.contactDispatchMode
        : null;
    if (
      !["starting", "refreshing", "awaiting_scan", "authenticated", "risk_controlled", "error"].includes(String(state)) ||
      typeof message !== "string" ||
      typeof updatedAt !== "string"
    ) {
      throw new Error("BOSS login relay status is invalid.");
    }
    const updatedTime = Date.parse(updatedAt);
    const terminalState = state === "risk_controlled" || state === "error";
    if ((!Number.isFinite(updatedTime) || Date.now() - updatedTime > 20_000) && !terminalState) {
      return {
        state: "offline",
        message: "扫码登录服务未运行或心跳已中断。",
        updatedAt,
        imageAvailable: false,
        imageUpdatedAt: null,
        verification,
        releaseId: workerReleaseId,
        contactDispatchMode: workerContactDispatchMode,
        resumePolicy: workerResumePolicy
      };
    }
    const pendingRefresh = state === "error" && loginRefreshPending(state, updatedAt,
      await readFile(bossLoginRefreshRequestPath, "utf8").then(raw => JSON.parse(raw) as unknown).catch(() => null));
    if (pendingRefresh) {
      return {
        state: "refreshing", message: "正在重新打开 BOSS 官方登录入口…", updatedAt,
        imageAvailable: false, imageUpdatedAt: null, verification,
        releaseId: workerReleaseId, contactDispatchMode: workerContactDispatchMode,
        resumePolicy: workerResumePolicy
      };
    }
    let imageAvailable = false;
    if (state === "awaiting_scan") {
      imageAvailable = await stat(bossLoginImagePath)
        .then((image) => image.isFile() && image.size > 0)
        .catch((error: unknown) => {
          if (fileNotFound(error)) return false;
          throw error;
        });
    }
    return {
      state: state as Exclude<BossLoginRelayState, "offline">,
      message: message.slice(0, 500),
      updatedAt,
      imageAvailable,
      imageUpdatedAt: typeof status.imageUpdatedAt === "string" ? status.imageUpdatedAt : null,
      verification,
      releaseId: workerReleaseId,
      contactDispatchMode: workerContactDispatchMode,
      resumePolicy: workerResumePolicy
    };
  } catch (error) {
    if (!fileNotFound(error)) {
      return {
        state: "error",
        message: "扫码登录状态无法验证，Worker 已暂停。请检查状态文件权限与发布版本。",
        updatedAt: null,
        imageAvailable: false,
        imageUpdatedAt: null,
        verification: null,
        releaseId: null,
        contactDispatchMode: null,
        resumePolicy: null
      };
    }
    return {
      state: "offline",
      message: "扫码登录服务尚未启动。",
      updatedAt: null,
      imageAvailable: false,
      imageUpdatedAt: null,
      verification: null,
      releaseId: null,
      contactDispatchMode: null,
      resumePolicy: null
    };
  }
}

async function requestBossLoginRefresh(): Promise<string> {
  const requestId = randomUUID();
  const temporaryPath = `${bossLoginRefreshRequestPath}.${process.pid}.${requestId}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify({ requestId, requestedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 }
  );
  await rename(temporaryPath, bossLoginRefreshRequestPath);
  return requestId;
}

function assertManager(user: { role: string }): void {
  if (user.role !== "admin" && user.role !== "recruiting_lead") {
    throw new AuthorizationError("Manager role is required.");
  }
}

function assertRecruitingOperator(user: { role: string }): void {
  if (!["admin", "recruiting_lead", "recruiter"].includes(user.role)) {
    throw new AuthorizationError("Recruiter role is required.");
  }
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
}

function contactActionKind(value: unknown): ContactActionKind {
  const actionKind = text(value, "actionKind");
  if (actionKind !== "greet" && actionKind !== "message") {
    throw new Error("actionKind must be greet or message.");
  }
  return actionKind;
}

function sha256Hex(value: unknown, field: string): string {
  const digest = text(value, field);
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error(`${field} must be a lowercase SHA-256 digest.`);
  }
  return digest;
}

function nullableAttestationText(value: unknown, field: string): string | null {
  if (value === null) return null;
  return text(value, field);
}

function requiredContactSourceLocator(
  sourceLocator: CandidateSourceLocator | null
): CandidateSourceLocator {
  if (!sourceLocator?.value.trim()) {
    throw new Error("Contact policy blocked: stable candidate locator is missing.");
  }
  return sourceLocator;
}

function maskedContactSourceLocator(
  sourceLocator: CandidateSourceLocator | null
): string | null {
  if (!sourceLocator?.value.trim()) return null;
  const value = sourceLocator.value.trim();
  return `BOSS 记录 ···${value.slice(-6)}`;
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
  if (!token) throw new AuthenticationError("Authentication required.");
  return atsRepository.authenticate(token);
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": webOrigin,
      "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
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
    send(response, 200, {
      ok: true,
      service: "boss-forge-control-api",
      releaseId,
      contactDispatchMode,
      resumePolicy: resumeViewPolicyFromEnvironment(process.env)
    });
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
  if (request.method === "GET" && url.pathname === "/api/boss-login/status") {
    const user = await principal(request);
    assertManager(user);
    const workerStatus = await bossLoginRelayStatus();
    const consistency = runtimeConsistency(workerStatus);
    send(response, 200, {
      ...workerStatus,
      contactDispatchMode,
      sideEffectsMode: sideEffectsMode(),
      apiReleaseId: releaseId,
      apiResumePolicy: resumeViewPolicyFromEnvironment(process.env),
      runtimeConsistent: consistency.consistent,
      runtimeMismatchReasons: consistency.reasons
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/boss-login/image") {
    const user = await principal(request);
    assertManager(user);
    const status = await bossLoginRelayStatus();
    if (status.state !== "awaiting_scan" || !status.imageAvailable) {
      throw new Error("BOSS login QR image not found.");
    }
    sendPng(response, await readFile(bossLoginImagePath));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/boss-login/refresh") {
    const user = await principal(request);
    assertManager(user);
    const status = await bossLoginRelayStatus();
    if (status.state === "offline") {
      send(response, 503, { message: "扫码登录服务未运行，暂时无法刷新二维码。" });
      return;
    }
    if (status.state === "authenticated") {
      send(response, 409, { message: "BOSS 账号已经登录，无需刷新二维码。" });
      return;
    }
    if (status.state === "risk_controlled") {
      send(response, 409, {
        message: "当前检测到 BOSS 风控或安全验证，不能刷新二维码。请先在 BOSS 官方页面完成验证。"
      });
      return;
    }
    if (status.state === "refreshing") {
      send(response, 409, { message: "二维码正在刷新，请稍候。" });
      return;
    }
    send(response, 202, { requestId: await requestBossLoginRefresh() });
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
    await withContactGlobalFence(() => atsRepository.moveStage(user, stageMatch[1]!, text(body.stage, "stage"), optionalText(body.rejectionReason, "rejectionReason")));
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
    const active = body.active;
    await withContactGlobalFence(() =>
      atsRepository.setDoNotContact(
        user,
        text(body.candidateId, "candidateId"),
        active,
        text(body.reason, "reason")
      )
    );
    send(response, 200, { ok: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/analytics") {
    send(response, 200, await atsRepository.analytics(await principal(request)));
    return;
  }
  const currentUser = await principal(request);
  if (await workspaceActivityRoutes({ request, response, url, principal: currentUser, repository: workspaceActivityRepository,
    accountId: process.env.BOSS_FORGE_ACCOUNT_ID?.trim() || "boss-account-01", readJson, send })) return;
  if (url.pathname.startsWith('/api/recruitment/lifecycle')) {
    const run=()=>lifecycleRoutes({request,response,url,principal:currentUser,repository:lifecycleRepository,readJson,send});
    if (await (request.method==='GET'?run():withContactGlobalFence(run))) return;
  }
  if (await communicationRoutes({request, response, url, principal: currentUser, repository: communicationRepository, activity: workspaceActivityRepository,
    accountId: process.env.BOSS_FORGE_ACCOUNT_ID?.trim() || 'boss-account-01',
    socketPath: bossBrowserControlSocketPath(bossLoginRuntimeDirectory), readJson, send,
    connection: async () => {
      const relay = await bossLoginRelayStatus();
      const connected = relay.state === 'authenticated' && runtimeConsistency(relay).consistent;
      return {connected, canSend: connected && realGreetingEnabled(), message: connected ? 'BOSS 已连接' : 'BOSS 连接暂不可用'};
    },
  })) return;
  if (request.method === "POST" && url.pathname === "/api/system/resume-view-policy/reset") {
    assertManager(currentUser);
    const accountId = process.env.BOSS_FORGE_ACCOUNT_ID?.trim() || "boss-account-01";
    await repository.resetResumeViewQuota({
      bossAccountId: accountId,
      actorId: currentUser.userId
    });
    send(response, 200, { ok: true, accountId, resetAt: new Date().toISOString() });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/system/resume-view-policy") {
    assertManager(currentUser);
    const now = new Date();
    const policy = resumeViewPolicyFromEnvironment(process.env);
    const accountId = process.env.BOSS_FORGE_ACCOUNT_ID?.trim() || "boss-account-01";
    const usage = await repository.resumeViewUsage(
      accountId,
      shanghaiDayStart(now),
      new Date(now.getTime() - 60 * 60 * 1_000)
    );
    const state = resumeViewPolicyState(now, policy, usage);
    send(response, 200, {
      accountId,
      policy,
      usage,
      state,
      generatedAt: now.toISOString()
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/semantic/synonyms") {
    if (currentUser.role === "interviewer") {
      throw new AuthorizationError("Interviewer role cannot edit position rules.");
    }
    const body = await readJson(request);
    send(response, 200, {
      preview: await generateSynonyms({
        term: text(body.term, "term"),
        positionName: optionalText(body.positionName, "positionName"),
        criterionLabel: optionalText(body.criterionLabel, "criterionLabel")
      })
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/department/workspace") {
    send(response, 200, await atsRepository.departmentWorkspace(currentUser));
    return;
  }
  const userStatusMatch = url.pathname.match(/^\/api\/team\/users\/([0-9a-f-]+)\/status$/i);
  if (request.method === "POST" && userStatusMatch) {
    const body = await readJson(request);
    const status = text(body.status, "status");
    if (status !== "active" && status !== "disabled") throw new Error("status must be active or disabled.");
    await withContactGlobalFence(() =>
      atsRepository.updateUserStatus(currentUser, userStatusMatch[1]!, status)
    );
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
      versions: Array<{ id: string; config: RuleConfig }>; samples: Array<{ stateId: string; name: string; source: "recommend" | "search"; fields: Record<string, string>; evidence: string[]; raw: string; sourceBossFilters: import('@boss-forge/contracts').BossRecommendationFilterPlan | null }>
    };
    const baseline = prepared.versions.find((item) => item.id === baselineVersionId)!;
    const candidate = prepared.versions.find((item) => item.id === candidateVersionId)!;
    const changes: Array<{ stateId: string; from: string; to: string }> = [];
    prepared.samples.forEach((sample, index) => {
      const parsed: ParsedCandidate = { index, name: sample.name, source: sample.source, fields: sample.fields, evidence: sample.evidence, raw: sample.raw };
      const from = evaluateCandidate(parsed, baseline.config, null, [], sample.sourceBossFilters).decision;
      const to = evaluateCandidate(parsed, candidate.config, null, [], sample.sourceBossFilters).decision;
      if (from !== to) changes.push({ stateId: sample.stateId, from, to });
    });
    send(response, 201, { replay: await atsRepository.saveRuleReplay(currentUser, {
      positionId, baselineVersionId, candidateVersionId, sampleSize: prepared.samples.length,
      changedCount: changes.length, summary: { changes: changes.slice(0, 100), stableCount: prepared.samples.length - changes.length }
    }) }); return;
  }
  if (request.method === "GET" && url.pathname === "/api/semantic/workspace") {
    const workspace = await atsRepository.semanticWorkspace(currentUser) as Record<string, unknown>;
    send(response, 200, {
      ...workspace,
      providerReadiness: semanticProviderReadinessFromEnvironment(process.env)
    });
    return;
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
    if (process.env.BOSS_FORGE_TEST_CONTACTS !== "1") {
      throw new AuthorizationError(
        "Manual BOSS reply injection is disabled; replies must come from the authenticated integration."
      );
    }
    assertManager(currentUser);
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
    if (body.authoritative === true) {
      throw new Error(
        "authoritative must be false; only the authenticated browser probe can publish authoritative health."
      );
    }
    await withContactGlobalFence(() => atsRepository.updateAccountHealth(currentUser, {
      bossAccountId: text(body.bossAccountId, "bossAccountId"), status,
      authoritative: false,
      reason: optionalText(body.reason, "reason"),
      checkedAt: new Date().toISOString()
    }));
    send(response, 200, { ok: true, authoritative: false }); return;
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
    await withContactGlobalFence(() => atsRepository.setContactControl(currentUser, {
      scopeType: scopeType as "global" | "department" | "position" | "task",
      scopeId: text(body.scopeId, "scopeId"), enabled: boolean(body.enabled, "enabled"),
      approvalRequired: boolean(body.approvalRequired, "approvalRequired"), policy: body.policy ?? {},
      emergencyStop: boolean(body.emergencyStop, "emergencyStop")
    }));
    send(response, 200, { ok: true, contactDispatchMode, sideEffectsMode: sideEffectsMode() }); return;
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
    await withContactGlobalFence(() => atsRepository.decideContactApproval(currentUser, {
      requestId: approvalDecisionMatch[1]!,
      decision,
      note: optionalText(body.note, "note") ?? ""
    }));
    send(response, 200, { ok: true }); return;
  }
  if (request.method === "GET" && url.pathname === "/api/automation/readiness") {
    const readiness = await atsRepository.contactReadiness(currentUser, {
      positionId: text(url.searchParams.get("positionId"), "positionId"), taskId: url.searchParams.get("taskId"), candidateId: url.searchParams.get("candidateId")
    }) as Record<string, unknown>;
    send(response, 200, { ...readiness, contactDispatchMode, sideEffectsMode: sideEffectsMode() }); return;
  }
  if (request.method === "POST" && url.pathname === "/api/automation/simulate") {
    const body = await readJson(request); const readiness = await atsRepository.contactReadiness(currentUser, {
      positionId: text(body.positionId, "positionId"), taskId: optionalText(body.taskId, "taskId"), candidateId: optionalText(body.candidateId, "candidateId")
    }) as { ready: boolean; reasons: string[] };
    send(response, readiness.ready ? 200 : 409, { simulated: readiness.ready, readiness, realGreetingExecuted: false, contactDispatchMode, sideEffectsMode: sideEffectsMode() }); return;
  }
  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    const allowedPositionIdList = await atsRepository.positionIds(currentUser);
    const allowedPositionIds = new Set(allowedPositionIdList);
    const manager = currentUser.role === "admin" || currentUser.role === "recruiting_lead";
    const [dashboard, schedules, contactIntents, auditLogs, workerStatus] = await Promise.all([
      repository.getDashboard({ positionIds: allowedPositionIdList, taskLimit: 100 }),
      m2Repository.listSchedules({ positionIds: allowedPositionIdList }),
      m2Repository.listContactIntents({ positionIds: allowedPositionIdList }),
      m2Repository.listAuditLogs({
        positionIds: allowedPositionIdList,
        departmentId: currentUser.departmentId,
        ...(manager ? {} : { actorId: currentUser.userId })
      }),
      bossLoginRelayStatus()
    ]);
    const positions = dashboard.positions.filter((item) => allowedPositionIds.has(item.id));
    const activeRules = dashboard.activeRules.filter((item) => allowedPositionIds.has(item.positionId));
    const latestRules = dashboard.latestRules.filter((item) => allowedPositionIds.has(item.positionId));
    const tasks = dashboard.tasks.filter((item) => allowedPositionIds.has(item.positionId));
    const candidates = dashboard.candidates.filter((item) => allowedPositionIds.has(item.positionId));
    const scopedSchedules = schedules.filter((item) => allowedPositionIds.has(item.positionId));
    const scopedIntents = contactIntents.filter((item) =>
      candidates.some((candidate) => candidate.stateId === item.candidateStateId)
    );
    send(response, 200, {
      ...dashboard,
      runtime: {
        state: workerStatus.state,
        updatedAt: workerStatus.updatedAt,
        workerHeartbeatFresh: workerStatus.state !== "offline" && workerStatus.verification?.workerHeartbeatFresh === true,
        browserAuthenticated: workerStatus.state === "authenticated" && workerStatus.verification?.browserAuthenticated === true,
        consistent: runtimeConsistency(workerStatus).consistent
      },
      currentUser,
      realContactTransportAvailable: REAL_CONTACT_TRANSPORT_AVAILABLE,
      realGreetingEnabled: realGreetingEnabled(),
      contactDispatchMode,
      sideEffectsMode: sideEffectsMode(),
      releaseId,
      semanticProviderReadiness: semanticProviderReadinessFromEnvironment(process.env),
      resumePolicy: resumeViewPolicyFromEnvironment(process.env),
      metrics: dashboard.metrics,
      positions, activeRules, latestRules, tasks, candidates,
      schedules: scopedSchedules,
      contactIntents: scopedIntents,
      auditLogs
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/boss/positions/sync") {
    assertManager(currentUser);
    const relay = await bossLoginRelayStatus();
    if (relay.state !== "authenticated") {
      send(response, 409, { message: "请先到“设置 → BOSS 登录”扫码，再同步岗位。已有岗位和规则已保留。" });
      return;
    }
    if (!runtimeConsistency(relay).consistent) {
      send(response, 409, { message: "BOSS 连接服务正在准备，请稍后重新同步。" });
      return;
    }
    const accountId = process.env.BOSS_FORGE_ACCOUNT_ID?.trim() || "boss-account-01";
    try {
      const catalog = await requestBossPositionsViaIpc({
        socketPath: bossBrowserControlSocketPath(bossLoginRuntimeDirectory),
        accountId, timeoutMs: 60_000
      });
      const result = await withContactGlobalFence(() => atsRepository.syncBossPositions(currentUser, accountId, catalog));
      const allowed = await atsRepository.positionIds(currentUser);
      send(response, 200, { ...result, positions: await repository.listPositions(allowed) });
    } catch (error) {
      if (!(error instanceof BossBrowserControlError)) throw error;
      send(response, 409, { message: error.code === "busy"
        ? "BOSS 正在执行筛选任务，请等当前操作结束后再次同步。"
        : error.code === "not_authenticated" ? "BOSS 登录已失效，请重新扫码后同步岗位。"
        : "暂时无法完整读取 BOSS 岗位，请检查登录状态后重试。原有岗位和规则未更改。" });
    }
    return;
  }
  const filterOptionsMatch = url.pathname.match(/^\/api\/positions\/([0-9a-f-]+)\/boss-filter-options$/i);
  if (request.method === 'POST' && filterOptionsMatch) {
    assertRecruitingOperator(currentUser);
    const positionId = filterOptionsMatch[1]!;
    await atsRepository.assertPosition(currentUser, positionId);
    const position = (await repository.listPositions([positionId]))[0];
    const accountId = process.env.BOSS_FORGE_ACCOUNT_ID?.trim() || 'boss-account-01';
    if (!position?.bossJobId || position.bossAccountId !== accountId || position.status !== 'active') {
      send(response, 409, { message: '请先同步并选择当前 BOSS 账号的开放岗位，再获取筛选选项。' });
      return;
    }
    const relay = await bossLoginRelayStatus();
    if (relay.state !== 'authenticated' || !runtimeConsistency(relay).consistent) {
      send(response, 409, { message: 'BOSS 连接尚未就绪，请在设置中确认登录后重试。' });
      return;
    }
    try {
      const snapshot = await requestBossFilterOptionsViaIpc({
        socketPath: bossBrowserControlSocketPath(bossLoginRuntimeDirectory), accountId,
        bossJobId: position.bossJobId, jobKeyword: position.bossJobKeyword || position.name, timeoutMs: 60_000,
      });
      send(response, 200, { positionId, ...snapshot });
    } catch (error) {
      if (!(error instanceof BossBrowserControlError)) throw error;
      send(response, 409, { message: error.code === 'busy' ? 'BOSS 正在执行筛选，请等当前操作结束后再获取选项。'
        : error.code === 'not_authenticated' ? 'BOSS 登录已失效，请重新扫码后获取选项。'
        : '暂时无法读取此岗位的 BOSS 筛选选项，请确认岗位仍开放后重试。已选条件已保留。' });
    }
    return;
  }
  const bindPositionMatch = url.pathname.match(/^\/api\/positions\/([0-9a-f-]+)\/boss-binding$/i);
  if (request.method === "POST" && bindPositionMatch) {
    const body = await readJson(request);
    const result = await withContactGlobalFence(() => atsRepository.bindLegacyBossPosition(
      currentUser, bindPositionMatch[1]!, text(body.importedPositionId, "importedPositionId")
    ));
    send(response, 200, result);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/positions") {
    const allowed = await atsRepository.positionIds(currentUser);
    send(response, 200, { positions: await repository.listPositions(allowed) });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/positions") {
    assertManager(currentUser);
    const body = await readJson(request);
    // createAssignedPosition intentionally adopts/updates an existing same-name
    // position, so it must use the same fence as PATCH while a real contact is
    // between its final database check and provider receipt.
    const position = await withContactGlobalFence(() =>
      atsRepository.createAssignedPosition(currentUser, {
        bossAccountId: text(body.bossAccountId, "bossAccountId"),
        name: text(body.name, "name"),
        bossJobKeyword: optionalText(body.bossJobKeyword, "bossJobKeyword"),
        ownerName: currentUser.displayName
      })
    );
    send(response, 201, { position });
    return;
  }
  const positionMatch = url.pathname.match(/^\/api\/positions\/([0-9a-f-]+)$/i);
  if (request.method === "PATCH" && positionMatch) {
    const body = await readJson(request);
    const position = await withContactGlobalFence(() =>
      atsRepository.updatePosition(currentUser, positionMatch[1]!, {
        name: text(body.name, "name"),
        bossJobKeyword: optionalText(body.bossJobKeyword, "bossJobKeyword"),
        ownerName: text(body.ownerName, "ownerName")
      })
    );
    send(response, 200, { position });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/recruitment/readiness") {
    send(response, 200, semanticProviderReadinessFromEnvironment(process.env));
    return;
  }
  const assessmentRetryMatch = url.pathname.match(/^\/api\/candidate-position-states\/([0-9a-f-]+)\/ai-retry$/i);
  if (request.method === "POST" && assessmentRetryMatch) {
    if (currentUser.role === "interviewer") throw new AuthorizationError("Recruiting role required.");
    const candidate = await repository.getCandidateDetail(assessmentRetryMatch[1]!);
    if (!candidate) throw new Error("Candidate not found.");
    await atsRepository.assertPosition(currentUser, candidate.positionId);
    await recruitmentRepository.retry(candidate.stateId, currentUser.userId);
    send(response, 202, { status: "queued" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/message-templates") {
    send(response, 200, await atsRepository.messageTemplateWorkspace(currentUser));
    return;
  }
  const dispatchControlMatch = url.pathname.match(/^\/api\/positions\/([0-9a-f-]+)\/contact-dispatch$/i);
  if (dispatchControlMatch && ["GET", "POST"].includes(request.method ?? "")) {
    const positionId = dispatchControlMatch[1]!;
    await atsRepository.assertPosition(currentUser, positionId);
    if (request.method === "POST") {
      assertRecruitingOperator(currentUser);
      const body = await readJson(request);
      if (typeof body.paused !== "boolean") throw new Error("paused must be a boolean.");
      await m2Repository.setContactDispatchPaused(positionId, body.paused, currentUser.userId);
    }
    send(response, 200, { ...await m2Repository.contactDispatchControl(positionId), canControl: currentUser.role !== "interviewer" });
    return;
  }
  const cancelContactMatch = url.pathname.match(/^\/api\/contact-intents\/([0-9a-f-]+)\/cancel$/i);
  if (request.method === 'POST' && cancelContactMatch) {
    assertRecruitingOperator(currentUser);
    const ids = await atsRepository.positionIds(currentUser);
    const intents = await m2Repository.listContactIntents({ positionIds: ids });
    if (!intents.some(item => item.id === cancelContactMatch[1])) throw new AuthorizationError('Contact access denied.');
    await withContactGlobalFence(() => m2Repository.cancelReadyContact(cancelContactMatch[1]!, currentUser.userId));
    send(response, 200, { status: 'cancelled' }); return;
  }
  const positionGreetingMatch = url.pathname.match(/^\/api\/positions\/([0-9a-f-]+)\/boss-greeting$/i);
  if (request.method === "GET" && positionGreetingMatch) {
    assertRecruitingOperator(currentUser);
    const positionId = positionGreetingMatch[1]!;
    await atsRepository.assertPosition(currentUser, positionId);
    const position = (await repository.listPositions([positionId]))[0];
    if (!position?.bossJobId) throw new Error("请先同步 BOSS 岗位。");
    try {
      const preview = await readExactBossGreeting({ bossAccountId: position.bossAccountId, bossJobKeyword: position.bossJobId });
      send(response, 200, { configured: true, preview });
    } catch (error) {
      if (!(error instanceof BossBrowserControlError)) throw error;
      if (error.code === 'greeting_not_configured') send(response, 200, { configured: false, preview: null });
      else send(response, 409, { code: error.code, message: error.code === 'busy' ? 'BOSS 正在处理简历，请稍后点击重新读取。' : error.code === 'not_authenticated' ? 'BOSS 登录已失效，请在设置中重新登录。' : '读取 BOSS 招呼语失败，请稍后重新读取。' });
    }
    return;
  }
  if (request.method === "POST" && positionGreetingMatch) {
    assertRecruitingOperator(currentUser);
    const positionId = positionGreetingMatch[1]!;
    await atsRepository.assertPosition(currentUser, positionId);
    const body = await readJson(request);
    const content = text(body.body, "body").trim();
    if (content.length < 2 || content.length > 100 || /\{\{/.test(content)) throw new Error("BOSS 岗位招呼语为 2–100 字，不能包含候选人姓名变量。");
    if (body.confirmUpdate !== true) throw new Error("confirmUpdate is required after reviewing the job greeting.");
    const position = (await repository.listPositions([positionId]))[0];
    if (!position?.bossJobId) throw new Error("请先同步 BOSS 岗位。");
    try {
    const preview = await withContactGlobalFence(async () => {
      const queued = await sql`SELECT ci.id FROM contact_intents ci JOIN tasks t ON t.id = ci.task_id JOIN positions p ON p.id = t.position_id WHERE p.boss_account_id = ${position.bossAccountId} AND (p.id = ${positionId} OR p.boss_job_id = ${position.bossJobId!}) AND ci.action_kind = 'greet' AND ci.status IN ('ready', 'processing', 'uncertain') LIMIT 1`;
      if (queued[0]) throw new Error("该岗位仍有待发送或待核实的招呼任务，请完成或取消后再更换招呼语。");
      const saved = await requestBossGreetingSaveViaIpc({ socketPath: bossBrowserControlSocketPath(bossLoginRuntimeDirectory), accountId: position.bossAccountId, bossJobId: position.bossJobId!, jobKeyword: position.bossJobId!, body: content, timeoutMs: 40000 });
      await sql`INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload) VALUES (${randomUUID()}, ${currentUser.userId}, 'position.greeting.updated', 'position', ${positionId}, ${sql.json({ bodySha256: contactMessageSha256(saved.body), bossJobId: saved.jobId })})`;
      return saved;
    });
    send(response, 200, { preview });
    } catch (error) {
      if (!(error instanceof BossBrowserControlError)) throw error;
      send(response, 409, { code: error.code, message: error.code === 'busy'
        ? 'BOSS 正在处理其他操作，招呼语尚未应用。正在等待空闲后重试。'
        : error.code === 'greeting_save_rejected' ? 'BOSS 未接受此条招呼语，本次未应用。请检查文案后重试，或到 BOSS 岗位招呼语设置中查看提示。'
        : error.code === 'not_authenticated' ? 'BOSS 登录已失效，请在设置中重新登录。'
        : '保存结果尚未确认，请先重新读取 BOSS 招呼语。参考消息已保留。' });
    }
    return;
  }
  if (request.method === "POST" && ["/api/contact-batches/preview", "/api/contact-batches"].includes(url.pathname)) {
    assertRecruitingOperator(currentUser);
    const body = await readJson(request);
    const actionKind = contactActionKind(body.actionKind);
    const stateIds = Array.isArray(body.stateIds) ? body.stateIds.map(item => text(item, "stateId")) : [];
    const templateVersionId = optionalText(body.templateVersionId, "templateVersionId");
    if (actionKind === 'message' && !templateVersionId) throw new Error("templateVersionId is required.");
    const prepared = await batchPreviews(currentUser, { stateIds, actionKind, templateVersionId });
    if (url.pathname.endsWith('/preview')) {
      send(response, 200, { previews: prepared.map(item => ({ preview: { ...item.context, sourceLocator: undefined }, readiness: item.readiness, approval: item.approval ? { token: item.approval.token, expiresAt: item.approval.approval.expiresAt } : null })), realContact: realGreetingEnabled(), dispatchMode: contactDispatchMode });
      return;
    }
    if (contactDispatchMode === 'disabled' || (contactDispatchMode === 'real' && !realGreetingEnabled())) throw new Error("真实联系配置不完整，请先到联系设置开启发送。");
    if (realGreetingEnabled() && body.confirmRealContact !== true) throw new Error("confirmRealContact is required after reviewing every recipient and message.");
    const tokens = body.tokens && typeof body.tokens === 'object' && !Array.isArray(body.tokens) ? body.tokens as Record<string, unknown> : {};
    const batchId = text(body.batchId, 'batchId');
    if (!/^[0-9a-f-]{36}$/i.test(batchId)) throw new Error('batchId must be a UUID.');
    const intervalSeconds = integer(body.intervalSeconds, 'intervalSeconds');
    if (intervalSeconds < 10 || intervalSeconds > 600) throw new Error('联系启动间隔必须为 10–600 秒。');
    const verified = prepared.map(item => {
      if (!item.readiness.ready) throw new Error(`暂不能联系 ${item.context.candidateName}：${item.readiness.reasons.join('、')}`);
      const token = realGreetingEnabled() ? text(tokens[item.context.candidateStateId], 'contactPreviewApprovalToken') : null;
      return { ...item, realApproval: token ? { token, approval: verifyContactPreviewApproval({ token, signingKey: contactPreviewApprovalSigningKeyFromEnvironment(process.env), expected: item.context, now: new Date() }) } : null };
    });
    const results = await withContactGlobalFence(async () => {
      const created = [];
      for (const item of verified) {
        try {
          const context = item.context;
          const now = new Date();
          const intent = await m2Repository.createManualContactIntent({ stateId: context.candidateStateId, actionKind,
            idempotencyKey: item.realApproval ? contactPreviewApprovalIdempotencyKey(actionKind, item.realApproval.approval.approvalId) : `batch:${batchId}:${context.candidateStateId}`,
            templateVersionId: context.templateVersionId, providerJobId: context.providerJobId, providerGreetingId: context.providerGreetingId,
            renderedMessage: context.renderedMessage, createdBy: currentUser.userId, localMinuteOfDay: shanghaiMinuteOfDay(now), now: now.toISOString(),
            transportMode: realGreetingEnabled() ? 'real' : 'fake', intervalSeconds, ...(item.realApproval ? { realApproval: item.realApproval } : {}) });
          created.push({ stateId: context.candidateStateId, intentId: intent.id, status: intent.status });
        } catch {
          created.push({ stateId: item.context.candidateStateId, error: '候选人状态或联系设置发生变化，请刷新执行记录后重新预览。' });
          break;
        }
      }
      return created;
    });
    send(response, 201, { results, submitted: results.filter(item => !('error' in item)).length, requested: stateIds.length });
    return;
  }
  const messageTemplateMatch = url.pathname.match(
    /^\/api\/positions\/([0-9a-f-]+)\/message-template$/i
  );
  if (request.method === "POST" && messageTemplateMatch) {
    const body = await readJson(request);
    const template = await atsRepository.savePositionMessageTemplate(
      currentUser,
      messageTemplateMatch[1]!,
      text(body.body, "body"),
      optionalText(body.name, "name") ?? undefined
    );
    send(response, 201, { template });
    return;
  }
  const ruleMatch = url.pathname.match(/^\/api\/positions\/([0-9a-f-]+)\/rules$/i);
  if (request.method === "POST" && ruleMatch) {
    await atsRepository.assertPosition(currentUser, ruleMatch[1]!);
    const body = await readJson(request);
    const lifecycleStatus = optionalText(body.lifecycleStatus, "lifecycleStatus") ?? "draft";
    if (!["draft", "pending_approval", "published"].includes(lifecycleStatus)) {
      throw new Error("lifecycleStatus must be draft, pending_approval or published.");
    }
    const version = await atsRepository.createRuleDraft(currentUser, {
      positionId: ruleMatch[1]!,
      name: text(body.name, "name"),
      config: ruleConfig(body.config),
      dictionaryVersion: text(body.dictionaryVersion, "dictionaryVersion"),
      parentVersionId: optionalText(body.parentVersionId, "parentVersionId"),
      lifecycleStatus: lifecycleStatus as "draft" | "pending_approval" | "published"
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
    assertRecruitingOperator(currentUser);
    await assertWorkerRuntimeConsistent();
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
      candidateLimit: screeningCandidateLimit(body.candidateLimit),
      autoGreet: body.autoGreet === undefined ? false : boolean(body.autoGreet, "autoGreet"),
      idempotencyKey: idempotencyKey.trim(),
      positionId: text(body.positionId, "positionId"),
      source,
      searchKeyword,
      createdBy: currentUser.userId
    });
    send(response, 201, { task });
    return;
  }
  const taskCommandMatch = url.pathname.match(
    /^\/api\/tasks\/([0-9a-f-]+)\/(cancel|retry)$/i
  );
  if (request.method === "POST" && taskCommandMatch) {
    assertRecruitingOperator(currentUser);
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
      throw new Error("Idempotency-Key header is required.");
    }
    const body = await readJson(request);
    const taskId = taskCommandMatch[1]!;
    const command = taskCommandMatch[2]!.toLowerCase() as "cancel" | "retry";
    const taskAccess = await sql<Array<{ position_id: string }>>`
      SELECT position_id FROM tasks WHERE id = ${taskId}
    `;
    if (!taskAccess[0]) throw new Error("Task was not found.");
    await atsRepository.assertPosition(currentUser, taskAccess[0].position_id);
    if (command === "retry") await assertWorkerRuntimeConsistent();
    const input = {
      taskId,
      idempotencyKey: idempotencyKey.trim(),
      expectedVersion: integer(body.expectedVersion, "expectedVersion"),
      actorId: currentUser.userId
    };
    const task = await withContactGlobalFence(() =>
      command === "cancel"
        ? repository.cancelTask(input)
        : repository.retryTask(input)
    );
    send(response, 200, { task });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/schedules") {
    assertRecruitingOperator(currentUser);
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
      candidateLimit: screeningCandidateLimit(body.candidateLimit),
      autoGreet: body.autoGreet === undefined ? false : boolean(body.autoGreet, "autoGreet"),
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
    assertRecruitingOperator(currentUser);
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
  const resumePreviewMatch = url.pathname.match(
    /^\/api\/candidate-position-states\/([0-9a-f-]+)\/resume-preview(?:\/(\d+))?$/i
  );
  if (request.method === "GET" && resumePreviewMatch) {
    const stored = await repository.getResumeScreenshot(resumePreviewMatch[1]!);
    if (!stored) { send(response, 404, { message: "候选人记录不存在。" }); return; }
    await atsRepository.assertPosition(currentUser, stored.positionId);
    if (!stored.screenshotPath) { send(response, 404, { message: "该候选人尚无简历截图。" }); return; }
    try {
      const screenshot = await resolveResumeFile(stored.screenshotPath,
        process.env.BOSS_FORGE_RESUME_SCREENSHOT_DIR?.trim() || join(homedir(), ".boss-cli", ".cache", "resume-screenshots"));
      const artifact = await readResumeArtifact(screenshot);
      const captureId = createHash("sha256").update(screenshot).digest("hex").slice(0, 24);
      if (url.searchParams.has("capture") && url.searchParams.get("capture") !== captureId) {
        send(response, 409, { message: "简历已更新，请重新加载预览。" }); return;
      }
      if (resumePreviewMatch[2] !== undefined) {
        const index = Number(resumePreviewMatch[2]);
        if (!Number.isSafeInteger(index) || !artifact.parts[index]) { send(response, 404, { message: "简历截图分段不存在。" }); return; }
        sendPng(response, await readResumePart(screenshot, artifact, index));
      } else {
        // Do not advertise a complete résumé when one of its files is missing.
        for (let index = 0; index < artifact.parts.length; index++) await readResumePart(screenshot, artifact, index);
        send(response, 200, {
          captureId, complete: artifact.complete, capturedAt: artifact.capturedAt,
          contentHeight: artifact.contentHeight,
          parts: artifact.parts.map((part, index) => ({ index, width: part.width, height: part.height, overlapTop: part.overlapTop, cssHeight: part.cssHeight }))
        });
      }
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      send(response, missing ? 404 : 409, { message: missing ? "简历文件暂不可用，请重新读取简历。" : "简历截图不完整或无法读取，请重新读取简历。" });
    }
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
    assertRecruitingOperator(currentUser);
    await assertWorkerRuntimeConsistent();
    const body = await readJson(request);
    const candidate = await repository.getCandidateDetail(resumeScreeningMatch[1]!);
    if (!candidate) throw new Error("Candidate state was not found.");
    await atsRepository.assertPosition(currentUser, candidate.positionId);
    await withContactGlobalFence(() =>
      repository.requeueResumeScreening(
        resumeScreeningMatch[1]!,
        currentUser.userId
      )
    );
    send(response, 202, { queued: true });
    return;
  }
  const previewMatch = url.pathname.match(
    /^\/api\/candidate-position-states\/([0-9a-f-]+)\/(message|greet)-preview$/i
  );
  if (request.method === "GET" && previewMatch) {
    const actionKind: ContactActionKind =
      previewMatch[2]?.toLowerCase() === "greet" ? "greet" : "message";
    const candidate = await repository.getCandidateDetail(previewMatch[1]!);
    if (!candidate) throw new Error("Candidate state was not found.");
    await atsRepository.assertPosition(currentUser, candidate.positionId);
    const now = new Date();
    if (actionKind === "greet") {
      const [target, readiness] = await Promise.all([
        m2Repository.previewContactTarget(previewMatch[1]!),
        m2Repository.previewContactReadiness({
          stateId: previewMatch[1]!,
          actionKind,
          now: now.toISOString(),
          localMinuteOfDay: shanghaiMinuteOfDay(now)
        })
      ]);
      let greeting: BossGreetingPreview;
      try {
        greeting = await readExactBossGreeting(target);
      } catch {
        send(response, 409, {
          error: "greet_exact_content_unavailable",
          actionKind,
          message:
            "当前岗位没有可唯一核验的 BOSS 岗位招呼语，或登录状态暂不可用；系统未签发许可，也未创建任务。",
          preview: null,
          approval: null,
          readiness: {
            ...readiness,
            ready: false,
            reasons: [...new Set([...readiness.reasons, "greet_exact_content_unavailable"])],
            contactDispatchMode,
            sideEffectsMode: sideEffectsMode()
          }
        });
        return;
      }
      const sourceLocator = realGreetingEnabled()
        ? requiredContactSourceLocator(target.sourceLocator)
        : target.sourceLocator;
      const issuedApproval = realGreetingEnabled()
        ? issueContactPreviewApproval({
            context: {
              actionKind,
              approvedBy: currentUser.userId,
              candidateStateId: target.candidateStateId,
              candidateId: target.candidateId,
              candidateName: target.candidateName,
              positionId: target.positionId,
              positionName: target.positionName,
              taskId: target.taskId,
              bossAccountId: target.bossAccountId,
              source: target.source,
              sourceLocator: requiredContactSourceLocator(sourceLocator),
              templateVersionId: null,
              providerJobId: greeting.jobId,
              providerGreetingId: greeting.greetingId,
              renderedMessage: greeting.body
            },
            signingKey: contactPreviewApprovalSigningKeyFromEnvironment(process.env),
            now
          })
        : null;
      send(response, 200, {
        preview: {
          actionKind,
          templateVersionId: null,
          providerJobId: greeting.jobId,
          providerJobName: greeting.jobName,
          providerGreetingId: greeting.greetingId,
          body: greeting.body,
          renderedMessage: greeting.body,
          renderedMessageSha256: contactMessageSha256(greeting.body),
          candidateStateId: target.candidateStateId,
          candidateId: target.candidateId,
          candidateName: target.candidateName,
          positionId: target.positionId,
          positionName: target.positionName,
          taskId: target.taskId,
          bossAccountId: target.bossAccountId,
          source: target.source,
          sourceLocatorHint: maskedContactSourceLocator(target.sourceLocator),
          sourceLocatorSha256: target.sourceLocator
            ? contactSourceLocatorSha256(target.sourceLocator)
            : null,
          reviewStatus: target.reviewStatus,
          contactStatus: target.contactStatus
        },
        approval: issuedApproval
          ? {
              actionKind: issuedApproval.approval.actionKind,
              token: issuedApproval.token,
              approvalId: issuedApproval.approval.approvalId,
              issuedAt: issuedApproval.approval.issuedAt,
              expiresAt: issuedApproval.approval.expiresAt,
              renderedMessageSha256: issuedApproval.approval.renderedMessageSha256
            }
          : null,
        readiness: {
          ...readiness,
          contactDispatchMode,
          sideEffectsMode: sideEffectsMode()
        }
      });
      return;
    }
    const [preview, readiness] = await Promise.all([
      m2Repository.previewMessage(previewMatch[1]!, url.searchParams.get("templateVersionId"), currentUser.displayName),
      m2Repository.previewContactReadiness({
        stateId: previewMatch[1]!,
        actionKind,
        now: now.toISOString(),
        localMinuteOfDay: shanghaiMinuteOfDay(now)
      })
    ]);
    const sourceLocator = realGreetingEnabled()
      ? requiredContactSourceLocator(preview.sourceLocator)
      : preview.sourceLocator;
    const issuedApproval = realGreetingEnabled()
      ? issueContactPreviewApproval({
          context: {
            actionKind,
            approvedBy: currentUser.userId,
            candidateStateId: preview.candidateStateId,
            candidateId: preview.candidateId,
            candidateName: preview.candidateName,
            positionId: preview.positionId,
            positionName: preview.positionName,
            taskId: preview.taskId,
            bossAccountId: preview.bossAccountId,
            source: preview.source,
            sourceLocator: requiredContactSourceLocator(sourceLocator),
            templateVersionId: preview.templateVersionId,
            providerJobId: null,
            providerGreetingId: null,
            renderedMessage: preview.renderedMessage
          },
          signingKey: contactPreviewApprovalSigningKeyFromEnvironment(process.env),
          now
        })
      : null;
    send(response, 200, {
      preview: {
        actionKind,
        templateVersionId: preview.templateVersionId,
        providerJobId: null,
        providerGreetingId: null,
        templateVersion: preview.templateVersion,
        body: preview.body,
        renderedMessage: preview.renderedMessage,
        renderedMessageSha256: contactMessageSha256(preview.renderedMessage),
        candidateStateId: preview.candidateStateId,
        candidateId: preview.candidateId,
        candidateName: preview.candidateName,
        positionId: preview.positionId,
        positionName: preview.positionName,
        taskId: preview.taskId,
        bossAccountId: preview.bossAccountId,
        source: preview.source,
        sourceLocatorHint: maskedContactSourceLocator(preview.sourceLocator),
        sourceLocatorSha256: preview.sourceLocator
          ? contactSourceLocatorSha256(preview.sourceLocator)
          : null,
        reviewStatus: preview.reviewStatus,
        contactStatus: preview.contactStatus
      },
      approval: issuedApproval
        ? {
            actionKind: issuedApproval.approval.actionKind,
            token: issuedApproval.token,
            approvalId: issuedApproval.approval.approvalId,
            issuedAt: issuedApproval.approval.issuedAt,
            expiresAt: issuedApproval.approval.expiresAt,
            renderedMessageSha256: issuedApproval.approval.renderedMessageSha256
          }
        : null,
      readiness: {
        ...readiness,
        contactDispatchMode,
        sideEffectsMode: sideEffectsMode()
      }
    });
    return;
  }
  const contactMatch = url.pathname.match(
    /^\/api\/candidate-position-states\/([0-9a-f-]+)\/contact-intents$/i
  );
  if (request.method === "POST" && contactMatch) {
    assertRecruitingOperator(currentUser);
    if (contactDispatchMode === "disabled") {
      throw new Error(
        "联系发送处理程序未启动；当前只能预览消息，不能创建联系任务。"
      );
    }
    if (contactDispatchMode === "real" && !realGreetingEnabled()) {
      throw new Error(
        "真实联系配置不完整；发送总闸未同时开启，系统未创建任何联系任务。"
      );
    }
    const body = await readJson(request);
    const actionKind = contactActionKind(body.actionKind);
    const realContact = realGreetingEnabled();
    if (realContact && body.confirmRealContact !== true) {
      throw new Error(
        "confirmRealContact must be true after the user reviews the final message preview."
      );
    }
    const candidate = await repository.getCandidateDetail(contactMatch[1]!);
    if (!candidate) throw new Error("Candidate state was not found.");
    await atsRepository.assertPosition(currentUser, candidate.positionId);
    await atsRepository.assertCandidateContactable(currentUser, contactMatch[1]!);
    if (actionKind === "greet") {
      const target = await m2Repository.previewContactTarget(contactMatch[1]!);
      let greeting: BossGreetingPreview;
      try {
        greeting = await readExactBossGreeting(target);
      } catch {
        send(response, 409, {
          error: "greet_exact_content_unavailable",
          actionKind,
          message:
            "当前岗位没有可唯一核验的 BOSS 岗位招呼语，或登录状态暂不可用；系统已阻止创建打招呼任务。"
        });
        return;
      }
      if (
        body.templateVersionId !== null ||
        text(body.providerJobId, "providerJobId") !== greeting.jobId ||
        text(body.providerGreetingId, "providerGreetingId") !== greeting.greetingId ||
        sha256Hex(body.renderedMessageSha256, "renderedMessageSha256") !==
          contactMessageSha256(greeting.body)
      ) {
        send(response, 409, {
          error: "greet_preview_changed",
          actionKind,
          message: "岗位招呼语配置已变化，请重新预览后再次确认。"
        });
        return;
      }
      const now = new Date();
      const realApprovalToken = realContact
        ? text(body.contactPreviewApprovalToken, "contactPreviewApprovalToken")
        : undefined;
      const verifiedRealApproval = realApprovalToken
        ? verifyContactPreviewApproval({
            token: realApprovalToken,
            signingKey: contactPreviewApprovalSigningKeyFromEnvironment(process.env),
            expected: {
              actionKind,
              approvedBy: currentUser.userId,
              candidateStateId: target.candidateStateId,
              candidateId: target.candidateId,
              candidateName: target.candidateName,
              positionId: target.positionId,
              positionName: target.positionName,
              taskId: target.taskId,
              bossAccountId: target.bossAccountId,
              source: target.source,
              sourceLocator: requiredContactSourceLocator(target.sourceLocator),
              templateVersionId: null,
              providerJobId: greeting.jobId,
              providerGreetingId: greeting.greetingId,
              renderedMessage: greeting.body
            },
            now
          })
        : undefined;
      const requestIdempotencyKey = request.headers["idempotency-key"];
      if (
        !realContact &&
        (typeof requestIdempotencyKey !== "string" || !requestIdempotencyKey.trim())
      ) {
        throw new Error("Idempotency-Key header is required.");
      }
      const idempotencyKey = verifiedRealApproval
        ? contactPreviewApprovalIdempotencyKey(actionKind, verifiedRealApproval.approvalId)
        : (requestIdempotencyKey as string).trim();
      const intent = await m2Repository.createManualContactIntent({
        stateId: contactMatch[1]!,
        intervalSeconds: body.intervalSeconds === undefined ? 10 : integer(body.intervalSeconds, "intervalSeconds"),
        actionKind,
        idempotencyKey,
        templateVersionId: null,
        providerJobId: greeting.jobId,
        providerGreetingId: greeting.greetingId,
        renderedMessage: greeting.body,
        createdBy: currentUser.userId,
        localMinuteOfDay: shanghaiMinuteOfDay(now),
        now: now.toISOString(),
        transportMode: realContact ? "real" : "fake",
        ...(realApprovalToken && verifiedRealApproval
          ? { realApproval: { token: realApprovalToken, approval: verifiedRealApproval } }
          : {})
      });
      send(response, 201, { intent, actionKind, realGreetingEnabled: realContact });
      return;
    }
    const requestedVersionId = text(body.templateVersionId, "templateVersionId");
    const preview = await m2Repository.previewMessage(contactMatch[1]!, requestedVersionId, currentUser.displayName);
    if (requestedVersionId !== preview.templateVersionId) {
      throw new Error("templateVersionId is no longer active; refresh the preview.");
    }
    if (!preview.renderedMessage.trim() || preview.renderedMessage.length > 500) {
      throw new Error("Rendered message must contain 1 to 500 characters.");
    }
    const now = new Date();
    const realApprovalToken = realContact
      ? text(body.contactPreviewApprovalToken, "contactPreviewApprovalToken")
      : undefined;
    const verifiedRealApproval = realApprovalToken
      ? verifyContactPreviewApproval({
          token: realApprovalToken,
          signingKey: contactPreviewApprovalSigningKeyFromEnvironment(process.env),
          expected: {
            actionKind,
            approvedBy: currentUser.userId,
            candidateStateId: preview.candidateStateId,
            candidateId: preview.candidateId,
            candidateName: preview.candidateName,
            positionId: preview.positionId,
            positionName: preview.positionName,
            taskId: preview.taskId,
            bossAccountId: preview.bossAccountId,
            source: preview.source,
            sourceLocator: requiredContactSourceLocator(preview.sourceLocator),
            templateVersionId: preview.templateVersionId,
            providerJobId: null,
            providerGreetingId: null,
            renderedMessage: preview.renderedMessage
          },
          now
        })
      : undefined;
    const requestIdempotencyKey = request.headers["idempotency-key"];
    if (
      !realContact &&
      (typeof requestIdempotencyKey !== "string" || !requestIdempotencyKey.trim())
    ) {
      throw new Error("Idempotency-Key header is required.");
    }
    const idempotencyKey = verifiedRealApproval
      ? contactPreviewApprovalIdempotencyKey(actionKind, verifiedRealApproval.approvalId)
      : (requestIdempotencyKey as string).trim();
    const intent = await m2Repository.createManualContactIntent({
      stateId: contactMatch[1]!,
      intervalSeconds: body.intervalSeconds === undefined ? 10 : integer(body.intervalSeconds, "intervalSeconds"),
      actionKind,
      idempotencyKey,
      templateVersionId: preview.templateVersionId,
      providerJobId: null,
      providerGreetingId: null,
      renderedMessage: preview.renderedMessage,
      createdBy: currentUser.userId,
      localMinuteOfDay: shanghaiMinuteOfDay(now),
      now: now.toISOString(),
      transportMode: realContact ? "real" : "fake",
      ...(realApprovalToken && verifiedRealApproval
        ? { realApproval: { token: realApprovalToken, approval: verifiedRealApproval } }
        : {})
    });
    send(response, 201, { intent, actionKind, realGreetingEnabled: realContact });
    return;
  }
  const verifyContactNotSentMatch = url.pathname.match(
    /^\/api\/contact-intents\/([0-9a-f-]+)\/verify-not-sent$/i
  );
  if (request.method === "POST" && verifyContactNotSentMatch) {
    assertManager(currentUser);
    const body = await readJson(request);
    const accessRows = await sql<Array<{ candidate_position_state_id: string }>>`
      SELECT candidate_position_state_id
      FROM contact_intents
      WHERE id = ${verifyContactNotSentMatch[1]!}
    `;
    const stateId = accessRows[0]?.candidate_position_state_id;
    if (!stateId) throw new Error("Contact intent was not found.");
    const candidate = await repository.getCandidateDetail(stateId);
    if (!candidate) throw new Error("Candidate state was not found.");
    await atsRepository.assertPosition(currentUser, candidate.positionId);
    const intent = await m2Repository.resolveUncertainContactAsNotSent({
      intentId: verifyContactNotSentMatch[1]!,
      actorId: currentUser.userId,
      expectedVersion: integer(body.expectedVersion, "expectedVersion"),
      actionKind: contactActionKind(body.actionKind),
      candidateStateId: text(body.candidateStateId, "candidateStateId"),
      candidateId: text(body.candidateId, "candidateId"),
      candidateName: text(body.candidateName, "candidateName"),
      taskId: text(body.taskId, "taskId"),
      bossAccountId: text(body.bossAccountId, "bossAccountId"),
      templateVersionId: nullableAttestationText(
        body.templateVersionId,
        "templateVersionId"
      ),
      providerJobId: nullableAttestationText(body.providerJobId, "providerJobId"),
      providerGreetingId: nullableAttestationText(
        body.providerGreetingId,
        "providerGreetingId"
      ),
      renderedMessageSha256: sha256Hex(
        body.renderedMessageSha256,
        "renderedMessageSha256"
      ),
      sourceLocatorSha256: sha256Hex(body.sourceLocatorSha256, "sourceLocatorSha256")
    });
    send(response, 200, { intent });
    return;
  }
  const reviewMatch = url.pathname.match(
    /^\/api\/candidate-position-states\/([0-9a-f-]+)\/reviews$/i
  );
  if (request.method === "POST" && reviewMatch) {
    assertRecruitingOperator(currentUser);
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
    const note = optionalText(body.note, "note") ?? "";
    if (
      decision === "approved" &&
      (candidate.ruleDecision !== "matched" || (candidate.assessment && (candidate.assessment.status !== "completed" || candidate.assessment.result?.recommendation === "below_threshold"))) &&
      (!note || !correctionCode)
    ) {
      throw new Error(
        "note and correctionCode are required when human review overrides the machine decision."
      );
    }
    const review = await withContactGlobalFence(() =>
      repository.reviewCandidate({
        stateId: reviewMatch[1]!,
        idempotencyKey: idempotencyKey.trim(),
        decision,
        note,
        correctionCode,
        reviewerId: currentUser.userId,
        expectedVersion: integer(body.expectedVersion, "expectedVersion")
      })
    );
    send(response, 201, { review });
    return;
  }
  send(response, 404, { error: "not_found" });
}

const server = createServer((request, response) => {
  void route(request, response).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const status =
      error instanceof AuthenticationError
        ? 401
        : error instanceof AuthorizationError
          ? 403
          : error instanceof SynonymModelUnavailableError ||
              error instanceof ContactPreviewApprovalConfigurationError ||
              message.includes("真实联系配置不完整")
            ? 503
            : error instanceof OptimisticLockError ||
                error instanceof ContactPreviewApprovalError
              ? 409
              : message === "Invalid integration token."
                ? 401
                : message.includes("policy blocked") ||
                    message.includes("当前版本未提供真实联系能力") ||
                    message.includes("version conflict") ||
                    message.includes("runtime mismatch") ||
                    message.includes("cannot be cancelled") ||
                    message.includes("cannot be retried") ||
                    message.includes("旧任务的候选人数超过") ||
                    message.includes("Idempotency-Key is already used")
                  ? 409
                  : message.includes("not found")
                    ? 404
                    : error instanceof ScreeningLimitError || message.includes("required") ||
                        message.includes("must") ||
                        message.includes("exceeds") ||
                        message.includes("只允许试运行")
                      ? 400
                      : 500;
    const code =
      error instanceof AuthenticationError
        ? "unauthorized"
        : error instanceof AuthorizationError
          ? "forbidden"
          : error instanceof SynonymModelUnavailableError
            ? "model_unavailable"
            : error instanceof ContactPreviewApprovalConfigurationError
              ? "configuration_unavailable"
              : status === 503
                ? "configuration_unavailable"
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

let assessmentBusy = false;
let assessmentStopping = false;
const assessmentTimer = setInterval(() => {
  if (assessmentBusy || assessmentStopping) return;
  assessmentBusy = true;
  void recruitmentRepository.processOne().catch(() => {
    console.error(JSON.stringify({ event: "recruitment.queue.error", message: "AI queue unavailable" }));
  }).finally(() => { assessmentBusy = false; });
}, 3000);
assessmentTimer.unref();

async function stop(): Promise<void> {
  assessmentStopping = true;
  clearInterval(assessmentTimer);
  server.close();
  await sql.end();
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
