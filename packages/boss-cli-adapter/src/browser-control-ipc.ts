import {bossChatAttachmentSchema, type BossChatAttachment} from '@boss-forge/contracts';
import { bossChatOnlineResumeSchema, type BossChatOnlineResume, bossChatInboxSchema, bossChatSnapshotSchema, bossChatTargetSchema, type BossChatInbox, type BossChatSnapshot } from '@boss-forge/contracts';
import { bossJobCatalogSchema, bossFilterOptionsSnapshotSchema, type BossFilterOptionsSnapshot, type BossJobCatalog } from "@boss-forge/contracts";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { parseBossGreetingPreview, type BossGreetingPreview } from "./greeting-preview.js";

const IPC_SCHEMA_VERSION = 1 as const;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 40_000;
export const BOSS_BROWSER_CONTROL_SOCKET_NAME = "browser-control.sock";

export type BossBrowserControlErrorCode =
  | "resume_limited"
  | "mode_inactive"
  | "busy"
  | "not_authenticated"
  | "greeting_not_configured"
  | "greeting_save_rejected"
  | "greeting_unavailable"
  | "unavailable";

export class BossBrowserControlError extends Error {
  readonly code: BossBrowserControlErrorCode;

  constructor(code: BossBrowserControlErrorCode, message: string) {
    super(message);
    this.name = "BossBrowserControlError";
    this.code = code;
  }
}

type GreetingPreviewRequest = {
  schemaVersion: typeof IPC_SCHEMA_VERSION;
  requestId: string;
  accountId: string;
  jobKeyword?: string;
  bossJobId?: string;
  body?: string;
  geekIds?: string[];
  geekId?: string;
  outgoingId?: string;
  actionId?: string;
  leaseId?: string;
};

type GreetingPreviewResponse =
  | {
      schemaVersion: typeof IPC_SCHEMA_VERSION;
      requestId: string;
      ok: true;
      preview?: BossGreetingPreview;
      catalog?: BossJobCatalog;
      filterOptions?: BossFilterOptionsSnapshot;
      chatInbox?: BossChatInbox;
      chatSnapshot?: BossChatSnapshot;
      onlineResume?: BossChatOnlineResume;
      delivery?: { messageId: string };
      wechatDelivery?: { actionId: string };
    }
  | {
      schemaVersion: typeof IPC_SCHEMA_VERSION;
      requestId: string;
      ok: false;
      error: BossBrowserControlErrorCode;
    };

function exactObjectKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join("\u0000") === expected.sort().join("\u0000");
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(value);
}

function validAccountId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._-]+$/u.test(value)
  );
}

function validJobKeyword(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= 256;
}

