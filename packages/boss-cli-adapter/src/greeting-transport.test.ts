import { createHash } from "node:crypto";
import {
  assertGreetingApprovalMatches,
  verifyGreetingChatStartReceipt
} from "@joohw/boss-cli/dist/toolset/greet.js";
import { describe, expect, it } from "vitest";

const body = "你好，想和你聊聊海外运营岗位。";
const bodySha256 = createHash("sha256").update(body, "utf8").digest("hex");
const approval = {
  expectedJobId: "job-overseas-01",
  expectedGreetingId: "greeting-job-01",
  expectedMessageSha256: bodySha256
};

describe("approval-bound BOSS greeting transport", () => {
  it("accepts an unchanged provider greeting preview", () => {
    const preview = {
      schemaVersion: 1 as const,
      kind: "greeting-preview" as const,
      source: "job" as const,
      jobId: approval.expectedJobId,
      jobName: "海外运营",
      greetingId: approval.expectedGreetingId,
      body
    };
    expect(assertGreetingApprovalMatches(preview, approval)).toBe(preview);
  });

  it("blocks before clicking when the exact body changed after approval", () => {
    expect(() =>
      assertGreetingApprovalMatches(
        {
          schemaVersion: 1,
          kind: "greeting-preview",
          source: "job",
          jobId: approval.expectedJobId,
          jobName: "海外运营",
          greetingId: approval.expectedGreetingId,
          body: `${body}（已修改）`
        },
        approval
      )
    ).toThrow("BOSS_GREET_APPROVAL_STALE");
  });

  it("accepts only a target-bound code-0 new-friend receipt with provider IDs", () => {
    expect(
      verifyGreetingChatStartReceipt({
        requestUrl: "https://www.zhipin.com/wapi/zpjob/chat/start",
        requestMethod: "POST",
        requestPostData: new URLSearchParams({
          gid: "candidate-geek-01",
          jid: approval.expectedJobId,
          greet: body
        }).toString(),
        payload: {
          code: 0,
          zpData: {
            status: 1,
            newfriend: 1,
            greeting: body,
            encryptGeekId: "candidate-geek-01"
          }
        },
        expectedCandidateId: "candidate-geek-01",
        expectedJobId: approval.expectedJobId,
        expectedGreetingId: approval.expectedGreetingId,
        expectedBody: body,
        acceptedAt: "2026-09-04T06:00:00.000Z"
      })
    ).toEqual(
      expect.objectContaining({
        actionKind: "greet",
        candidateId: "candidate-geek-01",
        jobId: approval.expectedJobId,
        greetingId: approval.expectedGreetingId,
        bodySha256,
        providerCandidateId: "candidate-geek-01",
        responseCode: 0,
        responseStatus: 1,
        newFriend: 1,
        responseEvidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
      })
    );
  });

  it("treats a successful-looking response without the exact returned candidate as uncertain", () => {
    expect(() =>
      verifyGreetingChatStartReceipt({
        requestUrl: "/wapi/zpjob/chat/start",
        requestMethod: "POST",
        requestPostData: new URLSearchParams({
          gid: "candidate-geek-01",
          jid: approval.expectedJobId,
          greet: body
        }).toString(),
        payload: {
          code: 0,
          zpData: {
            status: 1,
            newfriend: 1,
            greeting: body,
            geekId: "other-candidate"
          }
        },
        expectedCandidateId: "candidate-geek-01",
        expectedJobId: approval.expectedJobId,
        expectedGreetingId: approval.expectedGreetingId,
        expectedBody: body
      })
    ).toThrow("BOSS_GREET_POST_WRITE_TARGET_MISMATCH");
  });

  it("rejects target drift and code-0 greeting-guide blockers", () => {
    const common = {
      requestUrl: "/wapi/zpjob/chat/start",
      requestMethod: "POST",
      expectedCandidateId: "candidate-geek-01",
      expectedJobId: approval.expectedJobId,
      expectedGreetingId: approval.expectedGreetingId,
      expectedBody: body
    };
    expect(() =>
      verifyGreetingChatStartReceipt({
        ...common,
        requestPostData: new URLSearchParams({
          gid: "other-candidate",
          jid: approval.expectedJobId
        }).toString(),
        payload: { code: 0, zpData: {} }
      })
    ).toThrow("BOSS_GREET_POST_WRITE_TARGET_MISMATCH");
    expect(() =>
      verifyGreetingChatStartReceipt({
        ...common,
        requestPostData: new URLSearchParams({
          gid: "candidate-geek-01",
          jid: approval.expectedJobId
        }).toString(),
        payload: {
          code: 0,
          zpData: {
            status: 1,
            newfriend: 1,
            greeting: body,
            encryptGeekId: "candidate-geek-01"
          }
        }
      })
    ).toThrow("BOSS_GREET_POST_WRITE_BODY_MISMATCH");
    expect(() =>
      verifyGreetingChatStartReceipt({
        ...common,
        requestPostData: new URLSearchParams({
          gid: "candidate-geek-01",
          jid: approval.expectedJobId,
          greet: body
        }).toString(),
        payload: {
          code: 0,
          zpData: {
            status: 1,
            newfriend: 1,
            greeting: body,
            greetingInfo: { guideTip: "请先更新招呼语" }
          }
        }
      })
    ).toThrow("BOSS_GREET_POST_WRITE_BLOCKED");
  });
});
