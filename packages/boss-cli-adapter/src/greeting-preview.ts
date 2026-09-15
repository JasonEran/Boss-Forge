export type BossGreetingPreview = {
  schemaVersion: 1;
  kind: "greeting-preview";
  source: "job";
  jobId: string;
  jobName: string;
  greetingId: string;
  /** Exact provider-configured body. Do not trim, normalize or re-render. */
  body: string;
};

function isProviderIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    /^[A-Za-z0-9_~=-]+$/u.test(value)
  );
}

export function parseBossGreetingPreview(stdout: string): BossGreetingPreview {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error: unknown) {
    throw new Error("boss-cli greeting preview did not return one JSON document.", {
      cause: error
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("boss-cli greeting preview returned an invalid document.");
  }
  const value = parsed as Partial<BossGreetingPreview> & Record<string, unknown>;
  const exactKeys = [
    "schemaVersion",
    "kind",
    "source",
    "jobId",
    "jobName",
    "greetingId",
    "body"
  ];
  if (
    Object.keys(value).sort().join("\u0000") !== exactKeys.sort().join("\u0000") ||
    value.schemaVersion !== 1 ||
    value.kind !== "greeting-preview" ||
    value.source !== "job" ||
    !isProviderIdentifier(value.jobId) ||
    !isProviderIdentifier(value.greetingId) ||
    typeof value.jobName !== "string" ||
    !value.jobName.trim() ||
    value.jobName.length > 256 ||
    typeof value.body !== "string" ||
    !value.body.trim() ||
    value.body.length < 2 ||
    value.body.length > 500
  ) {
    throw new Error("boss-cli greeting preview fields failed strict validation.");
  }
  return value as BossGreetingPreview;
}
