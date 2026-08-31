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

  it("keeps the same fingerprint when mutable expectation fields change", () => {
    const first = candidate({
      fields: {
        信息: "28岁 / 4年 / 本科 / 离职-随时到岗",
        期望: "珠海 内容运营",
        薪资: "8-10K"
      }
    });
    const second = candidate({
      fields: {
        信息: "28岁 / 4年 / 本科 / 离职-随时到岗",
        期望: "珠海 媒介专员",
        薪资: "9-12K"
      }
    });
    expect(candidateFingerprint(first)).toBe(candidateFingerprint(second));
  });

  it("does not merge people with the same masked name but different base information", () => {
    const first = candidate({
      name: "刘女士",
      fields: { 信息: "23岁 / 1年 / 本科", 期望: "珠海 内容运营" }
    });
    const second = candidate({
      name: "刘女士",
      fields: { 信息: "37岁 / 10年以上 / 本科", 期望: "珠海 行政" }
    });
    expect(candidateFingerprint(first)).not.toBe(candidateFingerprint(second));
  });

  it("stores a matched TEM8 result with original evidence", () => {
    const result = evaluateCandidate(candidate(), rule);
    expect(result.decision).toBe("matched");
    expect(result.dictionaryVersion).toBe("2026.08.2");
    expect(result.evidence[0]?.sourceText).toContain("TEM-8");
  });

  it("routes planned TEM8 claims to manual review", () => {
    const result = evaluateCandidate(
      candidate({ evidence: ["正在备考专八"], raw: "候选人优势" }),
      rule
    );
    expect(result.decision).toBe("ambiguous");
  });

  it("uses full resume text and reports the candidate's explicit current level", () => {
    const result = evaluateCandidate(
      candidate({ evidence: [], raw: "候选人卡片未展示证书" }),
      rule,
      "语言证书：大学英语六级 560 分"
    );
    expect(result.decision).toBe("not_matched");
    expect(result.currentEnglishLevel).toBe("CET-6（大学英语六级）");
    expect(result.rawText).toContain("完整简历");
  });

  it("lets confirmed TEM8 evidence in the full resume override missing card evidence", () => {
    const result = evaluateCandidate(candidate({ evidence: [] }), rule, "已取得 TEM-8 证书");
    expect(result.decision).toBe("matched");
    expect(result.currentEnglishLevel).toContain("TEM-8");
  });
});
