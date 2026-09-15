import { describe, expect, it } from "vitest";
import {
  ContactPreviewApprovalConfigurationError,
  contactPreviewApprovalSigningKeyFromEnvironment,
  contactPreviewApprovalIdempotencyKey,
  issueContactPreviewApproval,
  issueContactQueueApproval,
  verifyContactDispatchApproval,
  CONTACT_QUEUE_APPROVAL_TTL_MS,
  ContactQueueApprovalExpiredError,
  verifyContactPreviewApproval,
  type ContactPreviewApprovalContext
} from "./contact-preview-approval.js";

const signingKey = "test-only-contact-preview-signing-key-32-bytes";
const now = new Date("2026-09-04T04:00:00.000Z");
const context: ContactPreviewApprovalContext = {
  actionKind: "message",
  approvedBy: "hr-user-id",
  candidateStateId: "candidate-state-id",
  candidateId: "candidate-id",
  candidateName: "测试候选人",
  positionId: "position-id",
  positionName: "海外运营专员",
  taskId: "task-id",
  bossAccountId: "boss-account-01",
  source: "recommend",
  sourceLocator: { kind: "boss_geek_id", value: "boss-geek-id-001" },
  templateVersionId: "template-version-id",
  providerJobId: null,
  providerGreetingId: null,
  renderedMessage: "你好，想和你沟通一下海外运营专员岗位。"
};

describe("confirmed contact queue approvals", () => {
  const intentId = "queued-intent-001";
  const preview = () => issueContactPreviewApproval({ context, signingKey, now, ttlMs: 600_000 });
  const queued = () => {
    const { token } = preview();
    const input = { token, signingKey, expected: context, intentId, now };
    return { ...input, queueToken: issueContactQueueApproval(input) };
  };

  it("allows all 43 confirmed contacts to wait for pacing beyond the preview deadline", () => {
    for (let index = 0; index < 43; index++) {
      const input = queued();
      expect(verifyContactDispatchApproval({
        ...input, now: new Date(now.getTime() + index * 100_000)
      }).candidateId).toBe(context.candidateId);
    }
  });

  it("never accepts an expired unconfirmed preview", () => {
    expect(() => issueContactQueueApproval({ token: preview().token, signingKey,
      expected: context, intentId, now: new Date(now.getTime() + 600_000)
    })).toThrow();
  });

  it("does not renew legacy intents without a signed queue receipt", () => {
    const input = queued();
    for (const queueToken of [undefined, null]) {
      expect(() => verifyContactDispatchApproval({ ...input, queueToken,
        now: new Date(now.getTime() + 600_000)
      })).toThrow();
    }
  });

  it("expires at the bounded queue deadline", () => {
    const input = queued();
    expect(() => verifyContactDispatchApproval({ ...input,
      now: new Date(now.getTime() + CONTACT_QUEUE_APPROVAL_TTL_MS - 1)
    })).not.toThrow();
    expect(() => verifyContactDispatchApproval({ ...input,
      now: new Date(now.getTime() + CONTACT_QUEUE_APPROVAL_TTL_MS)
    })).toThrow(ContactQueueApprovalExpiredError);
  });

  it("rejects receipt reuse on another intent or another valid preview", () => {
    const input = queued();
    expect(() => verifyContactDispatchApproval({ ...input, intentId: "another-intent" })).toThrow();
    expect(() => verifyContactDispatchApproval({ ...input, token: preview().token })).toThrow();
  });

  it.each([
    { candidateId: "another-candidate" },
    { approvedBy: "another-user" },
    { renderedMessage: "changed text" },
    { providerGreetingId: "changed-greeting" },
    { sourceLocator: { kind: "boss_geek_id" as const, value: "different_geek_id" } }
  ])("keeps current candidate, actor and message bindings: %j", change => {
    expect(() => verifyContactDispatchApproval({ ...queued(), expected: { ...context, ...change },
      now: new Date(now.getTime() + 3_600_000)
    })).toThrow();
  });

  it("rejects receipt tampering, invalid types and a different signing key", () => {
    const input = queued();
    const [payload, signature] = input.queueToken.split(".");
    const receipt = JSON.parse(Buffer.from(payload!, "base64url").toString());
    receipt.acceptedAt = new Date(now.getTime() - 600_000).toISOString();
    const tampered = `${Buffer.from(JSON.stringify(receipt)).toString("base64url")}.${signature}`;
    for (const queueToken of [tampered, "", 123, {}, input.token]) {
      expect(() => verifyContactDispatchApproval({ ...input, queueToken })).toThrow();
    }
    expect(() => verifyContactDispatchApproval({ ...input, signingKey: "different-key-with-at-least-thirty-two-bytes" })).toThrow();
  });
});

