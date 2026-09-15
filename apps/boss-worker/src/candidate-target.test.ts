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

function locatedCandidate(
  index: number,
  name: string,
  info: string,
  value: string
): ParsedCandidate {
  return {
    ...candidate(index, name, info),
    sourceLocator: { kind: "boss_geek_id", value }
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
    ).toThrow(/BOSS_TARGET_AMBIGUOUS/);
  });

  it("blocks a changed card for write operations", () => {
    const expected = candidate(1, "王女士", "上海｜本科");
    expect(() =>
      selectUnambiguousCandidateTarget(expected, [candidate(1, "王女士", "北京｜本科")])
    ).toThrow(/BOSS_TARGET_CHANGED/);
  });

  it("blocks a unique same-name card when its fingerprint changed", () => {
    const expected = candidate(1, "王女士", "上海｜本科");
    expect(() =>
      selectUnambiguousCandidateTarget(expected, [
        candidate(1, "王女士", "北京｜本科")
      ])
    ).toThrow(/BOSS_TARGET_CHANGED/u);
  });

  it("reports a missing candidate with a recoverable next step", () => {
    expect(() =>
      selectUnambiguousCandidateTarget(candidate(1, "王女士", "上海｜本科"), [])
    ).toThrow(/BOSS_TARGET_MISSING.*重新采集/u);
  });

  it("uses the stable BOSS ID to disambiguate candidates with the same name", () => {
    const expected = locatedCandidate(1, "王女士", "上海｜本科", "stable-geek-2");
    const selected = selectUnambiguousCandidateTarget(expected, [
      locatedCandidate(1, "王女士", "上海｜本科", "stable-geek-1"),
      locatedCandidate(2, "王女士", "杭州｜硕士", "stable-geek-2")
    ]);
    expect(selected.fields.信息).toBe("杭州｜硕士");
  });

  it("marks an expired stable source instead of falling back to another same-name card", () => {
    const expected = locatedCandidate(1, "王女士", "上海｜本科", "stable-geek-1");
    expect(() =>
      selectUnambiguousCandidateTarget(expected, [
        locatedCandidate(2, "王女士", "杭州｜硕士", "stable-geek-2")
      ])
    ).toThrow(/BOSS_SOURCE_EXPIRED.*没有改看其他人/u);
  });

  it("recovers a rotated BOSS card ID only when the read-only fingerprint still matches", () => {
    const expected = locatedCandidate(1, "丘凤仪", "广州｜本科", "expired-geek-id");
    const refreshed = locatedCandidate(4, "丘凤仪", "广州｜本科", "replacement-geek-id");
    expect(
      selectUnambiguousCandidateTarget(expected, [refreshed], {
        allowExpiredLocatorFingerprintFallback: true
      }).sourceLocator?.value
    ).toBe("replacement-geek-id");
  });

  it("does not recover a rotated ID when the same name belongs to a different card", () => {
    const expected = locatedCandidate(1, "王女士", "上海｜本科", "expired-geek-id");
    const different = locatedCandidate(2, "王女士", "杭州｜硕士", "replacement-geek-id");
    expect(() =>
      selectUnambiguousCandidateTarget(expected, [different], {
        allowExpiredLocatorFingerprintFallback: true
      })
    ).toThrow(/BOSS_SOURCE_EXPIRED/u);
  });
});
