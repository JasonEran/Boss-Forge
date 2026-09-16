import { describe, expect, it } from "vitest";
import { contactMessageSha256, contactSourceLocatorSha256 } from "@boss-forge/contracts";
import type { Database } from "./client.js";
import { M2Repository } from "./m2-repository.js";
import type { ContactDispatchJob } from "./types.js";

type RecordedQuery = { text: string; values: unknown[] };

function normalizedQuery(strings: TemplateStringsArray): string {
  return strings.join("$value").replace(/\s+/gu, " ").trim();
}

function dispatchJob(transportMode: "fake" | "real" = "real"): ContactDispatchJob {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    actionKind: "message",
    candidateStateId: "20000000-0000-4000-8000-000000000001",
    candidateId: "70000000-0000-4000-8000-000000000001",
    candidateName: "测试候选人",
    candidateTarget: "测试候选人",
    candidateFingerprint: "fixture-fingerprint",
    candidateSnapshot: {
      index: 1,
      name: "测试候选人",
      source: "recommend",
      sourceLocator: { kind: "boss_geek_id", value: "fixture_geek_123" },
      fields: {},
      evidence: [],
      raw: "fixture"
    },
    sourceReference: "recommend:1:测试候选人",
    source: "recommend",
    searchKeyword: null,
    positionName: "测试岗位",
    templateVersionId: "80000000-0000-4000-8000-000000000001",
    providerJobId: null,
    providerGreetingId: null,
    renderedMessage: "你好，想和你沟通一下这个岗位。",
    renderedMessageSha256: contactMessageSha256("你好，想和你沟通一下这个岗位。"),
    sourceLocatorSha256: contactSourceLocatorSha256({
      kind: "boss_geek_id",
      value: "fixture_geek_123"
    }),
    transportMode,
    status: "processing",
    createdBy: "30000000-0000-4000-8000-000000000001",
    createdAt: "2026-09-04T08:00:00.000Z",
    lastError: null,
    version: 2,
    outboxEventId: "40000000-0000-4000-8000-000000000001",
    taskId: "50000000-0000-4000-8000-000000000001",
    bossAccountId: "boss-account-01",
    bossJobKeyword: "测试岗位",
    authorizationId: null,
    contactPolicyVersionId: null,
    odooDatabaseUuid: null,
    odooJobId: null,
    odooApplicantId: null,
    attemptNo: 1
  };
}

function completionRepository(input?: {
  intentProcessing?: boolean;
  attemptProcessing?: boolean;
  reservationStatus?: "reserved" | "consumed" | "released" | null;
}): { repository: M2Repository; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const transaction = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = normalizedQuery(strings);
    queries.push({ text, values });
    if (text.startsWith("SELECT id FROM contact_intents")) {
      return Promise.resolve(input?.intentProcessing === false ? [] : [{ id: "intent" }]);
    }
    if (text.startsWith("SELECT id FROM contact_attempts")) {
      return Promise.resolve(input?.attemptProcessing === false ? [] : [{ id: "attempt" }]);
    }
    if (text.includes("FROM contact_quota_reservations")) {
      const status = input?.reservationStatus === undefined ? "reserved" : input.reservationStatus;
      return Promise.resolve(
        status
          ? [{
              quota_day: "2026-09-04",
              account_scope_id: "boss-account-01",
              position_scope_id: "position-01",
              task_scope_id: "task-01",
              status
            }]
          : []
      );
    }
    if (text.startsWith("UPDATE quota_counters")) return Promise.resolve([{ id: "quota" }]);
    if (text.startsWith("UPDATE contact_attempts")) return Promise.resolve([{ id: "attempt" }]);
    if (text.startsWith("UPDATE contact_intents") && text.includes("RETURNING version")) {
      return Promise.resolve([{ version: 3 }]);
    }
    return Promise.resolve([]);
  }) as unknown as Database;
  Object.assign(transaction, {
    begin: (callback: (sql: Database) => Promise<unknown>) => callback(transaction),
    json: (value: unknown) => value
  });
  return { repository: new M2Repository(transaction), queries };
}

