export type BossGreetProviderReceipt = {
  schemaVersion: 1;
  kind: "contact-provider-receipt";
  actionKind: "greet";
  candidateId: string;
  jobId: string;
  greetingId: string;
  bodySha256: string;
  providerCandidateId: string;
  responseCode: 0;
  responseStatus: 1;
  newFriend: 1;
  responseEvidenceSha256: string;
  acceptedAt: string;
};

export type BossMessageProviderReceipt = {
  schemaVersion: 1;
  kind: "contact-provider-receipt";
  actionKind: "message";
  candidateId: string;
  bodySha256: string;
  clientMid: string;
  serverMid: string;
  providerConversationId: string;
  acceptedAt: string;
};

export type BossContactProviderReceipt =
  | BossGreetProviderReceipt
  | BossMessageProviderReceipt;

function strictObject(stdout: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error: unknown) {
    throw new Error("boss-cli contact action did not return one JSON receipt.", {
      cause: error
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("boss-cli contact action returned an invalid receipt.");
  }
  return parsed as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    Object.keys(value).sort().join("\u0000") === [...expected].sort().join("\u0000")
  );
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function validAcceptedAt(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

const PRE_WRITE_CODES = [
  "BOSS_GREET_ALREADY_CONTACTED",
  "BOSS_GREET_TARGET_UNVERIFIED",
  "BOSS_GREET_TARGET_NOT_READY",
  "BOSS_GREET_JOB_UNAVAILABLE"
] as const;

type GreetBinding = Pick<BossGreetProviderReceipt,
  "candidateId" | "jobId" | "greetingId" | "bodySha256">;

export type BossContactNotStarted = GreetBinding & {
  schemaVersion: 1;
  kind: "contact-not-started";
  actionKind: "greet";
  code: typeof PRE_WRITE_CODES[number];
  message: string;
};

// Only this explicit, exact-target result proves that the native send handler
// was never invoked. Stderr, timeouts and malformed output prove no such thing.
export function parseBossContactNotStarted(
  stdout: string,
  expected: GreetBinding
): BossContactNotStarted | null {
  const value = strictObject(stdout);
  if (value.kind !== "contact-not-started") return null;
  if (
    !exactKeys(value, ["schemaVersion", "kind", "actionKind", "candidateId",
      "jobId", "greetingId", "bodySha256", "code", "message"]) ||
    value.schemaVersion !== 1 || value.actionKind !== "greet" ||
    !validIdentifier(value.candidateId) || !validIdentifier(value.jobId) ||
    !validIdentifier(value.greetingId) || !validSha256(value.bodySha256) ||
    !PRE_WRITE_CODES.some(code => code === value.code) ||
    !validIdentifier(value.message) ||
    value.candidateId !== expected.candidateId || value.jobId !== expected.jobId ||
    value.greetingId !== expected.greetingId || value.bodySha256 !== expected.bodySha256
  ) {
    throw new Error("boss-cli pre-write rejection failed strict binding validation.");
  }
  return value as BossContactNotStarted;
}

export function parseBossContactProviderReceipt(
  stdout: string,
  expectedActionKind: "greet"
): BossGreetProviderReceipt;
export function parseBossContactProviderReceipt(
  stdout: string,
  expectedActionKind: "message"
): BossMessageProviderReceipt;
export function parseBossContactProviderReceipt(
  stdout: string,
  expectedActionKind: BossContactProviderReceipt["actionKind"]
): BossContactProviderReceipt {
  const value = strictObject(stdout);
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "contact-provider-receipt" ||
    value.actionKind !== expectedActionKind
  ) {
    throw new Error("boss-cli contact receipt action or schema does not match.");
  }
  if (expectedActionKind === "greet") {
    const keys = [
      "schemaVersion",
      "kind",
      "actionKind",
      "candidateId",
      "jobId",
      "greetingId",
      "bodySha256",
      "providerCandidateId",
      "responseCode",
      "responseStatus",
      "newFriend",
      "responseEvidenceSha256",
      "acceptedAt"
    ] as const;
    if (
      !exactKeys(value, keys) ||
      !validIdentifier(value.candidateId) ||
      !validIdentifier(value.jobId) ||
      !validIdentifier(value.greetingId) ||
      !validSha256(value.bodySha256) ||
      !validIdentifier(value.providerCandidateId) ||
      value.providerCandidateId !== value.candidateId ||
      value.responseCode !== 0 ||
      value.responseStatus !== 1 ||
      value.newFriend !== 1 ||
      !validSha256(value.responseEvidenceSha256) ||
      !validAcceptedAt(value.acceptedAt)
    ) {
      throw new Error("boss-cli greet receipt failed strict validation.");
    }
    return value as BossGreetProviderReceipt;
  }
  const keys = [
    "schemaVersion",
    "kind",
    "actionKind",
    "candidateId",
    "bodySha256",
    "clientMid",
    "serverMid",
    "providerConversationId",
    "acceptedAt"
  ] as const;
  if (
    !exactKeys(value, keys) ||
    !validIdentifier(value.candidateId) ||
    !validSha256(value.bodySha256) ||
    !validIdentifier(value.clientMid) ||
    !validIdentifier(value.serverMid) ||
    value.clientMid === value.serverMid ||
    !validIdentifier(value.providerConversationId) ||
    !validAcceptedAt(value.acceptedAt)
  ) {
    throw new Error("boss-cli message receipt failed strict validation.");
  }
  return value as BossMessageProviderReceipt;
}
