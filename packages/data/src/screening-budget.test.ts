import { describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import { BossForgeRepository } from "./repository.js";
import {
  screeningBudgetMetWaitExcludedSql,
  screeningBudgetStillOpenSql,
  screeningTerminalWaitExcludedSql,
} from "./screening-budget.js";

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

type BudgetState = {
  autoGreet: boolean;
  candidateLimit: number;
  candidateCount: number;
  sent: number;
  passes: number;
  processing?: boolean;
  status?: "waiting_review" | "completed" | "screening";
};

function fakeRepository(state: BudgetState) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = queryText(strings, values);
    calls.push({ text, values });
    if (text.includes("SELECT status, candidate_count, candidate_limit, wait_reason_code")) {
      return Promise.resolve([
        {
          status: state.status ?? "waiting_review",
          candidate_count: state.candidateCount,
          candidate_limit: state.candidateLimit,
          wait_reason_code: null,
        },
      ]);
    }
    if (text.includes("SELECT status, candidate_limit, auto_greet, wait_reason_code")) {
      return Promise.resolve([
        {
          status: state.status ?? "waiting_review",
          candidate_limit: state.candidateLimit,
          auto_greet: state.autoGreet,
          wait_reason_code: null,
        },
      ]);
    }
    if (text.includes("AS sent") && text.includes("AS passes")) {
      if (
        !text.includes("rule_decision = 'matched'") ||
        !text.includes("resume_screening_status = 'screened'") ||
        !text.includes("action_kind = 'greet'") ||
        !text.includes("status = 'sent'")
      ) {
        throw new Error("budget count must ignore failed and not_matched rows");
      }
      return Promise.resolve([{ sent: state.sent, passes: state.passes }]);
    }
    if (text.includes("resume_screening_status = 'processing'")) {
      return Promise.resolve(state.processing ? [{ id: "inflight" }] : []);
    }
    return Promise.resolve([]);
  }) as unknown as Database;
  Object.assign(sql, {
    begin: (callback: (transaction: Database) => Promise<unknown>) => callback(sql),
    unsafe: (fragment: string) => ({ __fragment: fragment }),
    json: (value: unknown) => value,
  });
  return { calls, repository: new BossForgeRepository(sql) };
}

function valuesOf(calls: Array<{ values: unknown[] }>): unknown[] {
  return calls.flatMap((call) => call.values);
}

describe("screening budget SQL", () => {
  it("counts greets only when auto-greet is on and matched screened rows otherwise", () => {
    const sql = screeningBudgetStillOpenSql("earlier");
    expect(sql).toContain("WHEN earlier.auto_greet");
    expect(sql).toContain("sent_budget.status = 'sent'");
    expect(sql).toContain("pass_budget.rule_decision = 'matched'");
    expect(sql).toContain("pass_budget.resume_screening_status = 'screened'");
    expect(sql).not.toContain("not_matched");
    expect(sql).not.toContain("'failed'");
    expect(screeningTerminalWaitExcludedSql("earlier.wait_reason_code")).toContain(
      "screening_pass_target_met",
    );
    expect(screeningBudgetMetWaitExcludedSql("tasks.wait_reason_code")).not.toContain(
      "screening_pool_exhausted",
    );
    expect(() => screeningBudgetStillOpenSql("earlier;drop")).toThrow(/alias/);
  });
});

describe("continueScreeningChunk budget", () => {
  it("stops auto-greet off at N matched passes and does not requeue", async () => {
    const { calls, repository } = fakeRepository({
      autoGreet: false,
      candidateLimit: 2,
      candidateCount: 8,
      sent: 0,
      passes: 2,
    });

    await expect(repository.continueScreeningChunk("task-pass")).resolves.toBe(false);

    const values = valuesOf(calls);
    expect(values).toContain("screening_pass_target_met");
    expect(values).toContain("waiting_review");
    expect(values).not.toContain("queued");
    expect(calls.some((call) => call.text.includes("resume_screening_status = 'not_requested'"))).toBe(
      true,
    );
    expect(
      calls.some((call) =>
        call.text.includes("resume_screening_status IN ('queued', 'processing')"),
      ),
    ).toBe(true);
  });

  it("keeps screening when failed and not_matched rows leave the pass count under the limit", async () => {
    const { calls, repository } = fakeRepository({
      autoGreet: false,
      candidateLimit: 3,
      candidateCount: 8,
      sent: 0,
      passes: 2,
    });

    await expect(repository.continueScreeningChunk("task-pass")).resolves.toBe(true);
    expect(calls.some((call) => call.text.includes("status = 'queued'"))).toBe(true);
    expect(valuesOf(calls)).not.toContain("screening_pass_target_met");
  });

  it("stops auto-greet on at N successful greets even when passes already exceed the limit", async () => {
    const { calls, repository } = fakeRepository({
      autoGreet: true,
      candidateLimit: 100,
      candidateCount: 340,
      sent: 100,
      passes: 340,
    });

    await expect(repository.continueScreeningChunk("task-greet")).resolves.toBe(false);
    const values = valuesOf(calls);
    expect(values).toContain("greet_target_met");
    expect(values).not.toContain("screening_pass_target_met");
    expect(values).not.toContain("queued");
  });

  it("continues an auto-greet task while successful greets are still under the limit", async () => {
    const { calls, repository } = fakeRepository({
      autoGreet: true,
      candidateLimit: 100,
      candidateCount: 340,
      sent: 99,
      passes: 340,
    });

    await expect(repository.continueScreeningChunk("task-greet")).resolves.toBe(true);
    const values = valuesOf(calls);
    expect(calls.some((call) => call.text.includes("status = 'queued'"))).toBe(true);
    expect(values).not.toContain("greet_target_met");
    expect(values).not.toContain("screening_pass_target_met");
  });

  it("parks an already-overshot screening task, including a resume left in processing", async () => {
    const { calls, repository } = fakeRepository({
      autoGreet: false,
      candidateLimit: 100,
      candidateCount: 345,
      sent: 0,
      passes: 100,
      processing: true,
      status: "screening",
    });

    await expect(repository.sealScreeningBudgetIfMet("task-amazon")).resolves.toBe(true);
    const values = valuesOf(calls);
    expect(values).toContain("screening_pass_target_met");
    expect(values).toContain("waiting_review");
    expect(values).not.toContain("queued");
    expect(
      calls.some((call) =>
        call.text.includes("resume_screening_status IN ('queued', 'processing')"),
      ),
    ).toBe(true);
  });
});

describe("sealAccountTasksAtScreeningBudget", () => {
  it("selects tasks whose mode-specific budget is already closed", async () => {
    const calls: string[] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(queryText(strings, values));
      return Promise.resolve([]);
    }) as unknown as Database;
    Object.assign(sql, {
      begin: (callback: (transaction: Database) => Promise<unknown>) => callback(sql),
      unsafe: (fragment: string) => ({ __fragment: fragment }),
      json: (value: unknown) => value,
    });
    const repository = new BossForgeRepository(sql);

    await expect(repository.sealAccountTasksAtScreeningBudget("boss-account")).resolves.toEqual([]);

    const query = calls.join("\n");
    expect(query).toContain("WHEN t.auto_greet");
    expect(query).toContain("pass_budget.rule_decision = 'matched'");
    expect(query).toContain("pass_budget.resume_screening_status = 'screened'");
    expect(query).toContain("screening_pass_target_met");
    expect(query).toContain("sent_budget.status = 'sent'");
    expect(query).toContain(
      "t.status IN ('queued', 'running', 'screening', 'waiting_review', 'completed')",
    );
    expect(query).not.toContain("interval '15 minutes'");
  });
});