function parseRequest(value: unknown, kind: 'positions' | 'filter-options' | 'greeting-preview' | 'greeting-save' | 'chat-inbox' | 'chat-read' | 'chat-attachment' | 'chat-resume' | 'chat-send' | 'chat-wechat'): GreetingPreviewRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BossBrowserControlError("unavailable", "Invalid browser-control request.");
  }
  const item = value as Record<string, unknown>;
  const chat = kind.startsWith('chat-');
  const expected = ['schemaVersion', 'requestId', 'accountId', ...(chat ? ['leaseId'] : []), ...(kind === 'chat-inbox' ? ['geekIds'] : ['chat-read', 'chat-attachment', 'chat-resume'].includes(kind) ? ['geekId'] : kind === 'chat-send' ? ['outgoingId'] : kind === 'chat-wechat' ? ['actionId'] : []), ...(!chat && kind !== 'positions' ? ['jobKeyword'] : []), ...(['filter-options', 'greeting-save'].includes(kind) ? ['bossJobId'] : []), ...(kind === 'greeting-save' ? ['body'] : [])];
  if (
    !exactObjectKeys(item, expected) ||
    item.schemaVersion !== IPC_SCHEMA_VERSION ||
    !validRequestId(item.requestId) ||
    !validAccountId(item.accountId) ||
    (chat && !validRequestId(item.leaseId)) ||
    (!chat && kind !== 'positions' && !validJobKeyword(item.jobKeyword)) ||
    (kind === 'chat-inbox' && (!Array.isArray(item.geekIds) || item.geekIds.length > 200 || !item.geekIds.every(id => bossChatTargetSchema.safeParse(id).success))) ||
    (['chat-read', 'chat-attachment', 'chat-resume'].includes(kind) && !bossChatTargetSchema.safeParse(item.geekId).success) ||
    (kind === 'chat-send' && !validRequestId(item.outgoingId)) ||
    (kind === 'chat-wechat' && !validRequestId(item.actionId)) ||
    (['filter-options', 'greeting-save'].includes(kind) && !validJobKeyword(item.bossJobId)) ||
    (kind === 'greeting-save' && (typeof item.body !== 'string' || item.body.length < 2 || item.body.length > 100 || item.body !== item.body.trim() || /\{\{/.test(item.body)))
  ) {
    throw new BossBrowserControlError("unavailable", "Invalid browser-control request.");
  }
  return item as GreetingPreviewRequest;
}

function safeErrorCode(error: unknown): BossBrowserControlErrorCode {
  return error instanceof BossBrowserControlError ? error.code : "unavailable";
}

function writeJsonResponse(
  response: import("node:http").ServerResponse,
  status: number,
  payload: GreetingPreviewResponse | { ok: false; error: BossBrowserControlErrorCode }
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

async function readRequestBody(
  request: import("node:http").IncomingMessage
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_REQUEST_BYTES) {
      throw new BossBrowserControlError("unavailable", "Browser-control request is too large.");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    throw new BossBrowserControlError("unavailable", "Browser-control request is empty.");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error: unknown) {
    throw new BossBrowserControlError("unavailable", "Browser-control request is invalid JSON.");
  }
}

async function socketIsLive(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const request = httpRequest(
      { socketPath, path: "/health", method: "GET", timeout: 500 },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      }
    );
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(false));
    request.end();
  });
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(socketPath);
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (!info.isSocket()) {
    throw new Error(`Browser-control path exists and is not a socket: ${socketPath}`);
  }
  if (await socketIsLive(socketPath)) {
    throw new Error(`Another browser-control supervisor is already listening: ${socketPath}`);
  }
  await unlink(socketPath);
}

export type BossBrowserControlServer = {
  socketPath: string;
  close(): Promise<void>;
};

