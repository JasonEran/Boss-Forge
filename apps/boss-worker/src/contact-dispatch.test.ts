import {
  BossAccountLockTimeoutError
} from "@boss-forge/boss-cli-adapter";
import {
  ContactDispatchPolicyError,
  type ContactDispatchJob,
  type M2Repository
} from "@boss-forge/data";
import { describe, expect, it } from "vitest";
import {
  ContactSideEffectNotStartedError,
  ContactPersistenceAfterSideEffectError,
  classifyContactTransportBoundaryError,
  runContactDispatchOnce,
  type VerifiedGreetReceipt,
  type VerifiedMessageReceipt
} from "./contact-dispatch.js";
import { runContactWorkerLoop } from "./contact-worker-loop.js";

type FinishInput = Parameters<M2Repository["finishContactDispatch"]>[0];
type DeferInput = Parameters<M2Repository["deferContactDispatch"]>[0];

function dispatchJob(transportMode: "fake" | "real"): ContactDispatchJob {
  return {
    id: "d8263cb1-9d52-4896-8052-898743e11517",
    actionKind: "message",
    candidateStateId: "28fd0fc5-d13a-49aa-bf43-ed2079d351ae",
    candidateId: "candidate-fixture-01",
    candidateName: "Test Candidate",
    candidateTarget: "Test Candidate",
    candidateFingerprint: "fixture-fingerprint",
    candidateSnapshot: {
      index: 1,
      name: "Test Candidate",
      source: "recommend",
      fields: { 信息: "fixture" },
      evidence: [],
      sourceLocator: { kind: "boss_geek_id", value: "boss-geek-fixture-01" },
      raw: "- 1. Test Candidate｜信息:fixture"
    },
    sourceReference: "recommend:1:Test Candidate",
    source: "recommend",
    searchKeyword: null,
    positionName: "Test Position",
    renderedMessage: "你好，想和你沟通一下这个岗位。",
    templateVersionId: "message-template-version-fixture-01",
    providerGreetingId: null,
    providerJobId: null,
    transportMode,
    status: "processing",
    createdBy: "test-reviewer",
    createdAt: "2026-08-31T08:00:00.000Z",
    lastError: null,
    outboxEventId: "37b56468-13e0-4d11-93ee-b66525eaa133",
    taskId: "76cc5d56-6e8b-4663-881d-e9809b63bb39",
    bossAccountId: "boss-account-01",
    renderedMessageSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sourceLocatorSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    version: 1,
    bossJobKeyword: "Test Position",
    authorizationId: null,
    contactPolicyVersionId: null,
    odooDatabaseUuid: null,
    odooJobId: null,
    odooApplicantId: null,
    attemptNo: 1
  };
}

function verifiedReceipt(job: ContactDispatchJob): VerifiedMessageReceipt {
  if (job.actionKind !== "message") {
    throw new Error("Message receipt fixture requires a message job.");
  }
  return {
    schemaVersion: 1 as const,
    contactIntentId: job.id,
    attemptNo: job.attemptNo,
    actionKind: "message",
    candidateStateId: job.candidateStateId,
    bossAccountId: job.bossAccountId,
    candidateLocatorSha256: job.sourceLocatorSha256!,
    renderedMessageSha256: job.renderedMessageSha256,
    providerMessageId: "boss-message-fixture-01",
    providerConversationId: "boss-conversation-fixture-01",
    acceptedAt: "2026-08-31T08:00:01.000Z"
  };
}

function verifiedGreetReceipt(job: ContactDispatchJob): VerifiedGreetReceipt {
  if (
    job.actionKind !== "greet" ||
    !job.providerJobId ||
    !job.providerGreetingId ||
    job.candidateSnapshot.sourceLocator?.kind !== "boss_geek_id"
  ) {
    throw new Error("Greeting receipt fixture requires exact provider bindings.");
  }
  return {
    schemaVersion: 1,
    contactIntentId: job.id,
    attemptNo: job.attemptNo,
    actionKind: "greet",
    candidateStateId: job.candidateStateId,
    bossAccountId: job.bossAccountId,
    candidateLocatorSha256: job.sourceLocatorSha256!,
    renderedMessageSha256: job.renderedMessageSha256,
    providerJobId: job.providerJobId,
    providerGreetingId: job.providerGreetingId,
    providerCandidateId: job.candidateSnapshot.sourceLocator.value,
    responseCode: 0,
    responseStatus: 1,
    newFriend: 1,
    responseEvidenceSha256:
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    acceptedAt: "2026-08-31T08:00:01.000Z"
  };
}

