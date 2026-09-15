import { describe, expect, it } from "vitest";
import { parseBossContactNotStarted, parseBossContactProviderReceipt } from "./contact-provider-receipt.js";

describe("native greeting pre-write result", () => {
  const binding = {candidateId: "geek-01", jobId: "job-01", greetingId: "greet-01", bodySha256: "a".repeat(64)};
  const rejection = {...binding, schemaVersion: 1, kind: "contact-not-started", actionKind: "greet",
    code: "BOSS_GREET_ALREADY_CONTACTED", message: "已建立联系，本次未发送。"};
  it("accepts an exact-target refusal without treating it as a successful send", () => {
    expect(parseBossContactNotStarted(JSON.stringify(rejection), binding)).toEqual(rejection);
    expect(() => parseBossContactProviderReceipt(JSON.stringify(rejection), "greet")).toThrow();
    expect(parseBossContactNotStarted(JSON.stringify({kind: "contact-provider-receipt"}), binding)).toBeNull();
  });
  it.each(["candidateId", "jobId", "greetingId", "bodySha256"])("rejects a mismatched %s", key => {
    expect(() => parseBossContactNotStarted(JSON.stringify({...rejection, [key]: "b".repeat(64)}), binding)).toThrow("strict binding");
  });
  it.each([
    {code: "BOSS_GREET_POST_WRITE_BODY_MISMATCH"}, {invoked: true}, {schemaVersion: 2},
    {actionKind: "message"}, {message: ""}, {candidateId: " geek-01"}
  ])("does not accept an unproven no-write claim: %j", mutation => {
    expect(() => parseBossContactNotStarted(JSON.stringify({...rejection, ...mutation}), binding)).toThrow();
  });
  it("does not infer a pre-write refusal from stderr text or malformed output", () => {
    expect(() => parseBossContactNotStarted("BOSS_GREET_ALREADY_CONTACTED", binding)).toThrow();
  });
});

describe("BOSS contact provider receipt parser", () => {
  it("accepts a fully bound greeting response receipt", () => {
    const receipt = {
      schemaVersion: 1,
      kind: "contact-provider-receipt",
      actionKind: "greet",
      candidateId: "candidate-geek-01",
      jobId: "job-overseas-01",
      greetingId: "greeting-job-01",
      bodySha256: "a".repeat(64),
      providerCandidateId: "candidate-geek-01",
      responseCode: 0,
      responseStatus: 1,
      newFriend: 1,
      responseEvidenceSha256: "b".repeat(64),
      acceptedAt: "2026-09-04T06:00:00.000Z"
    };
    expect(parseBossContactProviderReceipt(JSON.stringify(receipt), "greet")).toEqual(
      receipt
    );
  });

  it("rejects action drift and extra unverified fields", () => {
    const receipt = {
      schemaVersion: 1,
      kind: "contact-provider-receipt",
      actionKind: "greet",
      candidateId: "candidate-geek-01",
      jobId: "job-overseas-01",
      greetingId: "greeting-job-01",
      bodySha256: "a".repeat(64),
      providerCandidateId: "candidate-geek-01",
      responseCode: 0,
      responseStatus: 1,
      newFriend: 1,
      responseEvidenceSha256: "b".repeat(64),
      acceptedAt: "2026-09-04T06:00:00.000Z"
    };
    expect(() =>
      parseBossContactProviderReceipt(JSON.stringify(receipt), "message")
    ).toThrow("action or schema");
    expect(() =>
      parseBossContactProviderReceipt(
        JSON.stringify({ ...receipt, localSuccessText: "clicked" }),
        "greet"
      )
    ).toThrow("strict validation");
  });

  it("requires a distinct BOSS serverMid for a message receipt", () => {
    const receipt = {
      schemaVersion: 1,
      kind: "contact-provider-receipt",
      actionKind: "message",
      candidateId: "candidate-geek-01",
      bodySha256: "a".repeat(64),
      clientMid: "local-mid-01",
      serverMid: "server-mid-01",
      providerConversationId: "conversation-01",
      acceptedAt: "2026-09-04T06:00:00.000Z"
    };
    expect(parseBossContactProviderReceipt(JSON.stringify(receipt), "message")).toEqual(
      receipt
    );
    expect(() =>
      parseBossContactProviderReceipt(
        JSON.stringify({ ...receipt, serverMid: receipt.clientMid }),
        "message"
      )
    ).toThrow("strict validation");
  });
});
