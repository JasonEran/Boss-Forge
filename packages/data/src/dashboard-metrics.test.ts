import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const repository = readFileSync(new URL("./repository.ts", import.meta.url), "utf8");

describe("dashboard metric semantics", () => {
  it("deduplicates people without hiding work from another current position", () => {
    const metricQueryStart = repository.indexOf("), candidate_metrics AS (");
    const metricQueryEnd = repository.indexOf("const metrics = metricRows[0]", metricQueryStart);
    const metricQuery = repository.slice(metricQueryStart, metricQueryEnd);
    expect(metricQueryStart).toBeGreaterThan(-1);
    expect(metricQuery).toContain("GROUP BY candidate_id");
    expect(metricQuery).toContain("BOOL_OR(");
    expect(metricQuery).toContain("AS has_match");
    expect(metricQuery).toContain("AS has_pending_review");
    expect(metricQuery).not.toContain("WHERE identity_rank = 1");
  });

  it("counts only confirmed real sent attempts in today's contact metric", () => {
    expect(repository).toContain("attempt.result = 'sent'");
    expect(repository).toContain("intent.transport_mode = 'real'");
    expect(repository).toContain("AT TIME ZONE 'Asia/Shanghai'");
  });

  it("uses the same semantic runtime-problem reasons in dashboard lists and details", () => {
    expect(repository).toContain("'semantic_model_error'");
    expect(repository).toContain("'semantic_model_unavailable'");
    expect(repository).toContain("'semantic_model_missing_result'");
    expect(repository).toContain("se.reason_codes ?| ARRAY[");
  });
});
