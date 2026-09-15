import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import type { CandidateSourceLocator } from "./boss-results.js";

const TOKEN_VERSION = 3 as const;
const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const MIN_TTL_MS = 30 * 1_000;
const MAX_TTL_MS = 10 * 60 * 1_000;
const MAX_TOKEN_BYTES = 8 * 1_024;

export type ContactPreviewApprovalContext = {
  actionKind: ContactActionKind;
  approvedBy: string;
  candidateStateId: string;
  candidateId: string;
  candidateName: string;
  positionId: string;
  positionName: string;
  taskId: string;
  bossAccountId: string;
  source: "recommend" | "search";
  sourceLocator: CandidateSourceLocator;
  templateVersionId: string | null;
  providerJobId: string | null;
  providerGreetingId: string | null;
  renderedMessage: string;
};

export type ContactActionKind = "greet" | "message";

export type ContactPreviewApproval = {
  version: typeof TOKEN_VERSION;
  approvalId: string;
  actionKind: ContactActionKind;
  approvedBy: string;
  candidateStateId: string;
  candidateId: string;
  candidateName: string;
  positionId: string;
  positionName: string;
  taskId: string;
  bossAccountId: string;
  source: "recommend" | "search";
  sourceLocatorKind: CandidateSourceLocator["kind"];
  sourceLocatorSha256: string;
  templateVersionId: string | null;
  providerJobId: string | null;
  providerGreetingId: string | null;
  renderedMessageSha256: string;
  issuedAt: string;
  expiresAt: string;
};

export type IssuedContactPreviewApproval = {
  token: string;
  approval: ContactPreviewApproval;
};

export class ContactPreviewApprovalError extends Error {
  constructor() {
    super("本次消息许可无效或已过期，请重新打开预览并再次确认。");
    this.name = "ContactPreviewApprovalError";
  }
}

export class ContactPreviewApprovalConfigurationError extends Error {
  constructor() {
    super(
      "真实联系许可签名密钥不可用；系统已阻止创建或执行真实联系任务。"
    );
    this.name = "ContactPreviewApprovalConfigurationError";
  }
}

export function contactPreviewApprovalSigningKeyFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>
): string {
  const value = environment.BOSS_FORGE_CONTACT_PREVIEW_SIGNING_KEY;
  if (!value || Buffer.byteLength(value) < 32) {
    throw new ContactPreviewApprovalConfigurationError();
  }
  return value;
}

function requiredText(value: string, field: string): string {
  if (!value.trim()) throw new Error(`${field} must not be empty.`);
  return value;
}

function signingKey(value: string | Uint8Array): string | Uint8Array {
  const bytes = typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
  if (bytes < 32) throw new Error("Contact preview signing key must contain at least 32 bytes.");
  return value;
}

function encode(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function invalidApproval(): Error {
  return new ContactPreviewApprovalError();
}

function approvalPayload(value: ContactPreviewApproval): string {
  return JSON.stringify({
    version: value.version,
    approvalId: value.approvalId,
    actionKind: value.actionKind,
    approvedBy: value.approvedBy,
    candidateStateId: value.candidateStateId,
    candidateId: value.candidateId,
    candidateName: value.candidateName,
    positionId: value.positionId,
    positionName: value.positionName,
    taskId: value.taskId,
    bossAccountId: value.bossAccountId,
    source: value.source,
    sourceLocatorKind: value.sourceLocatorKind,
    sourceLocatorSha256: value.sourceLocatorSha256,
    templateVersionId: value.templateVersionId,
    providerJobId: value.providerJobId,
    providerGreetingId: value.providerGreetingId,
    renderedMessageSha256: value.renderedMessageSha256,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt
  });
}

export function isContactPreviewApproval(value: unknown): value is ContactPreviewApproval {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    item.version === TOKEN_VERSION &&
    [
      "approvalId",
      "actionKind",
      "approvedBy",
      "candidateStateId",
      "candidateId",
      "candidateName",
      "positionId",
      "positionName",
      "taskId",
      "bossAccountId",
      "source",
      "sourceLocatorKind",
      "sourceLocatorSha256",
      "renderedMessageSha256",
      "issuedAt",
      "expiresAt"
    ].every((field) => typeof item[field] === "string" && item[field].length > 0) &&
    (item.actionKind === "greet" || item.actionKind === "message") &&
    (item.actionKind === "greet"
      ? item.templateVersionId === null &&
        typeof item.providerJobId === "string" &&
        item.providerJobId.length > 0 &&
        typeof item.providerGreetingId === "string" &&
        item.providerGreetingId.length > 0
      : typeof item.templateVersionId === "string" &&
        item.templateVersionId.length > 0 &&
        item.providerJobId === null &&
        item.providerGreetingId === null) &&
    (item.source === "recommend" || item.source === "search") &&
    item.sourceLocatorKind === "boss_geek_id" &&
    /^[a-f0-9]{64}$/u.test(item.sourceLocatorSha256 as string) &&
    /^[a-f0-9]{64}$/u.test(item.renderedMessageSha256 as string)
  );
}

