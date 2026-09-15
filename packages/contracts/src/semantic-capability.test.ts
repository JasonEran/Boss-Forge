import { describe, expect, it } from "vitest";
import { SEMANTIC_ACTIVE_DECISIONS_AVAILABLE } from "./semantic-capability.js";

describe("semantic decision capability", () => {
  it("keeps unaccepted semantic evaluation in shadow mode", () => {
    expect(SEMANTIC_ACTIVE_DECISIONS_AVAILABLE).toBe(false);
  });
});