function uncertainResolutionRepository(): {
  repository: M2Repository;
  queries: RecordedQuery[];
  jsonValues: unknown[];
} {
  const queries: RecordedQuery[] = [];
  const jsonValues: unknown[] = [];
  const transaction = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = normalizedQuery(strings);
    queries.push({ text, values });
    if (text.startsWith("SELECT ci.id, ci.action_kind, ci.candidate_position_state_id")) {
      return Promise.resolve([{
        id: "10000000-0000-4000-8000-000000000001",
        action_kind: "message",
        candidate_position_state_id: "20000000-0000-4000-8000-000000000001",
        candidate_id: "70000000-0000-4000-8000-000000000001",
        task_id: "50000000-0000-4000-8000-000000000001",
        candidate_name: "测试候选人",
        position_name: "测试岗位",
        boss_account_id: "boss-account-01",
        source_locator: { kind: "boss_geek_id", value: "fixture_geek_123" },
        template_version_id: "80000000-0000-4000-8000-000000000001",
        provider_job_id: null,
        provider_greeting_id: null,
        rendered_message: "你好，想和你沟通一下这个岗位。",
        transport_mode: "real",
        status: "uncertain",
        created_by: "30000000-0000-4000-8000-000000000001",
        version: 4,
        created_at: new Date("2026-09-04T08:00:00.000Z"),
        last_error: "delivery result unavailable"
      }]);
    }
    if (text.includes("FROM contact_quota_reservations")) {
      return Promise.resolve([{
        quota_day: "2026-09-04",
        account_scope_id: "boss-account-01",
        position_scope_id: "position-01",
        task_scope_id: "task-01",
        status: "consumed"
      }]);
    }
    if (text.startsWith("UPDATE quota_counters")) return Promise.resolve([{ id: "quota" }]);
    if (text.startsWith("UPDATE contact_intents")) return Promise.resolve([{ version: 5 }]);
    return Promise.resolve([]);
  }) as unknown as Database;
  Object.assign(transaction, {
    begin: (callback: (sql: Database) => Promise<unknown>) => callback(transaction),
    json: (value: unknown) => {
      jsonValues.push(value);
      return value;
    }
  });
  return { repository: new M2Repository(transaction), queries, jsonValues };
}

type StaleRecoveryState = {
  quotas: Record<"account" | "position" | "task", { used: number; reserved: number }>;
  reservationStatus: "reserved" | "consumed" | "released";
  intentStatus: "processing" | "uncertain";
  candidateStatus: "queued" | "uncertain";
  attemptStatus: "processing" | "uncertain";
};

function staleRealRecoveryRepository(): {
  repository: M2Repository;
  queries: RecordedQuery[];
  state: StaleRecoveryState;
} {
  const queries: RecordedQuery[] = [];
  const state: StaleRecoveryState = {
    quotas: {
      account: { used: 0, reserved: 1 },
      position: { used: 0, reserved: 1 },
      task: { used: 0, reserved: 1 }
    },
    reservationStatus: "reserved",
    intentStatus: "processing",
    candidateStatus: "queued",
    attemptStatus: "processing"
  };
  const transaction = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = normalizedQuery(strings);
    queries.push({ text, values });
    if (text.startsWith("SELECT ci.id FROM contact_intents")) {
      return Promise.resolve([{ id: "10000000-0000-4000-8000-000000000001" }]);
    }
    if (text.startsWith("SELECT ci.id, ci.action_kind, ci.candidate_position_state_id")) {
      return Promise.resolve([{
        id: "10000000-0000-4000-8000-000000000001",
        action_kind: "message",
        candidate_position_state_id: "20000000-0000-4000-8000-000000000001",
        authorization_id: null,
        transport_mode: "real",
        version: 4,
        created_by: "30000000-0000-4000-8000-000000000001",
        attempt_no: 1
      }]);
    }
    if (text.includes("FROM contact_quota_reservations")) {
      return Promise.resolve([{
        quota_day: "2026-09-04",
        account_scope_id: "boss-account-01",
        position_scope_id: "position-01",
        task_scope_id: "task-01",
        status: state.reservationStatus
      }]);
    }
    if (text.startsWith("UPDATE quota_counters")) {
      const scopeType = values[0];
      if (scopeType !== "account" && scopeType !== "position" && scopeType !== "task") {
        return Promise.resolve([]);
      }
      const quota = state.quotas[scopeType];
      if (!text.includes("reserved = reserved - 1, used = used + 1") || quota.reserved < 1) {
        return Promise.resolve([]);
      }
      quota.reserved -= 1;
      quota.used += 1;
      return Promise.resolve([{ id: `quota-${scopeType}` }]);
    }
    if (text.startsWith("UPDATE contact_quota_reservations")) {
      if (values[0] === "consumed" && state.reservationStatus === "reserved") {
        state.reservationStatus = "consumed";
      }
      return Promise.resolve([]);
    }
    if (text.startsWith("UPDATE contact_attempts SET result = 'uncertain'")) {
      state.attemptStatus = "uncertain";
      return Promise.resolve([]);
    }
    if (text.startsWith("UPDATE contact_intents SET status = 'uncertain'")) {
      state.intentStatus = "uncertain";
      return Promise.resolve([{ version: 5 }]);
    }
    if (text.startsWith("UPDATE candidate_position_states SET contact_status = 'uncertain'")) {
      state.candidateStatus = "uncertain";
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }) as unknown as Database;
  Object.assign(transaction, {
    begin: (callback: (sql: Database) => Promise<unknown>) => callback(transaction),
    json: (value: unknown) => value
  });
  return { repository: new M2Repository(transaction), queries, state };
}