describe("contact preview approval", () => {
  it("requires one shared signing key long enough for API and worker verification", () => {
    expect(() => contactPreviewApprovalSigningKeyFromEnvironment({})).toThrow(
      ContactPreviewApprovalConfigurationError
    );
    expect(() =>
      contactPreviewApprovalSigningKeyFromEnvironment({
        BOSS_FORGE_CONTACT_PREVIEW_SIGNING_KEY: "too-short"
      })
    ).toThrow(ContactPreviewApprovalConfigurationError);
    expect(
      contactPreviewApprovalSigningKeyFromEnvironment({
        BOSS_FORGE_CONTACT_PREVIEW_SIGNING_KEY: signingKey
      })
    ).toBe(signingKey);
  });

  it("binds an approval to the exact actor, candidate, task, position, template and body", () => {
    const issued = issueContactPreviewApproval({
      context,
      signingKey,
      now,
      approvalId: "approval-id"
    });

    const verified = verifyContactPreviewApproval({
      token: issued.token,
      signingKey,
      expected: context,
      now: new Date(now.getTime() + 60_000)
    });

    expect(verified.approvalId).toBe("approval-id");
    expect(
      contactPreviewApprovalIdempotencyKey(verified.actionKind, verified.approvalId)
    ).toBe(
      "contact-preview-approval:message:approval-id"
    );
    const encodedPayload = issued.token.split(".")[0]!;
    const payloadText = Buffer.from(encodedPayload, "base64url").toString("utf8");
    expect(payloadText).toContain('"bossAccountId":"boss-account-01"');
    expect(payloadText).toContain('"source":"recommend"');
    expect(payloadText).toContain('"sourceLocatorKind":"boss_geek_id"');
    expect(payloadText).not.toContain(context.sourceLocator.value);
  });

  it.each([
    ["action", { actionKind: "greet" as const }],
    ["candidate", { candidateId: "another-candidate" }],
    ["task", { taskId: "another-task" }],
    ["position", { positionId: "another-position" }],
    ["BOSS account", { bossAccountId: "another-boss-account" }],
    ["source", { source: "search" as const }],
    [
      "source locator",
      { sourceLocator: { kind: "boss_geek_id" as const, value: "boss-geek-id-002" } }
    ],
    ["template", { templateVersionId: "another-template-version" }],
    ["provider job", { providerJobId: "another-job-id" }],
    ["greeting id", { providerGreetingId: "another-greeting-id" }],
    ["message", { renderedMessage: `${context.renderedMessage}已修改` }],
    ["approver", { approvedBy: "another-user" }]
  ])("rejects a changed %s", (_label, change) => {
    const issued = issueContactPreviewApproval({ context, signingKey, now });
    expect(() =>
      verifyContactPreviewApproval({
        token: issued.token,
        signingKey,
        expected: { ...context, ...change },
        now: new Date(now.getTime() + 60_000)
      })
    ).toThrow("本次消息许可无效或已过期");
  });

  it("rejects expiry and token tampering", () => {
    const issued = issueContactPreviewApproval({ context, signingKey, now });
    expect(() =>
      verifyContactPreviewApproval({
        token: issued.token,
        signingKey,
        expected: context,
        now: new Date(now.getTime() + 5 * 60_000)
      })
    ).toThrow("本次消息许可无效或已过期");
    expect(() =>
      verifyContactPreviewApproval({
        token: `${issued.token.slice(0, 12)}x${issued.token.slice(13)}`,
        signingKey,
        expected: context,
        now: new Date(now.getTime() + 60_000)
      })
    ).toThrow("本次消息许可无效或已过期");
  });

  it("normalizes harmless locator whitespace but rejects a missing stable locator", () => {
    const issued = issueContactPreviewApproval({
      context: {
        ...context,
        sourceLocator: { ...context.sourceLocator, value: `  ${context.sourceLocator.value}  ` }
      },
      signingKey,
      now
    });
    expect(() =>
      verifyContactPreviewApproval({
        token: issued.token,
        signingKey,
        expected: context,
        now: new Date(now.getTime() + 60_000)
      })
    ).not.toThrow();
    expect(() =>
      issueContactPreviewApproval({
        context: {
          ...context,
          sourceLocator: { ...context.sourceLocator, value: "   " }
        },
        signingKey,
        now
      })
    ).toThrow("本次消息许可无效或已过期");
  });

  it("derives one idempotency key from concurrent confirmations of the same preview", async () => {
    const issued = issueContactPreviewApproval({
      context,
      signingKey,
      now,
      approvalId: "one-preview-one-intent"
    });
    const keys = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const verified = verifyContactPreviewApproval({
          token: issued.token,
          signingKey,
          expected: context,
          now: new Date(now.getTime() + 1_000)
        });
        return contactPreviewApprovalIdempotencyKey(
          verified.actionKind,
          verified.approvalId
        );
      })
    );

    expect(new Set(keys)).toEqual(
      new Set(["contact-preview-approval:message:one-preview-one-intent"])
    );
  });

  it("never aliases greeting and message approvals with the same approval id", () => {
    expect(contactPreviewApprovalIdempotencyKey("greet", "same-id")).toBe(
      "contact-preview-approval:greet:same-id"
    );
    expect(contactPreviewApprovalIdempotencyKey("message", "same-id")).toBe(
      "contact-preview-approval:message:same-id"
    );
  });

  it("binds a greeting to its provider greeting id and exact rendered body", () => {
    const greetingContext: ContactPreviewApprovalContext = {
      ...context,
      actionKind: "greet",
      templateVersionId: null,
      providerJobId: "boss-job-001",
      providerGreetingId: "boss-greeting-001",
      renderedMessage: "你好，我们正在招聘海外运营，期待与你沟通。"
    };
    const issued = issueContactPreviewApproval({
      context: greetingContext,
      signingKey,
      now
    });

    expect(issued.approval.providerGreetingId).toBe("boss-greeting-001");
    expect(() => verifyContactPreviewApproval({
      token: issued.token,
      signingKey,
      expected: { ...greetingContext, providerGreetingId: "boss-greeting-002" },
      now: new Date(now.getTime() + 1_000)
    })).toThrow("本次消息许可无效或已过期");
  });
});
