import { describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import {
  BossForgeRepository,
  candidateNextAction,
  resumeScreeningFailureRecoverable,
  semanticReasonCodesIndicateRuntimeProblem,
} from "./repository.js";

function queryText(strings: TemplateStringsArray, values: unknown[]): string {
  return strings.reduce((query, part, index) => {
    const value = values[index];
    const inline =
      value && typeof value === "object" && value !== null && "__fragment" in value
        ? String((value as { __fragment: string }).__fragment)
        : "$value";
    return `${query}${part}${index < values.length ? inline : ""}`;
  }, "");
}

function attachUnsafe(sql: object): void {
  Object.assign(sql, {
    unsafe: (fragment: string) => ({ __fragment: fragment }),
  });
}

describe("resume screening wait query", () => {
  it("only permits retries for errors that are safe to reopen", () => {
    expect(resumeScreeningFailureRecoverable("content_empty")).toBe(true);
    expect(resumeScreeningFailureRecoverable("content_incomplete")).toBe(true);
    expect(resumeScreeningFailureRecoverable("ocr_failed")).toBe(true);
    expect(resumeScreeningFailureRecoverable("source_expired")).toBe(true);
    expect(resumeScreeningFailureRecoverable("target_missing")).toBe(true);
    expect(resumeScreeningFailureRecoverable(null)).toBe(true);
    expect(resumeScreeningFailureRecoverable("risk_control")).toBe(false);
    expect(resumeScreeningFailureRecoverable("target_changed")).toBe(false);
    expect(resumeScreeningFailureRecoverable("target_ambiguous")).toBe(false);
  });

  it("treats an unavailable or incomplete semantic provider as a runtime problem", () => {
    expect(semanticReasonCodesIndicateRuntimeProblem(["semantic_model_unavailable"])).toBe(true);
    expect(semanticReasonCodesIndicateRuntimeProblem(["semantic_model_missing_result"])).toBe(true);
    expect(semanticReasonCodesIndicateRuntimeProblem(["semantic_model_error"])).toBe(true);
    expect(semanticReasonCodesIndicateRuntimeProblem(["semantic_alias_matched"])).toBe(false);
  });

  it("qualifies task columns when the update joins positions", async () => {
    const queries: string[] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push(
        strings.reduce(
          (query, part, index) => `${query}${part}${index < values.length ? "$value" : ""}`,
          "",
        ),
      );
      return Promise.resolve([]);
    }) as unknown as Database;

    const repository = new BossForgeRepository(sql);
    await repository.markResumeScreeningWait({
      bossAccountId: "boss-account",
      code: "outside_working_hours",
      reason: "工作时段外暂停",
      nextRunAt: new Date("2026-09-04T01:00:00.000Z"),
    });

    const query = queries.join("\n").replace(/\s+/gu, " ");
    expect(query).toContain("last_progress_at = COALESCE(t.last_progress_at, now())");
    expect(query).toContain("version = t.version + 1");
  });

  it("clears only account-wide policy waits after the caller observes ready", async () => {
    const queries: string[] = [];
    const values: unknown[] = [];
    const sql = ((strings: TemplateStringsArray, ...parameters: unknown[]) => {
      queries.push(
        strings.reduce(
          (query, part, index) => `${query}${part}${index < parameters.length ? "$value" : ""}`,
          "",
        ),
      );
      values.push(...parameters);
      return Promise.resolve([{ id: "task-1" }, { id: "task-2" }]);
    }) as unknown as Database;

    const repository = new BossForgeRepository(sql);
    const cleared = await repository.clearResumeScreeningWait("boss-account");

    const query = queries.join("\n").replace(/\s+/gu, " ");
    expect(cleared).toBe(2);
    expect(values).toContain("boss-account");
    expect(query).toContain("t.status = 'screening'");
    expect(query).toContain("cps.resume_screening_status = 'queued'");
    expect(query).toContain("'outside_working_hours'");
    expect(query).toContain("'daily_hard_limit_reached'");
    expect(query).toContain("'hourly_quota_reached'");
    expect(query).toContain("'daily_quota_reached'");
    expect(query).not.toContain("'batch_break'");
    expect(query).not.toContain("'resume_retry_scheduled'");
  });

  it("explains that a cancelled parent task will not keep viewing a candidate", () => {
    expect(
      candidateNextAction({
        taskStatus: "cancelled",
        resumeStatus: "not_requested",
        errorCode: null,
        reviewStatus: "pending",
        contactStatus: "not_contacted",
        nextAttemptAt: null,
      }),
    ).toBe("所属任务已取消，不会继续查看");
  });

  it("suppresses a candidate viewed today even when a later task has a new state id", async () => {
    const queries: string[] = [];
    const transaction = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push(queryText(strings, values));
      return Promise.resolve([]);
    }) as unknown as Database;
    const sql = transaction as unknown as {
      begin: (callback: (value: Database) => Promise<unknown>) => Promise<unknown>;
    };
    sql.begin = (callback: (value: Database) => Promise<unknown>) => callback(transaction);
    attachUnsafe(transaction);

    const repository = new BossForgeRepository(transaction);
    await repository.claimNextResumeScreening(
      "worker",
      "boss-account",
      new Date("2026-09-04T00:00:00.000Z"),
    );

    const query = queries.join("\n").replace(/\s+/gu, " ");
    expect(query).toContain(
      "audit_logs.payload ->> 'candidateId' = candidate_position_states.candidate_id::text",
    );
    expect(query).toContain(
      "resume_view.payload ->> 'candidateId' = candidate_position_states.candidate_id::text",
    );
    expect(query).toContain("candidate.resume_screening.retry_authorized");
    expect(query).not.toContain(
      "AND ( ( resume_screening_status = 'processing' AND resume_screening_claimed_at < now() - interval '15 minutes' ) OR $value::timestamptz IS NULL",
    );
  });

  it("reclaims mid-flight resumes viewed on this CPS without requiring retry_authorized", async () => {
    const queries: string[] = [];
    const transaction = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push(queryText(strings, values));
      return Promise.resolve([]);
    }) as unknown as Database;
    Object.assign(transaction, {
      begin: (callback: (sql: Database) => Promise<unknown>) => callback(transaction),
    });
    attachUnsafe(transaction);

    const repository = new BossForgeRepository(transaction);
    await expect(
      repository.claimNextResumeScreening(
        "worker",
        "boss-account",
        new Date("2026-09-04T00:00:00.000Z"),
      ),
    ).resolves.toBeNull();

    const query = queries.join("\n").replace(/\s+/gu, " ");
    // Same-CPS mid-flight view may reclaim while still queued / stale processing.
    expect(query).toContain("mid_flight_view.action = 'candidate.resume_viewed'");
    expect(query).toContain(
      "mid_flight_view.resource_type = 'candidate_position_state'",
    );
    expect(query).toContain(
      "mid_flight_view.resource_id = candidate_position_states.id::text",
    );
    // Mid-flight EXISTS block itself stays scoped to this CPS id.
    const midFlightStart = query.indexOf("mid_flight_view.action");
    const midFlightEnd = query.indexOf(")", midFlightStart);
    const midFlightBlock = query.slice(midFlightStart, midFlightEnd);
    expect(midFlightBlock).toContain(
      "mid_flight_view.resource_id = candidate_position_states.id::text",
    );
    expect(midFlightBlock).not.toContain("payload");
    expect(midFlightBlock).not.toContain("candidateId");
    expect(query).toContain("candidate.resume_screening.retry_authorized");
    expect(query).toContain("greet_target_met");
    expect(query).toContain("screening_pass_target_met");
    expect(query).toContain("sent_budget.status = 'sent'");
    expect(query).toContain("pass_budget.rule_decision = 'matched'");
    expect(query).toContain("pass_budget.resume_screening_status = 'screened'");
    expect(query).toContain("WHEN tasks.auto_greet");
    expect(query).toContain("COALESCE(earlier_schedule.created_at, earlier.created_at)");
  });

  it("reclaims unfinished claimable CPS blocked only by same-day candidateId views", async () => {
    const queries: string[] = [];
    const transaction = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push(queryText(strings, values));
      return Promise.resolve([]);
    }) as unknown as Database;
    Object.assign(transaction, {
      begin: (callback: (sql: Database) => Promise<unknown>) => callback(transaction),
    });
    attachUnsafe(transaction);

    const repository = new BossForgeRepository(transaction);
    await expect(
      repository.claimNextResumeScreening(
        "worker",
        "boss-account",
        new Date("2026-09-22T00:00:00.000Z"),
      ),
    ).resolves.toBeNull();

    const query = queries.join("\n").replace(/\s+/gu, " ");
    expect(query).toContain("FROM candidate_position_states other_done");
    expect(query).toContain(
      "other_done.candidate_id = candidate_position_states.candidate_id",
    );
    expect(query).toContain("other_done.id <> candidate_position_states.id");
    expect(query).toContain(
      "other_done.resume_screening_status IN ( 'screened', 'failed', 'no_text' )",
    );
    // Finished same-candidate screens today still suppress; mere views do not.
    const orphanBlock = query.slice(
      query.indexOf("FROM candidate_position_states other_done"),
      query.indexOf("ORDER BY is_repeat"),
    );
    expect(orphanBlock).not.toContain("candidate.resume_viewed");
  });

  it("checks claimable same-account contacts in the same atomic resume claim query", async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const transaction = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({
        text: queryText(strings, values).replace(/\s+/gu, " ").trim(),
        values,
      });
      return Promise.resolve([]);
    }) as unknown as Database;
    Object.assign(transaction, {
      begin: (callback: (sql: Database) => Promise<unknown>) => callback(transaction),
    });
    attachUnsafe(transaction);

    const repository = new BossForgeRepository(transaction);
    await expect(repository.claimNextResumeScreening(
      "resume-worker",
      "boss-account-01",
      new Date("2026-09-04T00:00:00.000Z"),
      "real",
    )).resolves.toBeNull();

    expect(queries).toHaveLength(1);
    const claim = queries[0]!;
    expect(claim.text).toContain("OR NOT EXISTS ( SELECT 1 FROM contact_intents priority_intent");
    expect(claim.text).toContain("priority_position.boss_account_id = $value");
    expect(claim.text).toContain("priority_intent.status = 'ready'");
    expect(claim.text).toContain("priority_intent.transport_mode = $value");
    expect(claim.text).toContain("priority_event.event_type = 'contact.requested'");
    expect(claim.text).toContain("priority_event.status = 'pending'");
    expect(claim.text).toContain("priority_event.available_at <= now()");
    expect(claim.text.indexOf("contact_intents priority_intent")).toBeLessThan(
      claim.text.indexOf("FOR UPDATE SKIP LOCKED"),
    );
    expect(claim.values.filter((value) => value === "boss-account-01")).toHaveLength(2);
    expect(claim.values.filter((value) => value === "real")).toHaveLength(2);
  });

  it("claims the oldest schedule on an account before a later overlapping task", async () => {
    const queries: string[] = [];
    const transaction = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push(queryText(strings, values));
      return Promise.resolve([]);
    }) as unknown as Database & ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>);
    Object.assign(transaction, {
      begin: (callback: (sql: Database) => Promise<unknown>) => callback(transaction),
    });
    attachUnsafe(transaction);
    const repository = new BossForgeRepository(transaction as unknown as Database);
    await expect(repository.claimNextTask("worker", "boss-account")).resolves.toBeNull();
    const query = queries.join("\n").replace(/\s+/gu, " ");
    expect(query).toContain("COALESCE(s.created_at, t.created_at)");
    expect(query).toContain("COALESCE(earlier_schedule.created_at, earlier.created_at)");
    expect(query).toContain("sent_budget.status = 'sent'");
    expect(query).toContain("pass_budget.rule_decision = 'matched'");
    expect(query).toContain("screening_pass_target_met");
    expect(query).toContain("screening_pool_exhausted");
    expect(query).toContain("ORDER BY COALESCE(s.created_at, t.created_at) ASC, t.created_at ASC, t.id ASC");
  });
});
