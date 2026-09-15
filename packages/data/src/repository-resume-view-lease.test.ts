import { describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import {
  BossForgeRepository,
  ResumeScreeningLeaseLostError,
} from "./repository.js";

function normalizedQuery(strings: TemplateStringsArray): string {
  return strings.join("$value").replace(/\s+/gu, " ").trim();
}

function repositoryForLease(input: { taskOpen: boolean; leaseActive: boolean }): {
  repository: BossForgeRepository;
  queries: string[];
  jsonValues: unknown[];
} {
  const queries: string[] = [];
  const jsonValues: unknown[] = [];
  const transaction = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
    const query = normalizedQuery(strings);
    queries.push(query);
    if (query.startsWith("SELECT t.id FROM tasks t")) {
      return Promise.resolve(input.taskOpen ? [{ id: "task-1" }] : []);
    }
    if (query.startsWith("SELECT cps.id FROM candidate_position_states cps")) {
      return Promise.resolve(input.leaseActive ? [{ id: "state-1" }] : []);
    }
    return Promise.resolve([]);
  }) as unknown as Database;
  Object.assign(transaction, {
    begin: (callback: (sql: Database) => Promise<unknown>) => callback(transaction),
    json: (value: unknown) => {
      jsonValues.push(value);
      return value;
    },
  });
  return {
    repository: new BossForgeRepository(transaction),
    queries,
    jsonValues,
  };
}

const view = {
  stateId: "10000000-0000-4000-8000-000000000001",
  candidateId: "20000000-0000-4000-8000-000000000001",
  taskId: "30000000-0000-4000-8000-000000000001",
  bossAccountId: "boss-account-01",
  workerId: "worker-01",
  openedAt: "2026-09-04T04:00:00.000Z",
};

describe("resume view lease validation", () => {
  it("locks the open task and exact processing lease before recording a view", async () => {
    const { repository, queries, jsonValues } = repositoryForLease({
      taskOpen: true,
      leaseActive: true,
    });

    await repository.recordResumeView(view);

    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain("t.status IN ('screening', 'waiting_review')");
    expect(queries[0]).toContain("p.boss_account_id = $value");
    expect(queries[0]).toContain("FOR UPDATE OF t");
    expect(queries[1]).toContain("cps.candidate_id = $value");
    expect(queries[1]).toContain("cps.latest_task_id = $value");
    expect(queries[1]).toContain("cps.resume_screening_status = 'processing'");
    expect(queries[1]).toContain("cps.resume_screening_claimed_by = $value");
    expect(queries[1]).toContain("cps.resume_screening_claimed_at IS NOT NULL");
    expect(queries[1]).toContain("FOR UPDATE OF cps");
    expect(queries[2]).toContain("'candidate.resume_viewed'");
    expect(jsonValues).toContainEqual({
      candidateId: view.candidateId,
      taskId: view.taskId,
      bossAccountId: view.bossAccountId,
    });
  });

  it("records nothing when the task was cancelled before the preview", async () => {
    const { repository, queries, jsonValues } = repositoryForLease({
      taskOpen: false,
      leaseActive: true,
    });

    const error = await repository.recordResumeView(view).catch((caught) => caught);
    expect(error).toBeInstanceOf(ResumeScreeningLeaseLostError);
    expect(error).toHaveProperty("message", expect.stringContaining("未打开 BOSS 简历"));
    expect(queries).toHaveLength(1);
    expect(queries.every((query) => !query.includes("INSERT INTO audit_logs"))).toBe(true);
    expect(jsonValues).toEqual([]);
  });

  it("records nothing when candidate, task, status, or worker claim no longer matches", async () => {
    const { repository, queries, jsonValues } = repositoryForLease({
      taskOpen: true,
      leaseActive: false,
    });

    await expect(repository.recordResumeView(view)).rejects.toBeInstanceOf(
      ResumeScreeningLeaseLostError,
    );
    expect(queries).toHaveLength(2);
    expect(queries.every((query) => !query.includes("INSERT INTO audit_logs"))).toBe(true);
    expect(jsonValues).toEqual([]);
  });
});