export function sameContactPreviewApproval(
  left: unknown,
  right: ContactPreviewApproval
): boolean {
  if (!isContactPreviewApproval(left)) return false;
  return (
    left.version === right.version &&
    left.approvalId === right.approvalId &&
    left.actionKind === right.actionKind &&
    left.approvedBy === right.approvedBy &&
    left.candidateStateId === right.candidateStateId &&
    left.candidateId === right.candidateId &&
    left.candidateName === right.candidateName &&
    left.positionId === right.positionId &&
    left.positionName === right.positionName &&
    left.taskId === right.taskId &&
    left.bossAccountId === right.bossAccountId &&
    left.source === right.source &&
    left.sourceLocatorKind === right.sourceLocatorKind &&
    left.sourceLocatorSha256 === right.sourceLocatorSha256 &&
    left.templateVersionId === right.templateVersionId &&
    left.providerJobId === right.providerJobId &&
    left.providerGreetingId === right.providerGreetingId &&
    left.renderedMessageSha256 === right.renderedMessageSha256 &&
    left.issuedAt === right.issuedAt &&
    left.expiresAt === right.expiresAt
  );
}

export function contactMessageSha256(renderedMessage: string): string {
  return createHash("sha256").update(renderedMessage, "utf8").digest("hex");
}

export function normalizeContactSourceLocator(
  sourceLocator: CandidateSourceLocator
): CandidateSourceLocator {
  if (sourceLocator.kind !== "boss_geek_id") throw invalidApproval();
  const value = sourceLocator.value.trim();
  if (!/^[A-Za-z0-9_~-]{8,160}$/u.test(value)) throw invalidApproval();
  return { kind: sourceLocator.kind, value };
}

export function contactSourceLocatorSha256(
  sourceLocator: CandidateSourceLocator
): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizeContactSourceLocator(sourceLocator)), "utf8")
    .digest("hex");
}

export function contactPreviewApprovalIdempotencyKey(
  actionKind: ContactActionKind,
  approvalId: string
): string {
  if (actionKind !== "greet" && actionKind !== "message") {
    throw new Error("actionKind must be greet or message.");
  }
  return `contact-preview-approval:${actionKind}:${requiredText(approvalId, "approvalId")}`;
}

export function assertContactPreviewApprovalMatches(
  approval: ContactPreviewApproval,
  expected: ContactPreviewApprovalContext,
  now: Date = new Date()
): void {
  const issuedAt = Date.parse(approval.issuedAt);
  const expiresAt = Date.parse(approval.expiresAt);
  const nowMs = now.getTime();
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= issuedAt ||
    nowMs < issuedAt - 30_000 ||
    nowMs >= expiresAt
  ) {
    throw invalidApproval();
  }
  const exactFields = [
    [approval.actionKind, expected.actionKind],
    [approval.approvedBy, expected.approvedBy],
    [approval.candidateStateId, expected.candidateStateId],
    [approval.candidateId, expected.candidateId],
    [approval.candidateName, expected.candidateName],
    [approval.positionId, expected.positionId],
    [approval.positionName, expected.positionName],
    [approval.taskId, expected.taskId],
    [approval.bossAccountId, expected.bossAccountId],
    [approval.source, expected.source],
    [approval.sourceLocatorKind, normalizeContactSourceLocator(expected.sourceLocator).kind],
    [approval.sourceLocatorSha256, contactSourceLocatorSha256(expected.sourceLocator)],
    [approval.templateVersionId, expected.templateVersionId],
    [approval.providerJobId, expected.providerJobId],
    [approval.providerGreetingId, expected.providerGreetingId],
    [approval.renderedMessageSha256, contactMessageSha256(expected.renderedMessage)]
  ];
  if (exactFields.some(([actual, wanted]) => actual !== wanted)) throw invalidApproval();
}