export async function startBossBrowserControlServer(input: {
  socketPath: string;
  accountId: string;
  positions?(): Promise<BossJobCatalog>;
  chatInbox?(geekIds: string[], leaseId: string): Promise<BossChatInbox>;
  chatAttachment?(geekId: string, leaseId: string): Promise<BossChatAttachment>;
  chatResume?(geekId: string, leaseId: string): Promise<BossChatOnlineResume>;
  chatRead?(geekId: string, leaseId: string): Promise<BossChatSnapshot>;
  chatSend?(outgoingId: string, leaseId: string): Promise<{ messageId: string }>;
  chatWechat?(actionId: string, leaseId: string): Promise<{actionId: string}>;
  filterOptions?(request: { bossJobId: string; jobKeyword: string }): Promise<BossFilterOptionsSnapshot>;
  greetingSave?(request: { bossJobId: string; body: string }): Promise<BossGreetingPreview>;
  greetingPreview(request: {
    requestId: string;
    accountId: string;
    jobKeyword: string;
  }): Promise<BossGreetingPreview>;
}): Promise<BossBrowserControlServer> {
  if (!validAccountId(input.accountId)) throw new Error("Invalid browser-control accountId.");
  await prepareSocketPath(input.socketPath);
  let activeRequest = false;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (request.method !== "POST" || !["/v1/greeting-preview", "/v1/greeting-save", "/v1/positions", "/v1/filter-options", "/v1/chat-inbox", "/v1/chat-read", "/v1/chat-resume", "/v1/chat-attachment", "/v1/chat-send", "/v1/chat-wechat"].includes(request.url ?? "")) {
        writeJsonResponse(response, 404, { ok: false, error: "unavailable" });
        return;
      }
      let parsed: GreetingPreviewRequest | null = null;
      let ownsActiveRequest = false;
      try {
        const positions = request.url === "/v1/positions";
        const filterOptions = request.url === '/v1/filter-options';
        const greetingSave = request.url === '/v1/greeting-save';
        const chatKind = request.url?.startsWith('/v1/chat-') ? request.url.slice(4) as 'chat-inbox' | 'chat-read' | 'chat-attachment' | 'chat-resume' | 'chat-send' | 'chat-wechat' : null;
        parsed = parseRequest(await readRequestBody(request), chatKind ?? (positions ? 'positions' : filterOptions ? 'filter-options' : greetingSave ? 'greeting-save' : 'greeting-preview'));
        if (parsed.accountId !== input.accountId) {
          throw new BossBrowserControlError("unavailable", "Account binding mismatch.");
        }
        if (activeRequest) {
          throw new BossBrowserControlError("busy", "Browser-control is busy.");
        }
        activeRequest = true;
        ownsActiveRequest = true;
        if (greetingSave && !input.greetingSave) throw new BossBrowserControlError("unavailable", "Greeting editing is unavailable.");
        if (chatKind === 'chat-wechat' && !input.chatWechat) throw new BossBrowserControlError('unavailable', 'Wechat exchange is unavailable.');
        if (chatKind === 'chat-send' && !input.chatSend) throw new BossBrowserControlError('unavailable', 'Chat sending is unavailable.');
        const result = chatKind === 'chat-inbox' ? { chatInbox: bossChatInboxSchema.parse(await input.chatInbox?.(parsed.geekIds!, parsed.leaseId!)) }
          : chatKind === 'chat-attachment' ? { attachment: bossChatAttachmentSchema.parse(await input.chatAttachment?.(parsed.geekId!, parsed.leaseId!)) }
          : chatKind === 'chat-resume' ? { onlineResume: bossChatOnlineResumeSchema.parse(await input.chatResume?.(parsed.geekId!, parsed.leaseId!)) }
          : chatKind === 'chat-read' ? { chatSnapshot: bossChatSnapshotSchema.parse(await input.chatRead?.(parsed.geekId!, parsed.leaseId!)) }
          : chatKind === 'chat-send' ? { delivery: await input.chatSend!(parsed.outgoingId!, parsed.leaseId!) }
          : chatKind === 'chat-wechat' ? { wechatDelivery: await input.chatWechat!(parsed.actionId!, parsed.leaseId!) }
          : positions
          ? { catalog: bossJobCatalogSchema.parse(await input.positions?.()) }
          : filterOptions ? { filterOptions: bossFilterOptionsSnapshotSchema.parse(await input.filterOptions?.({ bossJobId: parsed.bossJobId!, jobKeyword: parsed.jobKeyword! })) }
          : greetingSave ? { preview: await input.greetingSave!({ bossJobId: parsed.bossJobId!, body: parsed.body! }) }
          : { preview: await input.greetingPreview({ ...parsed, jobKeyword: parsed.jobKeyword! }) };
        writeJsonResponse(response, 200, {
          schemaVersion: IPC_SCHEMA_VERSION,
          requestId: parsed.requestId,
          ok: true,
          ...result
        });
      } catch (error: unknown) {
        writeJsonResponse(response, 409, {
          schemaVersion: IPC_SCHEMA_VERSION,
          requestId: parsed?.requestId ?? "invalid",
          ok: false,
          error: safeErrorCode(error)
        });
      } finally {
        if (ownsActiveRequest) activeRequest = false;
      }
    })();
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(input.socketPath, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  await chmod(input.socketPath, 0o600);
  let closed = false;
  return {
    socketPath: input.socketPath,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      });
      await unlink(input.socketPath).catch((error: unknown) => {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      });
    }
  };
}

function parseResponse(
  value: unknown,
  requestId: string
): BossGreetingPreview {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BossBrowserControlError("unavailable", "Browser-control response is invalid.");
  }
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== IPC_SCHEMA_VERSION || item.requestId !== requestId) {
    throw new BossBrowserControlError("unavailable", "Browser-control response binding failed.");
  }
  if (item.ok === false && typeof item.error === "string") {
    const allowed = new Set<BossBrowserControlErrorCode>([
      "busy",
      "mode_inactive",
      "resume_limited",
      "not_authenticated",
      "greeting_not_configured",
      "greeting_save_rejected",
      "greeting_unavailable",
      "unavailable"
    ]);
    const code = allowed.has(item.error as BossBrowserControlErrorCode)
      ? (item.error as BossBrowserControlErrorCode)
      : "unavailable";
    throw new BossBrowserControlError(code, `Browser-control request failed: ${code}.`);
  }
  if (item.ok !== true || !("preview" in item)) {
    throw new BossBrowserControlError("unavailable", "Browser-control response is invalid.");
  }
  return parseBossGreetingPreview(JSON.stringify(item.preview));
}

