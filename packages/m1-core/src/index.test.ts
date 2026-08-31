import type { ParsedCandidate } from "@boss-forge/contracts";
import { describe, expect, it } from "vitest";
import { candidateFingerprint, evaluateCandidate } from "./index.js";

const rule = {
  requiredCapabilities: [{ capability: "tem8" as const, minimumConfidence: 0.9 }]
};

function candidate(overrides: Partial<ParsedCandidate> = {}): ParsedCandidate {
  return {
    index: 1,
    name: "陈雨欣",
    source: "recommend",
    fields: { 学历: "本科", 经验: "4年" },
    evidence: ["已取得 TEM-8 证书"],
    raw: "- 1. 陈雨欣｜学历:本科｜经验:4年",
    ...overrides
  };
}

describe("M1 candidate pipeline", () => {
  it("creates a stable fingerprint independent of field order", () => {
    const first = candidate();
    const second = candidate({ fields: { 经验: "4年", 学历: "本科" } });
    expect(candidateFingerprint(first)).toBe(candidateFingerprint(second));
  });

  it("stores a matched TEM8 result with original evidence", () => {
    const result = evaluateCandidate(candidate(), rule);
    expect(result.decision).toBe("matched");
    expect(result.dictionaryVersion).toBe("2026.08.1");
    expect(result.evidence[0]?.sourceText).toContain("TEM-8");
  });

  it("routes planned TEM8 claims to manual review", () => {
    const result = evaluateCandidate(
      candidate({ evidence: ["正在备考专八"], raw: "候选人优势" }),
      rule
    );
    expect(result.decision).toBe("ambiguous");
  });
});
