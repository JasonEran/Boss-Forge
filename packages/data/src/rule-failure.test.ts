import { describe, expect, it } from "vitest";
import { summarizeFailedRuleLabels, summarizeMissingRuleLabels } from "./rule-failure.js";

describe("summarizeFailedRuleLabels", () => {
  it('does not call a shadow-only negative result a failed qualification', () => {
    expect(summarizeFailedRuleLabels([{ capabilityId: 'semantic.sales', canonicalLabel: '销售经验', status: 'negative', reasonCodes: ['semantic_result_not_applied'] }])).toEqual([]);
    expect(summarizeMissingRuleLabels([
      { capabilityId: 'language.english.credentials', canonicalLabel: 'TEM8', status: 'ambiguous', reasonCodes: ['english_credential_missing'] },
      { capabilityId: 'semantic.sales', canonicalLabel: '销售经验', status: 'ambiguous', reasonCodes: ['semantic_result_not_applied'] },
      { capabilityId: 'enum.gender', canonicalLabel: '性别', status: 'ambiguous' },
    ])).toEqual(['英语证书']);
  });
  it("does not describe a non-TEM8 failure as a TEM8 failure", () => {
    expect(
      summarizeFailedRuleLabels([
        {
          capabilityId: "language.english.tem8",
          canonicalLabel: "TEM-8（英语专业八级）",
          status: "positive",
        },
        {
          capabilityId: "enum.bossplatformtags",
          canonicalLabel: "枚举（bossPlatformTags）",
          status: "negative",
        },
        {
          capabilityId: "enum.bossplatformtags",
          canonicalLabel: "枚举（bossPlatformTags）",
          status: "negative",
        },
      ]),
    ).toEqual(["BOSS 院校标签"]);
  });

  it("keeps the actual TEM8 failure when its evidence is negative", () => {
    expect(
      summarizeFailedRuleLabels([
        {
          capabilityId: "language.english.tem8",
          canonicalLabel: "TEM-8（英语专业八级）",
          status: "negative",
        },
      ]),
    ).toEqual(["TEM8 英语专业八级"]);
  });

  it("uses HR-facing labels for the new profile rules", () => {
    expect(
      summarizeFailedRuleLabels([
        {
          capabilityId: "language.english.credentials",
          canonicalLabel: "英语证书：CET6 或 TEM8",
          status: "negative",
        },
        {
          capabilityId: "range.graduationYear",
          canonicalLabel: "毕业年份",
          status: "negative",
        },
        {
          capabilityId: "enum.gender",
          canonicalLabel: "枚举（gender）",
          status: "negative",
        },
      ]),
    ).toEqual(["英语证书", "毕业年份"]);
  });
});
