import { describe, expect, it } from "vitest";
import { assertIsolatedTestDatabase } from "./test-safety.js";

describe("integration test database safety", () => {
  it("accepts a disposable loopback test database", () => {
    expect(() =>
      assertIsolatedTestDatabase(
        { DATABASE_URL: "postgres://user:secret@127.0.0.1:65439/boss_forge_e2e" },
        { contactSideEffects: false }
      )
    ).not.toThrow();
  });

  it("refuses production, remote and misleading database names", () => {
    for (const databaseUrl of [
      "postgres://user:secret@127.0.0.1:5432/boss_forge",
      "postgres://user:secret@database.internal:5432/boss_forge_test",
      "postgres://user:secret@127.0.0.1:5432/contest"
    ]) {
      expect(() =>
        assertIsolatedTestDatabase(
          { DATABASE_URL: databaseUrl },
          { contactSideEffects: false }
        )
      ).toThrow();
    }
  });

  it("requires a second explicit gate before creating contact test data", () => {
    const environment = {
      DATABASE_URL: "postgres://user:secret@localhost:5432/boss_forge_test"
    };
    expect(() =>
      assertIsolatedTestDatabase(environment, { contactSideEffects: true })
    ).toThrow(/Contact test data is disabled/u);
    expect(() =>
      assertIsolatedTestDatabase(
        {
          ...environment,
          BOSS_FORGE_ALLOW_CONTACT_TEST_DATA: "I_UNDERSTAND_ISOLATED_ONLY"
        },
        { contactSideEffects: true }
      )
    ).not.toThrow();
  });
});
