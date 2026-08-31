import { describe, expect, it } from "vitest";
import { assertRealGreetExecutionAllowed } from "./contact-safety.js";

describe("real greeting safety gate", () => {
  it("requires both independent approvals", () => {
    expect(() => assertRealGreetExecutionAllowed([], {})).toThrow("--approve-real-greet");
    expect(() => assertRealGreetExecutionAllowed(["--approve-real-greet"], {})).toThrow(
      "BOSS_FORGE_REAL_GREET_ENABLED"
    );
    expect(() =>
      assertRealGreetExecutionAllowed(["--approve-real-greet"], {
        BOSS_FORGE_REAL_GREET_ENABLED: "1"
      })
    ).not.toThrow();
  });
});
