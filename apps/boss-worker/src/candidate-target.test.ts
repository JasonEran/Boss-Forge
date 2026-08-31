import type { ParsedCandidate } from "@boss-forge/contracts";
import { describe, expect, it } from "vitest";
import { selectUnambiguousCandidateTarget } from "./candidate-target.js";

function candidate(index: number, name: string, info: string): ParsedCandidate {
  return {
    index,
    name,
    source: "recommend",
    fields: { "信息": info, "经验": "5年" },
    evidence: ["TEM8"],
    raw: `${index}. ${name}｜信息:${info}`
  };
}

describe("candidate target safety", () => {
  it("selects the single refreshed candidate with the same stable fingerprint", () => {
    const expected = candidate(1, "王女士", "上海｜本科");
    expect(selectUnambiguousCandidateTarget(expected, [expected]).name).toBe("王女士");
  });

  it("blocks two candidates with the same display name", () => {
    const expected = candidate(1, "王女士", "上海｜本科");
    expect(() =>
      selectUnambiguousCandidateTarget(expected, [
        expected,
        candidate(2, "王女士", "杭州｜硕士")
      ])
    ).toThrow(/ambiguous/);
  });

  it("blocks a changed card even when its display name is unchanged", () => {
    const expected = candidate(1, "王女士", "上海｜本科");
    expect(() =>
      selectUnambiguousCandidateTarget(expected, [candidate(1, "王女士", "北京｜本科")])
    ).toThrow(/missing or ambiguous/);
  });
});