export function issueContactPreviewApproval(input: {
  context: ContactPreviewApprovalContext;
  signingKey: string | Uint8Array;
  now?: Date;
  ttlMs?: number;
  approvalId?: string;
}): IssuedContactPreviewApproval {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Contact preview approval time is invalid.");
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
    throw new Error("Contact preview approval TTL must be between 30 seconds and 10 minutes.");
  }
  const context = input.context;
  for (const [field, value] of Object.entries(context)) {
    if (
      field !== "sourceLocator" &&
      field !== "templateVersionId" &&
      field !== "providerJobId" &&
      field !== "providerGreetingId"
    ) {
      requiredText(value as string, field);
    }
  }
  if (context.actionKind !== "greet" && context.actionKind !== "message") {
    throw new Error("actionKind must be greet or message.");
  }
  if (context.source !== "recommend" && context.source !== "search") {
    throw new Error("source must be recommend or search.");
  }
  if (
    (context.actionKind === "greet" &&
      (context.templateVersionId !== null ||
        !context.providerJobId?.trim() ||
        !context.providerGreetingId?.trim())) ||
    (context.actionKind === "message" &&
      (!context.templateVersionId?.trim() ||
        context.providerJobId !== null ||
        context.providerGreetingId !== null))
  ) {
    throw new Error(
      "Greeting approvals require providerJobId/providerGreetingId; message approvals require templateVersionId."
    );
  }
  const sourceLocator = normalizeContactSourceLocator(context.sourceLocator);
  const approval: ContactPreviewApproval = {
    version: TOKEN_VERSION,
    approvalId: requiredText(input.approvalId ?? randomUUID(), "approvalId"),
    actionKind: context.actionKind,
    approvedBy: context.approvedBy,
    candidateStateId: context.candidateStateId,
    candidateId: context.candidateId,
    candidateName: context.candidateName,
    positionId: context.positionId,
    positionName: context.positionName,
    taskId: context.taskId,
    bossAccountId: context.bossAccountId,
    source: context.source,
    sourceLocatorKind: sourceLocator.kind,
    sourceLocatorSha256: contactSourceLocatorSha256(sourceLocator),
    templateVersionId: context.templateVersionId,
    providerJobId: context.providerJobId?.trim() ?? null,
    providerGreetingId: context.providerGreetingId?.trim() ?? null,
    renderedMessageSha256: contactMessageSha256(context.renderedMessage),
    issuedAt: now.toISOString(),
    expiresAt: new Date(nowMs + ttlMs).toISOString()
  };
  const payload = approvalPayload(approval);
  const signature = createHmac("sha256", signingKey(input.signingKey))
    .update(payload, "utf8")
    .digest();
  return { token: `${encode(payload)}.${encode(signature)}`, approval };
}

export function verifyContactPreviewApproval(input: {
  token: string;
  signingKey: string | Uint8Array;
  expected: ContactPreviewApprovalContext;
  now?: Date;
}): ContactPreviewApproval {
  if (!input.token || Buffer.byteLength(input.token) > MAX_TOKEN_BYTES) throw invalidApproval();
  const parts = input.token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw invalidApproval();
  let payload: string;
  let signature: Buffer;
  try {
    payload = Buffer.from(parts[0], "base64url").toString("utf8");
    signature = Buffer.from(parts[1], "base64url");
  } catch {
    throw invalidApproval();
  }
  const expectedSignature = createHmac("sha256", signingKey(input.signingKey))
    .update(payload, "utf8")
    .digest();
  if (
    signature.byteLength !== expectedSignature.byteLength ||
    !timingSafeEqual(signature, expectedSignature)
  ) {
    throw invalidApproval();
  }
  let approval: unknown;
  try {
    approval = JSON.parse(payload);
  } catch {
    throw invalidApproval();
  }
  if (!isContactPreviewApproval(approval) || approvalPayload(approval) !== payload) {
    throw invalidApproval();
  }
  assertContactPreviewApprovalMatches(approval, input.expected, input.now);
  return approval;
}