export function bossBrowserControlSocketPath(runtimeDirectory: string): string {
  return join(runtimeDirectory, BOSS_BROWSER_CONTROL_SOCKET_NAME);
}

async function requestViaIpc<T>(input: {
  socketPath: string;
  accountId: string;
  jobKeyword?: string;
  bossJobId?: string;
  body?: string;
  geekIds?: string[]; geekId?: string; outgoingId?: string; actionId?: string; leaseId?: string;
  timeoutMs?: number;
}, path: string, parse: (value: unknown, requestId: string) => T): Promise<T> {
  if (!validAccountId(input.accountId)) throw new Error("Invalid browser-control accountId.");
  if (path === "/v1/greeting-preview" && !validJobKeyword(input.jobKeyword)) throw new Error("Invalid browser-control jobKeyword.");
  const requestId = randomUUID();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > (path === '/v1/chat-resume' ? 240_000 : 60_000)) {
    throw new Error("Browser-control timeoutMs must be between 100 and 60000.");
  }
  const payload: GreetingPreviewRequest = {
    schemaVersion: IPC_SCHEMA_VERSION,
    requestId,
    accountId: input.accountId,
    ...(input.jobKeyword ? { jobKeyword: input.jobKeyword } : {}),
    ...(input.bossJobId ? { bossJobId: input.bossJobId } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.geekIds ? { geekIds: input.geekIds } : {}),
    ...(input.geekId ? { geekId: input.geekId } : {}),
    ...(input.outgoingId ? { outgoingId: input.outgoingId } : {}),
    ...(input.actionId ? { actionId: input.actionId } : {}),
    ...(input.leaseId ? { leaseId: input.leaseId } : {})
  };
  return new Promise<T>((resolvePreview, reject) => {
    const request = httpRequest(
      {
        socketPath: input.socketPath,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(JSON.stringify(payload)))
        },
        timeout: timeoutMs
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > (path === '/v1/chat-inbox' ? 16 * 1024 * 1024 : MAX_RESPONSE_BYTES)) {
            request.destroy(new Error("Browser-control response exceeded the size limit."));
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          try {
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            resolvePreview(parse(parsed, requestId));
          } catch (error: unknown) {
            reject(error);
          }
        });
      }
    );
    request.once("timeout", () => {
      request.destroy(
        new BossBrowserControlError("unavailable", "Browser-control request timed out.")
      );
    });
    request.once("error", (error: unknown) => {
      reject(
        error instanceof BossBrowserControlError
          ? error
          : new BossBrowserControlError("unavailable", "Browser-control is unavailable.")
      );
    });
    request.end(JSON.stringify(payload));
  });
}

export function requestBossGreetingPreviewViaIpc(input: {
  socketPath: string; accountId: string; jobKeyword: string; timeoutMs?: number;
}): Promise<BossGreetingPreview> {
  return requestViaIpc(input, "/v1/greeting-preview", parseResponse);
}

export function requestBossPositionsViaIpc(input: {
  socketPath: string; accountId: string; timeoutMs?: number;
}): Promise<BossJobCatalog> {
  return requestViaIpc(input, "/v1/positions", (value, requestId) => {
    const item = value as Record<string, unknown> | null;
    if (!item || item.schemaVersion !== IPC_SCHEMA_VERSION || item.requestId !== requestId || item.ok !== true) {
      // Share the existing transport error validation and busy/authentication codes.
      parseResponse(value, requestId);
      throw new BossBrowserControlError("unavailable", "岗位读取失败。");
    }
    return bossJobCatalogSchema.parse(item.catalog);
  });
}

