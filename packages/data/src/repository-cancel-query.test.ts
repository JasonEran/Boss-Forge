import { describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import { BossForgeRepository } from "./repository.js";

function normalizedQuery(strings: TemplateStringsArray): string {
  return strings.join("$value").replace(/\s+/gu, " ").trim();
}

describe("task cancellation query", () => {
  it("parks only unfinished resume work without touching contact data or evidence", async () => {
    const queries: string[] = [];
    const jsonValues: unknown[] = [];
    const cancelledTaskRow = {
      id: "10000000-0000-4000-8000-000000000001",
      idempotency_key: "task-request",
      position_id: "20000000-0000-4000-8000-000000000001",
      position_name: "测试岗位",
      boss_account_id: "boss-account",
      boss_job_keyword: "测试岗位",
      rule_version_id: "30000000-0000-4000-8000-000000000001",
      rule_version: 1,
      dictionary_version: "test-v1",
      rule_config: {},
      execution_mode: "immediate",
      source: "recommend",
      search_keyword: null,
      status: "cancelled",
      created_by: "operator",
      candidate_count: 2,
      new_candidate_count: 2,
      repeat_candidate_count: 0,
      error_message: null,
      wait_reason_code: null,
      wait_reason: null,
      next_run_at: null,
      claim_token: null,
      version: 8,
      created_at: new Date("2026-09-04T00:00:00.000Z"),
    };

    const transaction = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
      const query = normalizedQuery(strings);
      queries.push(query);
      if (query.includes("SELECT status, version FROM tasks")) {
        return Promise.resolve([{ status: "screening", version: 7 }]);
      }
      if (
        query.includes("UPDATE candidate_position_states") &&
        query.includes("RETURNING id")
      ) {
        return Promise.resolve([{ id: "state-1" }, { id: "state-2" }]);
      }
      return Promise.resolve([]);
    }) as unknown as Database;
    Object.assign(transaction, {
      begin: (callback: (sql: Database) => Promise<unknown>) => callback(transaction),
      unsafe: () => Promise.resolve([cancelledTaskRow]),
      json: (value: unknown) => {
        jsonValues.push(value);
        return value;
      },
    });

    const repository = new BossForgeRepository(transaction);
    const result = await repository.cancelTask({
      taskId: cancelledTaskRow.id,
      idempotencyKey: "cancel-request",
      expectedVersion: 7,
      actorId: "operator",
    });

    const candidateUpdate = queries.find((query) =>
      query.includes("UPDATE candidate_position_states"),
    );
    expect(result.status).toBe("cancelled");
    expect(candidateUpdate).toContain("resume_screening_status = 'not_requested'");
    expect(candidateUpdate).toContain(
      "resume_screening_status IN ('queued', 'processing')",
    );
    expect(candidateUpdate).toContain("resume_screening_attempts = 0");
    expect(candidateUpdate).toContain("resume_screening_claimed_by = NULL");
    expect(candidateUpdate).toContain("resume_screening_claimed_at = NULL");
    expect(candidateUpdate).toContain("resume_screening_error = NULL");
    expect(candidateUpdate).toContain("resume_screening_error_code = NULL");
    expect(candidateUpdate).toContain("resume_screening_next_attempt_at = NULL");
    expect(candidateUpdate).not.toContain("contact_status");
    expect(candidateUpdate).not.toContain("match_evidence");
    expect(jsonValues).toContainEqual({
      expectedVersion: 7,
      resultingVersion: 8,
      cancelledResumeScreeningCount: 2,
    });
  });
});