// Confirmation must happen during the short preview window. Once accepted, the
// exact queued intent may wait for pacing/browser availability for up to a day.
export const CONTACT_QUEUE_APPROVAL_TTL_MS = 24 * 60 * 60 * 1_000;

export class ContactQueueApprovalExpiredError extends ContactPreviewApprovalError {
  constructor() {
    super();
    this.name = "ContactQueueApprovalExpiredError";
  }
}

type ContactQueueApproval = {
  kind: "contact-queue-approval-v1";
  intentId: string;
  previewTokenSha256: string;
  acceptedAt: string;
  expiresAt: string;
};

type ContactDispatchApprovalInput = Parameters<typeof verifyContactPreviewApproval>[0] & {
  intentId: string;
};

function queueSignature(payload: string, key: string | Uint8Array): Buffer {
  return createHmac("sha256", signingKey(key))
    .update(`contact-queue-approval-v1\n${payload}`, "utf8")
    .digest();
}

/** Only called by the repository when an explicitly confirmed intent is created. */
export function issueContactQueueApproval(input: ContactDispatchApprovalInput): string {
  const now = input.now ?? new Date();
  verifyContactPreviewApproval({ ...input, now });
  const receipt: ContactQueueApproval = {
    kind: "contact-queue-approval-v1",
    intentId: requiredText(input.intentId, "intentId"),
    previewTokenSha256: contactMessageSha256(input.token),
    acceptedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CONTACT_QUEUE_APPROVAL_TTL_MS).toISOString()
  };
  const payload = JSON.stringify(receipt);
  return `${encode(payload)}.${encode(queueSignature(payload, input.signingKey))}`;
}

export function verifyContactDispatchApproval(
  input: ContactDispatchApprovalInput & { queueToken?: unknown }
): ContactPreviewApproval {
  // Legacy intents keep their original deadline; deploying does not renew them.
  if (input.queueToken === undefined || input.queueToken === null) {
    return verifyContactPreviewApproval(input);
  }
  if (typeof input.queueToken !== "string" || input.queueToken.length > MAX_TOKEN_BYTES) {
    throw invalidApproval();
  }
  const parts = input.queueToken.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw invalidApproval();
  const payload = Buffer.from(parts[0], "base64url").toString("utf8");
  const signature = Buffer.from(parts[1], "base64url");
  const expectedSignature = queueSignature(payload, input.signingKey);
  if (signature.length !== expectedSignature.length || !timingSafeEqual(signature, expectedSignature)) {
    throw invalidApproval();
  }
  let receipt: ContactQueueApproval;
  try {
    receipt = JSON.parse(payload) as ContactQueueApproval;
  } catch {
    throw invalidApproval();
  }
  if (!receipt || receipt.kind !== "contact-queue-approval-v1" ||
      receipt.intentId !== input.intentId ||
      receipt.previewTokenSha256 !== contactMessageSha256(input.token) ||
      typeof receipt.acceptedAt !== "string" || typeof receipt.expiresAt !== "string") {
    throw invalidApproval();
  }
  const acceptedAt = Date.parse(receipt.acceptedAt);
  const expiresAt = Date.parse(receipt.expiresAt);
  const now = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(acceptedAt) || !Number.isFinite(expiresAt) || !Number.isFinite(now) ||
      expiresAt - acceptedAt !== CONTACT_QUEUE_APPROVAL_TTL_MS || now < acceptedAt - 30_000) {
    throw invalidApproval();
  }
  if (now >= expiresAt) throw new ContactQueueApprovalExpiredError();
  // Still verify every binding against the current DB context and the original
  // signature. Only the preview's time check uses the signed confirmation time.
  return verifyContactPreviewApproval({ ...input, now: new Date(acceptedAt) });
}