export function requestBossFilterOptionsViaIpc(input: {
  socketPath: string; accountId: string; bossJobId: string; jobKeyword: string; timeoutMs?: number;
}): Promise<BossFilterOptionsSnapshot> {
  if (!validJobKeyword(input.bossJobId) || !validJobKeyword(input.jobKeyword)) throw new Error('Invalid BOSS filter options job.');
  return requestViaIpc(input, '/v1/filter-options', (value, requestId) => {
    const item = value as Record<string, unknown> | null;
    if (!item || item.schemaVersion !== IPC_SCHEMA_VERSION || item.requestId !== requestId || item.ok !== true) {
      parseResponse(value, requestId);
      throw new BossBrowserControlError('unavailable', '筛选选项读取失败。');
    }
    const snapshot = bossFilterOptionsSnapshotSchema.parse(item.filterOptions);
    if (snapshot.bossJobId !== input.bossJobId) throw new BossBrowserControlError('unavailable', '筛选选项岗位不一致。');
    return snapshot;
  });
}

export function requestBossGreetingSaveViaIpc(input: { socketPath: string; accountId: string; bossJobId: string; jobKeyword: string; body: string; timeoutMs?: number }): Promise<BossGreetingPreview> {
  return requestViaIpc(input, "/v1/greeting-save", parseResponse);
}

function chatResponse(value: unknown, requestId: string): Record<string, unknown> {
  const item = value as Record<string, unknown> | null;
  if (!item || item.schemaVersion !== IPC_SCHEMA_VERSION || item.requestId !== requestId || item.ok !== true) {
    parseResponse(value, requestId);
    throw new BossBrowserControlError('unavailable', '聊天连接暂不可用。');
  }
  return item;
}
export function requestBossChatInboxViaIpc(input: {socketPath: string; accountId: string; leaseId: string; geekIds: string[]; timeoutMs?: number}): Promise<BossChatInbox> {
  return requestViaIpc(input, '/v1/chat-inbox', (value, id) => bossChatInboxSchema.parse(chatResponse(value, id).chatInbox));
}
export function requestBossChatReadViaIpc(input: {socketPath: string; accountId: string; leaseId: string; geekId: string; timeoutMs?: number}): Promise<BossChatSnapshot> {
  return requestViaIpc(input, '/v1/chat-read', (value, id) => {
    const result = bossChatSnapshotSchema.parse(chatResponse(value, id).chatSnapshot);
    if (result.geekId !== input.geekId) throw new BossBrowserControlError('unavailable', '聊天对象不一致。');
    return result;
  });
}
export function requestBossChatSendViaIpc(input: {socketPath: string; accountId: string; leaseId: string; outgoingId: string; timeoutMs?: number}): Promise<void> {
  return requestViaIpc(input, '/v1/chat-send', (value, id) => {
    const delivery = chatResponse(value, id).delivery as {messageId?: string} | undefined;
    if (delivery?.messageId !== input.outgoingId) throw new BossBrowserControlError('unavailable', '发送回执不一致。');
  });
}

export function requestBossWechatViaIpc(input: {socketPath:string;accountId:string;leaseId:string;actionId:string;timeoutMs?:number}):Promise<void> {
  return requestViaIpc(input,'/v1/chat-wechat',(value,id)=>{
    const receipt=chatResponse(value,id).wechatDelivery as {actionId?:string}|undefined;
    if(receipt?.actionId!==input.actionId)throw new BossBrowserControlError('unavailable','微信交换回执不一致。');
  });
}

export function requestBossChatResumeViaIpc(input: {socketPath:string; accountId:string; leaseId:string; geekId:string; timeoutMs?:number}): Promise<BossChatOnlineResume> {
  return requestViaIpc(input, '/v1/chat-resume', (value, id) => {
    const snapshot = bossChatOnlineResumeSchema.parse(chatResponse(value, id).onlineResume);
    if (snapshot.geekId !== input.geekId) throw new BossBrowserControlError('unavailable', '在线简历身份不一致。');
    return snapshot;
  });
}

export function requestBossChatAttachmentViaIpc(input: {socketPath:string;accountId:string;leaseId:string;geekId:string;timeoutMs?:number}):Promise<BossChatAttachment> {
  return requestViaIpc(input,'/v1/chat-attachment',(value,id)=>{
    const file=bossChatAttachmentSchema.parse(chatResponse(value,id).attachment);
    if(file.geekId!==input.geekId)throw new BossBrowserControlError('unavailable','附件简历身份不一致。');
    return file;
  });
}