function greetingHistoryRepository(input: {
  sent: boolean;
  activeStatus: "ready" | "processing" | "uncertain" | null;
}): {
  repository: M2Repository;
  queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
  const transaction = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = normalizedQuery(strings);
    queries.push({ text, values });
    if (text.includes("WHERE ci.idempotency_key")) return Promise.resolve([]);
    if (text.startsWith("SELECT c.display_name AS candidate_name")) {
      return Promise.resolve([{
        candidate_name: "测试候选人",
        candidate_id: "70000000-0000-4000-8000-000000000001",
        position_name: "测试岗位",
        position_id: "90000000-0000-4000-8000-000000000001",
        department_id: "department-01",
        boss_account_id: "boss-account-01",
        task_id: "50000000-0000-4000-8000-000000000001",
        source: "recommend",
        review_status: "approved",
        resume_screening_status: "screened",
        rule_decision: "matched",
        rule_confidence: 1,
        contact_status: "not_contacted",
        is_current: true,
        last_cross_position_contact_at: null,
        emergency_stop: false,
        allowed_start_minute: 0,
        allowed_end_minute: 1_439,
        account_daily_limit: 20,
        position_daily_limit: 10,
        task_limit: 10,
        cross_position_cooldown_hours: 0,
        account_used: 0,
        position_used: 0,
        task_used: 0,
        source_locator: { kind: "boss_geek_id", value: "fixture_geek_123" },
        creator_status: "active",
        creator_role: "admin",
        creator_department_id: "department-01",
        creator_has_position_access: true
      }]);
    }
    if (text.startsWith("SELECT EXISTS (") && text.includes("same_position_action_sent")) {
      return Promise.resolve([{
        same_position_action_sent: input.sent,
        active_position_action_intent_status: input.activeStatus
      }]);
    }
    if (text.includes("FROM do_not_contact")) return Promise.resolve([]);
    if (text.startsWith("SELECT scope_type, scope_id, enabled")) {
      return Promise.resolve([
        ["global", "global"],
        ["department", "department-01"],
        ["position", "90000000-0000-4000-8000-000000000001"],
        ["task", "50000000-0000-4000-8000-000000000001"]
      ].map(([scope_type, scope_id]) => ({
        scope_type,
        scope_id,
        enabled: true,
        approval_required: false,
        approved_at: null,
        emergency_stop: false,
        approver_status: null,
        approver_role: null,
        approver_department_id: null
      })));
    }
    return Promise.resolve([]);
  }) as unknown as Database;
  Object.assign(transaction, {
    begin: (callback: (sql: Database) => Promise<unknown>) => callback(transaction),
    json: (value: unknown) => value
  });
  return { repository: new M2Repository(transaction), queries };
}