describe("contact dispatch completion semantics", () => {
  it("persists an uncertain greeting once and keeps the worker waiting without another send", async () => {
    const job = dispatchJob("real");
    job.actionKind = "greet";
    const completions: FinishInput[] = [];
    let transportCalls = 0;
    let waits = 0;
    const results: string[] = [];
    await runContactWorkerLoop({
      loop: true,
      shouldStop: () => waits === 3,
      wait: async () => { waits += 1; },
      onResult: result => { results.push(result); },
      runOnce: () => runContactDispatchOnce({
        async claimContactDispatch() { return completions.length ? null : job; },
        async deferContactDispatch() { throw new Error("Uncertain must not be requeued"); },
        async finishContactDispatch(input) { completions.push(input); }
      }, {
        async perform() {
          transportCalls += 1;
          throw new Error("BOSS_GREET_POST_WRITE_BODY_MISMATCH");
        }
      }, "real-worker")
    });
    expect(waits).toBe(3);
    expect(transportCalls).toBe(1);
    expect(results).toEqual(["uncertain"]);
    expect(completions).toEqual([expect.objectContaining({ result: "uncertain" })]);
  });

  it("classifies only pre-write boundary failures as definitely not sent", () => {
    const preWriteFailure = new Error("account lock unavailable");
    const classified = classifyContactTransportBoundaryError({
      error: preWriteFailure,
      externalWriteStarted: false,
      safeMessage: "account lock unavailable",
      accountLockRetryAt: "2026-09-04T09:00:30.000Z"
    });

    expect(classified).toBeInstanceOf(ContactSideEffectNotStartedError);
    expect((classified as Error).cause).toBe(preWriteFailure);

    const postWriteFailure = new Error("connection closed after write started");
    expect(classifyContactTransportBoundaryError({
      error: postWriteFailure,
      externalWriteStarted: true,
      safeMessage: "connection closed",
      accountLockRetryAt: "2026-09-04T09:00:30.000Z"
    })).toBe(postWriteFailure);
  });

  it("preserves explicit preflight classifications at the transport boundary", () => {
    const readOnlyFailure = new ContactSideEffectNotStartedError("candidate not found");
    const policyFailure = new ContactDispatchPolicyError({
      disposition: "failed",
      reasons: ["do_not_contact"]
    });

    expect(classifyContactTransportBoundaryError({
      error: readOnlyFailure,
      externalWriteStarted: false,
      safeMessage: "candidate not found",
      accountLockRetryAt: "2026-09-04T09:00:30.000Z"
    })).toBe(readOnlyFailure);
    expect(classifyContactTransportBoundaryError({
      error: policyFailure,
      externalWriteStarted: false,
      safeMessage: "blocked",
      accountLockRetryAt: "2026-09-04T09:00:30.000Z"
    })).toBe(policyFailure);
  });

  it("defers account lock contention only before an external write starts", async () => {
    const timeout = new BossAccountLockTimeoutError(
      "boss-account-01",
      "/runtime/locks/boss-account-01.lock",
      null
    );
    const retryAt = "2026-09-04T09:00:30.000Z";
    const preWrite = classifyContactTransportBoundaryError({
      error: timeout,
      externalWriteStarted: false,
      safeMessage: timeout.message,
      accountLockRetryAt: retryAt
    });

    expect(preWrite).toBeInstanceOf(ContactDispatchPolicyError);
    expect(preWrite).toMatchObject({
      disposition: "deferred",
      reasons: ["boss_account_busy"],
      availableAt: retryAt
    });
    const deferrals: DeferInput[] = [];
    const completions: FinishInput[] = [];
    const beforeWriteResult = await runContactDispatchOnce(
      {
        async claimContactDispatch() {
          return dispatchJob("real");
        },
        async deferContactDispatch(input: DeferInput) {
          deferrals.push(input);
        },
        async finishContactDispatch(input: FinishInput) {
          completions.push(input);
        }
      },
      {
        async perform() {
          throw preWrite;
        }
      },
      "real-worker"
    );
    expect(beforeWriteResult).toBe("deferred");
    expect(deferrals).toEqual([
      expect.objectContaining({ availableAt: retryAt })
    ]);
    expect(completions).toEqual([]);

    const postWrite = classifyContactTransportBoundaryError({
      error: timeout,
      externalWriteStarted: true,
      safeMessage: timeout.message,
      accountLockRetryAt: retryAt
    });
    expect(postWrite).toBe(timeout);

    const afterWriteResult = await runContactDispatchOnce(
      {
        async claimContactDispatch() {
          return dispatchJob("real");
        },
        async deferContactDispatch(input: DeferInput) {
          deferrals.push(input);
        },
        async finishContactDispatch(input: FinishInput) {
          completions.push(input);
        }
      },
      {
        async perform() {
          throw postWrite;
        }
      },
      "real-worker"
    );
    expect(afterWriteResult).toBe("uncertain");
    expect(deferrals).toHaveLength(1);
    expect(completions).toEqual([
      expect.objectContaining({ result: "uncertain" })
    ]);
  });

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
        async perform() {
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
        async perform() {
          return { receipt: verifiedReceipt(job) };
        }
      },
      "real-worker"
    );

    expect(result).toBe("sent");
    expect(completions).toEqual([
      expect.objectContaining({
        job,
        result: "sent",
        externalMessage: JSON.stringify(verifiedReceipt(job))
      })
    ]);
  });

  it("accepts an action-specific greeting receipt without a fake message id", async () => {
    const job = dispatchJob("real");
    job.actionKind = "greet";
    job.templateVersionId = null;
    job.providerJobId = "boss-job-fixture-01";
    job.providerGreetingId = "boss-greeting-fixture-01";
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
        async perform() {
          return { receipt: verifiedGreetReceipt(job) };
        }
      },
      "real-worker"
    );

    expect(result).toBe("sent");
    expect(completions).toEqual([
      expect.objectContaining({
        job,
        result: "sent",
        externalMessage: JSON.stringify(verifiedGreetReceipt(job))
      })
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
          async perform() {
            return { receipt: verifiedReceipt(job) };
          }
        },
        "real-worker"
      )
    ).rejects.toBeInstanceOf(ContactPersistenceAfterSideEffectError);

    expect(completions).toEqual([
      expect.objectContaining({
        job,
        result: "sent",
        externalMessage: JSON.stringify(verifiedReceipt(job))
      })
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
        async perform() {
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
        async perform() {
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

  it("records a permanent real preflight policy block as failed, not uncertain", async () => {
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
        async perform() {
          throw new ContactDispatchPolicyError({
            disposition: "failed",
            reasons: ["contact_preview_approval_signature_invalid"]
          });
        }
      },
      "real-worker"
    );

    expect(result).toBe("failed");
    expect(completions).toEqual([
      expect.objectContaining({
        job,
        result: "failed",
        errorMessage: expect.stringContaining(
          "contact_preview_approval_signature_invalid"
        )
      })
    ]);
  });

  it("locks an unclassified real transport failure as uncertain", async () => {
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
        async perform() {
          throw new Error("connection closed after dispatch began");
        }
      },
      "real-worker"
    );

    expect(result).toBe("uncertain");
    expect(completions).toEqual([
      expect.objectContaining({ job, result: "uncertain" })
    ]);
  });

  it("never treats boss-cli success text as a real delivery receipt", async () => {
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
        async perform() {
          return { externalMessage: "已发送消息：你好" };
        }
      },
      "real-worker"
    );

    expect(result).toBe("uncertain");
    expect(completions).toEqual([
      expect.objectContaining({
        job,
        result: "uncertain",
        errorMessage: expect.stringContaining("没有 BOSS 消息回执")
      })
    ]);
  });

  it("rejects a provider receipt bound to a different action", async () => {
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
        async perform() {
          return {
            receipt: {
              ...verifiedReceipt(job),
              actionKind: "greet" as const
            } as unknown as VerifiedMessageReceipt
          };
        }
      },
      "real-worker"
    );

    expect(result).toBe("uncertain");
    expect(completions).toEqual([
      expect.objectContaining({
        job,
        result: "uncertain",
        errorMessage: expect.stringContaining("动作、候选人或正文不一致")
      })
    ]);
  });

  it("records an explicitly read-only real preflight failure as failed", async () => {
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
        async perform() {
          throw new ContactSideEffectNotStartedError("stable locator missing");
        }
      },
      "real-worker"
    );

    expect(result).toBe("failed");
    expect(completions).toEqual([
      expect.objectContaining({ job, result: "failed" })
    ]);
  });

  it("lets an atomic store claim one concurrent confirmation only once", async () => {
    const job = dispatchJob("real");
    const completions: FinishInput[] = [];
    let available: ContactDispatchJob | null = job;
    let transportCalls = 0;
    const store = {
      async claimContactDispatch() {
        const claimed = available;
        available = null;
        return claimed;
      },
      async deferContactDispatch() {},
      async finishContactDispatch(input: FinishInput) {
        completions.push(input);
      }
    };
    const transport = {
      async perform() {
        transportCalls += 1;
        await Promise.resolve();
        return { receipt: verifiedReceipt(job) };
      }
    };

    const results = await Promise.all([
      runContactDispatchOnce(store, transport, "real-worker-a"),
      runContactDispatchOnce(store, transport, "real-worker-b")
    ]);

    expect(results.sort()).toEqual(["idle", "sent"]);
    expect(transportCalls).toBe(1);
    expect(completions).toHaveLength(1);
  });
});
