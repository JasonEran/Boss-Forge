import { describe, expect, it } from "vitest";
import { screeningCandidateLimit } from "@boss-forge/contracts";
import { limitScreeningRecords } from "./screening-limit.js";
import type { CandidateEvaluationRecord } from "./types.js";

export function screeningLimitFixture(index: number): CandidateEvaluationRecord {
  return {
    sourceReference: `recommend:${index + 1}:Fixture ${index}`,
    sourceLocator: { kind: "boss_geek_id", value: `fixture-geek-${index}` },
    source: "recommend", displayName: `Fixture ${index}`, fingerprint: `limit-test-${index}`,
    rawFields: {}, sourceEvidence: [], rawText: "Fixture résumé",
    decision: "insufficient", confidence: 0, capabilityId: "language.english.tem8",
    canonicalLabel: "TEM-8", dictionaryVersion: "test.1", currentEnglishLevel: null,
    reasonCodes: [], evidence: [],
  };
}

describe("screening admission limit", () => {
  it("defaults to 20 and accepts inclusive boundaries including values above 200", () => {
    expect(screeningCandidateLimit()).toBe(20);
    expect(screeningCandidateLimit(1)).toBe(1);
    expect(screeningCandidateLimit(200)).toBe(200);
    expect(screeningCandidateLimit(500)).toBe(500);
    expect(screeningCandidateLimit(100_000)).toBe(100_000);
  });
  it.each([null, "20", "", true, 0, -1, 1.5, 100_001, Infinity, NaN])("rejects invalid limit %s", (value) => {
    expect(() => screeningCandidateLimit(value)).toThrow("筛选人数");
  });
  it("only admits the selected 20 from an accumulated 385-card list", () => {
    const records = Array.from({ length: 385 }, (_, index) => screeningLimitFixture(index));
    expect(limitScreeningRecords(records, 20)).toEqual(records.slice(0, 20));
    expect(limitScreeningRecords(records, 1)).toEqual(records.slice(0, 1));
    expect(limitScreeningRecords(records, 200)).toHaveLength(200);
    expect(limitScreeningRecords(records, 385)).toHaveLength(385);
  });
  it("deduplicates stable identities before counting and does not count decisions as a target", () => {
    const one = screeningLimitFixture(0);
    const duplicate = { ...one, fingerprint: "changed", sourceLocator: { kind: "boss_geek_id" as const, value: " fixture-geek-0 " } };
    const two = { ...screeningLimitFixture(1), decision: "not_matched" as const };
    expect(limitScreeningRecords([one, duplicate, two, screeningLimitFixture(2)], 2)).toEqual([one, two]);
  });
  it("returns actual availability without manufacturing or refilling candidates", () => {
    expect(limitScreeningRecords([], 20)).toEqual([]);
    const one = screeningLimitFixture(0);
    delete one.sourceLocator;
    expect(limitScreeningRecords([one, one], 20)).toEqual([one]);
  });
});
