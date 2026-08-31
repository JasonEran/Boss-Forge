import {
  ContactDispatchPolicyError,
  type ContactDispatchJob,
  type M2Repository
} from "@boss-forge/data";
import { describe, expect, it } from "vitest";
import {
  ContactPersistenceAfterSideEffectError,
  runContactDispatchOnce
} from "./contact-dispatch.js";

type FinishInput = Parameters<M2Repository["finishContactDispatch"]>[0];
type DeferInput = Parameters<M2Repository["deferContactDispatch"]>[0];

function dispatchJob(transportMode: "fake" | "real"): ContactDispatchJob {
  return {
    id: "d8263cb1-9d52-4896-8052-898743e11517",
    candidateStateId: "28fd0fc5-d13a-49aa-bf43-ed2079d351ae",
    candidateName: "Test Candidate",
    candidateTarget: "Test Candidate",
    candidateFingerprint: "fixture-fingerprint",
    candidateSnapshot: {
      index: 1,
      name: "Test Candidate",
      source: "recommend",
      fields: { 信息: "fixture" },
      evidence: [],
      raw: "- 1. Test Candidate｜信息:fixture"
    },
    sourceReference: "recommend:1:Test Candidate",
    source: "recommend",
    searchKeyword: null,
    positionName: "Test Position",
    renderedMessage: "你好，想和你沟通一下这个岗位。",
    transportMode,
    status: "processing",
    createdBy: "test-reviewer",
    createdAt: "2026-08-31T08:00:00.000Z",
    lastError: null,
    outboxEventId: "37b56468-13e0-4d11-93ee-b66525eaa133",
    taskId: "76cc5d56-6e8b-4663-881d-e9809b63bb39",
    bossAccountId: "boss-account-01",
    bossJobKeyword: "Test Position",
    authorizationId: null,
    contactPolicyVersionId: null,
    odooDatabaseUuid: null,
    odooJobId: null,
    odooApplicantId: null,
    attemptNo: 1
  };
}

describe("contact dispatch completion semantics", () => {
  it("records a successful fake transport as simulated", async () => {
    const job = dispatchJob("fake");
    const completions: FinishInput[] = [];
    const result = await runContactDispatchOnce(
      {
        async claimContactDispatch() {
          return job;
        },
        async deferContactDispatch() {},
        async finishContactDispatch(input: FinishInput) {
          completions.push(input);
        }
      },
      {
        async greet() {
          return { externalMessage: "fake-only" };
        }
      },
      "fake-worker"
    );

    expect(result).toBe("simulated");
    expect(completions).toEqual([
      expect.objectContaining({ job, result: "simulated", externalMessage: "fake-only" })
    ]);
  });

  it("keeps a successful real transport as sent", async () => {
    const job = dispatchJob("real");
    const completions: FinishInput[] = [];
    const result = await runContactDispatchOnce(
      {
        async claimContactDispatch() {
          return job;
        },
        async deferContactDispatch() {},
        async finishContactDispatch(input: FinishInput) {
          completions.push(input);
        }
      },
      {
        async greet() {
          return { externalMessage: "boss-cli-success" };
        }
      },
      "real-worker"
    );

    expect(result).toBe("sent");
    expect(completions).toEqual([
      expect.objectContaining({ job, result: "sent", externalMessage: "boss-cli-success" })
    ]);
  });

  it("does not overwrite a successful external contact as failed when persistence fails", async () => {
    const job = dispatchJob("real");
    const completions: FinishInput[] = [];

    await expect(
      runContactDispatchOnce(
        {
          async claimContactDispatch() {
            return job;
          },
          async deferContactDispatch() {},
          async finishContactDispatch(input: FinishInput) {
            completions.push(input);
            throw new Error("database unavailable");
          }
        },
        {
          async greet() {
            return { externalMessage: "boss-cli-success" };
          }
        },
        "real-worker"
      )
    ).rejects.toBeInstanceOf(ContactPersistenceAfterSideEffectError);

    expect(completions).toEqual([
      expect.objectContaining({ job, result: "sent", externalMessage: "boss-cli-success" })
    ]);
  });

  it("requeues a temporary policy block instead of recording a permanent failure", async () => {
    const job = dispatchJob("fake");
    const deferrals: DeferInput[] = [];
    const completions: FinishInput[] = [];
    const availableAt = "2026-09-01T01:00:00.000Z";

    const result = await runContactDispatchOnce(
      {
        async claimContactDispatch() {
          return job;
        },
        async deferContactDispatch(input: DeferInput) {
          deferrals.push(input);
        },
        async finishContactDispatch(input: FinishInput) {
          completions.push(input);
        }
      },
      {
        async greet() {
          throw new ContactDispatchPolicyError({
            disposition: "deferred",
            reasons: ["outside_allowed_hours"],
            availableAt
          });
        }
      },
      "fake-worker"
    );

    expect(result).toBe("deferred");
    expect(deferrals).toEqual([
      expect.objectContaining({ job, availableAt, reason: expect.stringContaining("outside_allowed_hours") })
    ]);
    expect(completions).toEqual([]);
  });

  it("keeps permanent policy blocks as failed", async () => {
    const job = dispatchJob("fake");
    const completions: FinishInput[] = [];

    const result = await runContactDispatchOnce(
      {
        async claimContactDispatch() {
          return job;
        },
        async deferContactDispatch() {},
        async finishContactDispatch(input: FinishInput) {
          completions.push(input);
        }
      },
      {
        async greet() {
          throw new ContactDispatchPolicyError({
            disposition: "failed",
            reasons: ["do_not_contact"]
          });
        }
      },
      "fake-worker"
    );

    expect(result).toBe("failed");
    expect(completions).toEqual([
      expect.objectContaining({ job, result: "failed", errorMessage: expect.stringContaining("do_not_contact") })
    ]);
  });
});
