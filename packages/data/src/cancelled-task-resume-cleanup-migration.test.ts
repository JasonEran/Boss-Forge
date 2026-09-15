import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/025_cancelled_task_resume_cleanup.sql", import.meta.url),
  "utf8",
);

describe("cancelled task resume cleanup migration", () => {
  it("idempotently parks only unfinished resume states owned by cancelled tasks", () => {
    expect(migration).toContain("task.status = 'cancelled'");
    expect(migration).toContain(
      "cps.resume_screening_status IN ('queued', 'processing')",
    );
    expect(migration).toContain("resume_screening_status = 'not_requested'");
    expect(migration).toContain("resume_screening_attempts = 0");
    expect(migration).toContain("resume_screening_claimed_by = NULL");
    expect(migration).toContain("resume_screening_claimed_at = NULL");
    expect(migration).toContain("resume_screening_error = NULL");
    expect(migration).toContain("resume_screening_error_code = NULL");
    expect(migration).toContain("resume_screening_next_attempt_at = NULL");
  });

  it("preserves records and writes an audit trail without touching outbound data", () => {
    expect(migration).not.toMatch(/\bDELETE\b/iu);
    expect(migration).not.toContain("contact_");
    expect(migration).toContain(
      "candidate.resume_screening.cancelled_state_repaired",
    );
    expect(migration).toContain("previousResumeScreeningStatus");
    expect(migration).toContain("resultingResumeScreeningStatus");
  });
});
