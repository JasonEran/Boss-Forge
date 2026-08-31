import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  BossForgeRepository,
  M2Repository,
  OptimisticLockError,
  createDatabase,
  type RuleConfig
} from "@boss-forge/data";

const host = process.env.CONTROL_API_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.CONTROL_API_PORT ?? "3100");
const webOrigin = process.env.CONTROL_WEB_ORIGIN?.trim() || "http://localhost:3000";
const sql = createDatabase();
const repository = new BossForgeRepository(sql);
const m2Repository = new M2Repository(sql);

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
  if (!value || typeof value !== "object") throw new Error("config is required.");
  const capabilities = (value as JsonObject).requiredCapabilities;
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    throw new Error("config.requiredCapabilities must not be empty.");
  }
  const parsed = capabilities.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Invalid capability rule.");
    const capability = (item as JsonObject).capability;
    const minimumConfidence = (item as JsonObject).minimumConfidence;
    if (capability !== "tem8") throw new Error("M1 currently supports only the tem8 capability.");
    if (
      typeof minimumConfidence !== "number" ||
      minimumConfidence < 0 ||
      minimumConfidence > 1
    ) {
      throw new Error("minimumConfidence must be between 0 and 1.");
    }
    return { capability: "tem8" as const, minimumConfidence };
  });
  return { requiredCapabilities: parsed };
}

async function readJson(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 64 * 1024) throw new Error("Request body exceeds 64 KiB.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("JSON body must be an object.");
  }
  return value as JsonObject;
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": webOrigin,
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,idempotency-key",
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
  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    const [dashboard, schedules, contactIntents, auditLogs] = await Promise.all([
      repository.getDashboard(),
      m2Repository.listSchedules(),
      m2Repository.listContactIntents(),
      m2Repository.listAuditLogs()
    ]);
    send(response, 200, { ...dashboard, schedules, contactIntents, auditLogs });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/positions") {
    send(response, 200, { positions: await repository.listPositions() });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/positions") {
    const body = await readJson(request);
    const position = await repository.createPosition({
      bossAccountId: text(body.bossAccountId, "bossAccountId"),
      name: text(body.name, "name"),
      bossJobKeyword: optionalText(body.bossJobKeyword, "bossJobKeyword"),
      ownerName: text(body.ownerName, "ownerName")
    });
    send(response, 201, { position });
    return;
  }
  const ruleMatch = url.pathname.match(/^\/api\/positions\/([0-9a-f-]+)\/rules$/i);
  if (request.method === "POST" && ruleMatch) {
    const body = await readJson(request);
    const version = await repository.createRuleVersion({
      positionId: ruleMatch[1]!,
      name: text(body.name, "name"),
      config: ruleConfig(body.config),
      dictionaryVersion: text(body.dictionaryVersion, "dictionaryVersion"),
      createdBy: text(body.createdBy, "createdBy")
    });
    send(response, 201, { version });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/tasks") {
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
      throw new Error("Idempotency-Key header is required.");
    }
    const body = await readJson(request);
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
      createdBy: text(body.createdBy, "createdBy")
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
      createdBy: text(body.createdBy, "createdBy")
    });
    send(response, 201, { schedule });
    return;
  }
  const cancelScheduleMatch = url.pathname.match(/^\/api\/schedules\/([0-9a-f-]+)\/cancel$/i);
  if (request.method === "POST" && cancelScheduleMatch) {
    const body = await readJson(request);
    const schedule = await m2Repository.cancelSchedule({
      scheduleId: cancelScheduleMatch[1]!,
      expectedVersion: integer(body.expectedVersion, "expectedVersion"),
      actorId: text(body.actorId, "actorId")
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
    send(response, 200, { candidate });
    return;
  }
  const resumeScreeningMatch = url.pathname.match(
    /^\/api\/candidate-position-states\/([0-9a-f-]+)\/resume-screenings$/i
  );
  if (request.method === "POST" && resumeScreeningMatch) {
    const body = await readJson(request);
    await repository.requeueResumeScreening(
      resumeScreeningMatch[1]!,
      text(body.actorId, "actorId")
    );
    send(response, 202, { queued: true });
    return;
  }
  const previewMatch = url.pathname.match(
    /^\/api\/candidate-position-states\/([0-9a-f-]+)\/message-preview$/i
  );
  if (request.method === "GET" && previewMatch) {
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
      createdBy: text(body.createdBy, "createdBy"),
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
      reviewerId: text(body.reviewerId, "reviewerId"),
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
      error instanceof OptimisticLockError
        ? 409
        : message.includes("policy blocked") || message.includes("version conflict")
          ? 409
          : message.includes("not found")
            ? 404
            : message.includes("required") || message.includes("must")
              ? 400
              : 500;
    const code =
      error instanceof OptimisticLockError
        ? "version_conflict"
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

server.listen(port, host, () => {
  console.log(JSON.stringify({ event: "control_api.ready", host, port, webOrigin }));
});

async function stop(): Promise<void> {
  server.close();
  await sql.end();
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
