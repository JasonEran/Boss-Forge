import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/026_split_contact_actions.sql", import.meta.url),
  "utf8"
);

describe("split contact action migration", () => {
  it("backfills old intents as message and accepts only the two explicit actions", () => {
    expect(migration).toContain(
      "ADD COLUMN IF NOT EXISTS action_kind text NOT NULL DEFAULT 'message'"
    );
    expect(migration).toContain("CHECK (action_kind IN ('greet', 'message'))");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS provider_greeting_id text");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS provider_job_id text");
    expect(migration).toContain("ALTER COLUMN template_version_id DROP NOT NULL");
    expect(migration).toContain(
      "action_kind = 'message' AND template_version_id IS NOT NULL"
    );
    expect(migration).toContain(
      "action_kind = 'greet' AND template_version_id IS NULL"
    );
    expect(migration).toContain("provider_greeting_id IS NOT NULL");
    expect(migration).toContain("provider_job_id IS NOT NULL");
  });

  it("makes active idempotency independent per candidate and action", () => {
    expect(migration).toContain("DROP INDEX IF EXISTS contact_intents_active_candidate_uidx");
    expect(migration).toContain(
      "ON contact_intents (candidate_position_state_id, action_kind)"
    );
    expect(migration).toContain(
      "WHERE status IN ('ready', 'processing', 'sent', 'uncertain')"
    );
    expect(migration).not.toMatch(/\bDELETE\b/iu);
  });
});