describe("contact dispatch persistence invariants", () => {
  it("blocks a second greeting after the same candidate and position was already greeted", async () => {
    const previousMode = process.env.BOSS_FORGE_CONTACT_DISPATCH_MODE;
    process.env.BOSS_FORGE_CONTACT_DISPATCH_MODE = "fake";
    const { repository, queries } = greetingHistoryRepository({
      sent: true,
      activeStatus: null
    });

    try {
      await expect(repository.createManualContactIntent({
        stateId: "20000000-0000-4000-8000-000000000099",
        actionKind: "greet",
        idempotencyKey: "a-new-idempotency-key-after-the-first-greeting",
        templateVersionId: null,
        providerJobId: "boss-job-001",
        providerGreetingId: "boss-greeting-002",
        renderedMessage: "你好，这是重新预览后得到的另一条岗位招呼语。",
        createdBy: "30000000-0000-4000-8000-000000000001",
        localMinuteOfDay: 600,
        now: "2026-09-04T02:00:00.000Z",
        transportMode: "fake"
      })).rejects.toThrow("same_position_already_contacted");
    } finally {
      if (previousMode === undefined) delete process.env.BOSS_FORGE_CONTACT_DISPATCH_MODE;
      else process.env.BOSS_FORGE_CONTACT_DISPATCH_MODE = previousMode;
    }

    expect(
      queries.some((query) => query.text.startsWith("INSERT INTO contact_intents"))
    ).toBe(false);
    expect(
      queries.some((query) =>
        query.text.includes("prior.action_kind = $value") &&
        query.values.includes("greet")
      )
    ).toBe(true);
  });

  it("blocks a second active greeting carried by an older task state", async () => {
    const previousMode = process.env.BOSS_FORGE_CONTACT_DISPATCH_MODE;
    process.env.BOSS_FORGE_CONTACT_DISPATCH_MODE = "fake";
    const { repository, queries } = greetingHistoryRepository({
      sent: false,
      activeStatus: "ready"
    });

    try {
      await expect(repository.createManualContactIntent({
        stateId: "20000000-0000-4000-8000-000000000099",
        actionKind: "greet",
        idempotencyKey: "a-new-key-for-a-new-task-state",
        templateVersionId: null,
        providerJobId: "boss-job-001",
        providerGreetingId: "boss-greeting-002",
        renderedMessage: "你好，这是当前岗位的招呼语。",
        createdBy: "30000000-0000-4000-8000-000000000001",
        localMinuteOfDay: 600,
        now: "2026-09-04T02:00:00.000Z",
        transportMode: "fake"
      })).rejects.toThrow("same_position_contact_already_active");
    } finally {
      if (previousMode === undefined) delete process.env.BOSS_FORGE_CONTACT_DISPATCH_MODE;
      else process.env.BOSS_FORGE_CONTACT_DISPATCH_MODE = previousMode;
    }

    expect(
      queries.some((query) => query.text.startsWith("INSERT INTO contact_intents"))
    ).toBe(false);
    expect(
      queries.some((query) =>
        query.text.includes("active_state.candidate_id = $value") &&
        query.text.includes("active_state.position_id = $value") &&
        query.text.includes("active.action_kind = $value") &&
        query.values.includes("greet")
      )
    ).toBe(true);
  });

  it("conservatively consumes quota for an uncertain real delivery", async () => {
    const { repository, queries } = completionRepository();

    await repository.finishContactDispatch({
      job: dispatchJob("real"),
      result: "uncertain",
      errorMessage: "delivery result unavailable"
    });

    const quotaUpdates = queries.filter((query) =>
      query.text.startsWith("UPDATE quota_counters")
    );
    expect(quotaUpdates).toHaveLength(3);
    expect(quotaUpdates.every((query) => query.text.includes("used = used + 1"))).toBe(true);
    const reservationUpdate = queries.find((query) =>
      query.text.startsWith("UPDATE contact_quota_reservations")
    );
    expect(reservationUpdate?.text).toContain("SET status = 'consumed'");
  });

  it("does not overwrite an intent that stale recovery already made terminal", async () => {
    const { repository, queries } = completionRepository({ intentProcessing: false });

    await expect(
      repository.finishContactDispatch({
        job: dispatchJob("real"),
        result: "sent",
        externalMessage: "late success"
      })
    ).rejects.toThrow("terminal result cannot be overwritten");

    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain("status = 'processing'");
    expect(queries.some((query) => query.text.startsWith("UPDATE contact_intents"))).toBe(false);
  });

  it("requires the exact processing attempt before finalizing", async () => {
    const { repository, queries } = completionRepository({ attemptProcessing: false });

    await expect(
      repository.finishContactDispatch({
        job: dispatchJob("real"),
        result: "uncertain"
      })
    ).rejects.toThrow("Processing contact attempt was not found");

    expect(queries).toHaveLength(2);
    expect(queries.some((query) => query.text.startsWith("UPDATE contact_intents"))).toBe(false);
  });

  it("projects a greeting result onto candidate contact status", async () => {
    const { repository, queries } = completionRepository({ reservationStatus: null });
    const job = {
      ...dispatchJob("fake"),
      actionKind: "greet" as const,
      templateVersionId: null,
      providerJobId: "boss-job-001",
      providerGreetingId: "boss-greeting-001"
    };

    await repository.finishContactDispatch({ job, result: "simulated" });

    expect(
      queries.some((query) =>
        query.text.startsWith("UPDATE candidate_position_states SET contact_status")
      )
    ).toBe(true);
    expect(
      queries.find((query) => query.text.startsWith("UPDATE contact_intents"))?.values
    ).toContain("greet");
  });

  it("releases conservatively consumed quota only after a manager verifies not sent", async () => {
    const { repository, queries, jsonValues } = uncertainResolutionRepository();

    const resolved = await repository.resolveUncertainContactAsNotSent({
      intentId: "10000000-0000-4000-8000-000000000001",
      actorId: "60000000-0000-4000-8000-000000000001",
      expectedVersion: 4,
      actionKind: "message",
      candidateStateId: "20000000-0000-4000-8000-000000000001",
      candidateId: "70000000-0000-4000-8000-000000000001",
      candidateName: "测试候选人",
      taskId: "50000000-0000-4000-8000-000000000001",
      bossAccountId: "boss-account-01",
      templateVersionId: "80000000-0000-4000-8000-000000000001",
      providerJobId: null,
      providerGreetingId: null,
      renderedMessageSha256: contactMessageSha256("你好，想和你沟通一下这个岗位。"),
      sourceLocatorSha256: contactSourceLocatorSha256({
        kind: "boss_geek_id",
        value: "fixture_geek_123"
      })
    });

    expect(resolved.status).toBe("failed");
    const quotaUpdates = queries.filter((query) =>
      query.text.startsWith("UPDATE quota_counters")
    );
    expect(quotaUpdates).toHaveLength(3);
    expect(quotaUpdates.every((query) => query.text.includes("used = used - 1"))).toBe(true);
    expect(
      queries.find((query) => query.text.startsWith("UPDATE contact_quota_reservations"))
        ?.text
    ).toContain("SET status = 'released'");
    expect(jsonValues).toContainEqual(expect.objectContaining({
      actionKind: "message",
      candidateStateId: "20000000-0000-4000-8000-000000000001",
      candidateId: "70000000-0000-4000-8000-000000000001",
      priorAttemptResultPreserved: "uncertain",
      quotaReservationReleased: true
    }));
    expect(
      queries.some((query) => query.text.startsWith("UPDATE contact_attempts"))
    ).toBe(false);
  });

  it("rejects stale or mismatched manual verification before changing quota", async () => {
    const { repository, queries } = uncertainResolutionRepository();

    await expect(repository.resolveUncertainContactAsNotSent({
      intentId: "10000000-0000-4000-8000-000000000001",
      actorId: "60000000-0000-4000-8000-000000000001",
      expectedVersion: 4,
      actionKind: "message",
      candidateStateId: "20000000-0000-4000-8000-000000000001",
      candidateId: "70000000-0000-4000-8000-000000000001",
      candidateName: "同名但不是同一条记录",
      taskId: "50000000-0000-4000-8000-000000000001",
      bossAccountId: "boss-account-01",
      templateVersionId: "80000000-0000-4000-8000-000000000001",
      providerJobId: null,
      providerGreetingId: null,
      renderedMessageSha256: contactMessageSha256("你好，想和你沟通一下这个岗位。"),
      sourceLocatorSha256: contactSourceLocatorSha256({
        kind: "boss_geek_id",
        value: "fixture_geek_123"
      })
    })).rejects.toThrow("attestation no longer matches");

    expect(
      queries.some((query) => query.text.startsWith("UPDATE quota_counters"))
    ).toBe(false);
  });

  it("recovers a stale real dispatch as uncertain and consumes its reservation", async () => {
    const { repository, queries, state } = staleRealRecoveryRepository();

    const recovered = await repository.recoverStaleContactDispatches(
      "boss-account-01",
      "real"
    );

    expect(recovered).toBe(1);
    expect(state.quotas).toEqual({
      account: { used: 1, reserved: 0 },
      position: { used: 1, reserved: 0 },
      task: { used: 1, reserved: 0 }
    });
    expect(state.reservationStatus).toBe("consumed");
    expect(state.intentStatus).toBe("uncertain");
    expect(state.candidateStatus).toBe("uncertain");
    expect(state.attemptStatus).toBe("uncertain");
    expect(
      queries.filter((query) => query.text.startsWith("UPDATE quota_counters"))
    ).toHaveLength(3);
    expect(
      queries.some((query) => query.text.includes("'contact.real_stale_uncertain'"))
    ).toBe(true);
  });
});
