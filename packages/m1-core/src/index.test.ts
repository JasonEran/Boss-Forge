import type { ParsedCandidate } from "@boss-forge/contracts";
import { parseRuleConfig, type RuleConfig } from "@boss-forge/data";
import { createInstitutionCatalog, TEM8_DICTIONARY_VERSION } from "@boss-forge/rule-engine";
import { describe, expect, it } from "vitest";
import {
  candidateFingerprint,
  evaluateCandidate,
  extractEducationExperiences
} from "./index.js";

const rule = {
  requiredCapabilities: [{ capability: "tem8" as const, minimumConfidence: 0.9 }]
};

const catalog = createInstitutionCatalog({
  schemaVersion: "1.0",
  version: "cn-institution-m1-test-2026.01",
  status: "published",
  source: { name: "M1 reviewed test fixture", asOfDate: "2026-01-01" },
  importedBy: "test-importer",
  reviewedBy: "test-reviewer",
  publishedAt: "2026-01-02T00:00:00.000Z",
  changeSummary: "M1 integration tests only.",
  institutions: [
    {
      id: "inst-peking",
      standardName: "北京大学",
      countryOrRegion: "CN",
      kind: "university",
      categories: ["project_985", "project_211", "double_first_class_university"],
      aliases: [
        { id: "alias-peking-short", value: "北大", kind: "abbreviation" },
        { id: "alias-peking-ocr", value: "北京大學", kind: "ocr_variant" }
      ]
    },
    {
      id: "inst-normal",
      standardName: "普通示范学院",
      countryOrRegion: "CN",
      kind: "college",
      categories: ["other_domestic"],
      aliases: []
    }
  ]
});

function institutionRuleConfig(root: Record<string, unknown>): RuleConfig {
  return {
    schemaVersion: "1.0",
    name: "英语与院校组合筛选",
    root,
    institutionCatalog: catalog
  } as unknown as RuleConfig;
}

function institutionLeaf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "institution_category",
    educationStage: "bachelor",
    categories: ["project_985", "project_211"],
    mode: "any",
    required: true,
    catalogVersion: catalog.version,
    unknownPolicy: "manual_review",
    ...overrides
  };
}

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

function bossAcademicTagRule(
  values: string[],
  mode: "any" | "all" = "any"
): RuleConfig {
  return parseRuleConfig({
    schemaVersion: "1.0",
    name: "BOSS 院校平台标签",
    root: {
      operator: "AND",
      children: [
        {
          type: "enum",
          field: "bossPlatformTags",
          values,
          mode,
          match: "exact",
          unknownPolicy: "fail"
        }
      ]
    }
  });
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

  it("keeps the same fingerprint when BOSS list labels change", () => {
    const first = candidate({ fields: { 信息: "28岁 / 4年 / 本科", 标签: "985" } });
    const second = candidate({
      fields: { 信息: "28岁 / 4年 / 本科", 标签: "985/双一流", BOSS平台标签: "985/双一流" }
    });
    expect(candidateFingerprint(first)).toBe(candidateFingerprint(second));
  });

  it("uses the stable BOSS candidate locator before mutable profile fields", () => {
    const first = candidate({
      sourceLocator: { kind: "boss_geek_id", value: "geek-8848" },
      fields: { 信息: "23岁 / 1年 / 本科", 期望: "珠海 内容运营" }
    });
    const changed = candidate({
      name: "陈女士",
      sourceLocator: { kind: "boss_geek_id", value: "geek-8848" },
      fields: { 信息: "24岁 / 2年 / 硕士", 期望: "深圳 品牌运营" }
    });
    const another = candidate({
      sourceLocator: { kind: "boss_geek_id", value: "geek-8849" },
      fields: first.fields
    });
    expect(candidateFingerprint(first)).toBe(candidateFingerprint(changed));
    expect(candidateFingerprint(first)).not.toBe(candidateFingerprint(another));
  });

  it("filters directly by exact BOSS academic platform tags without an institution catalog", () => {
    const config = bossAcademicTagRule(["985", "双一流"], "all");
    const result = evaluateCandidate(
      candidate({ fields: { BOSS平台标签: "985/211/双一流" }, evidence: [] }),
      config
    );
    expect(result.decision).toBe("matched");
    expect(result.institutionCatalogVersion).toBeUndefined();
  });

  it("does not infer 211 from a 985 BOSS platform tag", () => {
    const result = evaluateCandidate(
      candidate({ fields: { BOSS平台标签: "985" }, evidence: [] }),
      bossAcademicTagRule(["211"])
    );
    expect(result.decision).toBe("not_matched");
  });

  it("fails a BOSS platform-tag rule when the explicit label is missing", () => {
    const result = evaluateCandidate(
      candidate({ fields: { 信息: "毕业于一所 985 大学" }, evidence: ["985 项目经验"] }),
      bossAcademicTagRule(["985"]),
      "教育经历：某 985 大学"
    );
    expect(result.decision).toBe("not_matched");
    expect(result.reasonCodes).toContain("field_missing");
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
    expect(result.dictionaryVersion).toBe(TEM8_DICTIONARY_VERSION);
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
    expect(result.decision).toBe("insufficient");
    expect(result.currentEnglishLevel).toBe("CET-6（大学英语六级）");
    expect(result.rawText).toContain("完整简历");
  });

  it("lets confirmed TEM8 evidence in the full resume override missing card evidence", () => {
    const result = evaluateCandidate(candidate({ evidence: [] }), rule, "已取得 TEM-8 证书");
    expect(result.decision).toBe("matched");
    expect(result.currentEnglishLevel).toContain("TEM-8");
  });
});

describe("deterministic education extraction", () => {
  it("extracts stage-specific fields without guessing", () => {
    const extracted = extractEducationExperiences(
      candidate({
        fields: {
          本科院校: "北京大学",
          本科专业: "英语",
          硕士院校: "普通示范学院",
          硕士专业: "新闻学"
        }
      })
    );
    expect(extracted).toHaveLength(2);
    expect(extracted[0]).toMatchObject({
      stage: "bachelor",
      institutionRaw: "北京大学",
      major: "英语"
    });
    expect(extracted[1]).toMatchObject({
      stage: "master",
      institutionRaw: "普通示范学院",
      major: "新闻学"
    });
  });

  it("extracts a generic school only with its explicit labels", () => {
    const extracted = extractEducationExperiences(
      candidate({ fields: {} }),
      "毕业院校：北京大學；学历：本科；专业：英语"
    );
    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toMatchObject({
      institutionRaw: "北京大學",
      degree: "本科",
      major: "英语"
    });
  });

  it("ignores an unlabeled free-form school mention", () => {
    expect(
      extractEducationExperiences(
        candidate({ fields: {} }),
        "2018 至 2022 年在北京大学英语专业学习，获得文学学士。"
      )
    ).toEqual([]);
  });

  it("marks exchange education as non-formal evidence", () => {
    expect(
      extractEducationExperiences(
        candidate({ fields: {} }),
        "本科院校：北京大学；教育性质：交换生"
      )[0]
    ).toMatchObject({ attendanceType: "exchange" });
  });
});

describe("schema 1.0 composite screening", () => {
  it("matches an AND rule only when TEM8 and institution both match", () => {
    const config = institutionRuleConfig({
      operator: "AND",
      children: [
        { type: "tem8", minimumConfidence: 0.9 },
        institutionLeaf()
      ]
    });
    const result = evaluateCandidate(
      candidate({ fields: { 本科院校: "北大", 本科专业: "英语" } }),
      config
    );
    expect(result.decision).toBe("matched");
    expect(result.currentEnglishLevel).toContain("TEM-8");
    expect(result.evidence.map((item) => item.capabilityId)).toContain(
      "education.institution.bachelor.project_985+project_211"
    );
    expect(result.institutionDecision).toBe("matched");
    expect(result.institutionCatalogVersion).toBe(catalog.version);
    expect(result.institutionSummary).toContain("北大");
    expect(result.education).toEqual([
      expect.objectContaining({
        stage: "bachelor",
        institutionRaw: "北大",
        major: "英语",
        categorySnapshot: expect.arrayContaining(["project_985", "project_211"])
      })
    ]);
  });

  it("fails an AND rule when the explicit institution is not in the category", () => {
    const config = institutionRuleConfig({
      type: "all",
      children: [{ type: "tem8", minimumConfidence: 0.9 }, institutionLeaf()]
    });
    const result = evaluateCandidate(
      candidate({ fields: { 本科院校: "普通示范学院" } }),
      config
    );
    expect(result.decision).toBe("not_matched");
  });

  it("lets an institution match satisfy an OR rule while preserving current English level", () => {
    const config = institutionRuleConfig({
      operator: "OR",
      children: [
        {
          type: "capability",
          capability: "tem8",
          match: "confirmed",
          unknownPolicy: "manual_review"
        },
        institutionLeaf({ categories: ["project_985"] })
      ]
    });
    const result = evaluateCandidate(
      candidate({
        fields: { 本科院校: "北京大学" },
        evidence: [],
        raw: "语言证书：大学英语六级"
      }),
      config
    );
    expect(result.decision).toBe("matched");
    expect(result.currentEnglishLevel).toBe("CET-6（大学英语六级）");
  });

  it("honors an institution leaf's explicit fail policy for missing evidence", () => {
    const config = institutionRuleConfig({
      type: "all",
      children: [institutionLeaf({ unknownPolicy: "fail" })]
    });
    const noLabel = evaluateCandidate(
      candidate({ fields: {}, evidence: [], raw: "候选人卡片" }),
      config,
      "曾在北京大学读书"
    );
    const unknown = evaluateCandidate(
      candidate({ fields: { 本科院校: "未收录大学" }, evidence: [] }),
      config
    );
    expect(noLabel.decision).toBe("not_matched");
    expect(unknown.decision).toBe("not_matched");
    expect(noLabel.reasonCodes).toContain("unknown_policy_fail");
    expect(noLabel.evidence[0]?.normalizedAlias).toBe("no_explicit_education_evidence");

    const manualReview = evaluateCandidate(
      candidate({ fields: {}, evidence: [], raw: "候选人卡片" }),
      institutionRuleConfig({ type: "all", children: [institutionLeaf()] })
    );
    expect(manualReview.decision).toBe("insufficient");
    expect(manualReview.reasonCodes).toContain("unknown_policy_manual_review");
  });

  it("uses an explicit OCR resume label after the candidate card lacked a school", () => {
    const config = institutionRuleConfig({
      operator: "AND",
      children: [institutionLeaf({ categories: ["project_985"] })]
    });
    const result = evaluateCandidate(
      candidate({ fields: { 学历: "本科" }, evidence: [] }),
      config,
      "本科院校：北京大學；本科专业：英语"
    );
    expect(result.decision).toBe("matched");
    expect(result.evidence[0]).toMatchObject({
      normalizedAlias: "北京大学",
      dictionaryVersion: catalog.version,
      status: "positive",
      confidence: 0.95
    });
    expect(result.confidence).toBe(0.95);
    expect(result.education?.[0]?.categorySnapshot).toEqual(
      expect.arrayContaining(["project_985", "project_211"])
    );
  });
});

describe("R2 generic runtime rules", () => {
  function genericConfig(root: Record<string, unknown>): RuleConfig {
    return { schemaVersion: "1.0", name: "通用岗位规则", root } as unknown as RuleConfig;
  }

  it("combines Chinese experience, education, and skill fields with AND", () => {
    const config = genericConfig({
      operator: "AND",
      children: [
        {
          type: "range",
          field: "yearsOfExperience",
          minimum: 2,
          maximum: 8,
          unknownPolicy: "manual_review"
        },
        {
          type: "education_level",
          minimum: "bachelor",
          unknownPolicy: "manual_review"
        },
        {
          type: "keyword",
          field: "skills",
          values: ["Amazon", "Shopify"],
          mode: "all",
          unknownPolicy: "manual_review"
        }
      ]
    });
    const result = evaluateCandidate(
      candidate({
        fields: {
          工作年限: "4年",
          学历: "本科",
          专业技能: "Amazon 店铺运营、Shopify 独立站"
        },
        evidence: [],
        raw: "候选人卡片"
      }),
      config
    );
    expect(result.decision).toBe("matched");
    expect(result.evidence.map((item) => item.capabilityId)).toEqual(
      expect.arrayContaining([
        "range.yearsOfExperience",
        "education.education_level",
        "keyword.skills"
      ])
    );
    expect(result.reasonCodes).toContain("composite_all_matched");
  });

  it("extracts years only from an explicitly labeled OCR field", () => {
    const config = genericConfig({
      type: "all",
      children: [
        {
          type: "range",
          field: "yearsOfExperience",
          minimum: 3,
          maximum: 5,
          unknownPolicy: "manual_review"
        }
      ]
    });
    const result = evaluateCandidate(
      candidate({ fields: {}, evidence: [], raw: "候选人卡片" }),
      config,
      "个人简历\n工作经验：4年\n项目经验：跨境电商"
    );
    expect(result.decision).toBe("matched");
    expect(result.evidence[0]).toMatchObject({
      sourceText: "工作经验：4年",
      normalizedAlias: "4..4",
      status: "positive"
    });
  });

  it("routes a partially overlapping experience interval to review", () => {
    const config = genericConfig({
      operator: "AND",
      children: [
        {
          type: "range",
          field: "yearsOfExperience",
          minimum: 4,
          maximum: 8,
          unknownPolicy: "manual_review"
        }
      ]
    });
    const result = evaluateCandidate(
      candidate({ fields: { 经验: "3-5年" }, evidence: [], raw: "候选人卡片" }),
      config
    );
    expect(result.decision).toBe("ambiguous");
    expect(result.reasonCodes).toContain("range_partially_overlaps");
  });

  it("supports NOT without turning missing input into a false match", () => {
    const presentConfig = genericConfig({
      operator: "NOT",
      children: [
        {
          type: "text",
          field: "求职状态",
          value: "在职",
          match: "contains",
          unknownPolicy: "fail"
        }
      ]
    });
    expect(
      evaluateCandidate(
        candidate({ fields: { 求职状态: "离职-随时到岗" }, evidence: [], raw: "候选人卡片" }),
        presentConfig
      ).decision
    ).toBe("matched");
    expect(
      evaluateCandidate(
        candidate({ fields: { 求职状态: "在职-考虑机会" }, evidence: [], raw: "候选人卡片" }),
        presentConfig
      ).decision
    ).toBe("not_matched");

    const missing = evaluateCandidate(
      candidate({ fields: {}, evidence: [], raw: "候选人卡片" }),
      presentConfig
    );
    expect(missing.decision).toBe("not_matched");
    expect(missing.reasonCodes).toContain("composite_not_unknown_not_inverted");
    expect(missing.reasonCodes).toContain("unknown_policy_fail");
  });

  it("applies manual_review, fail, and ignore without marking unknown evidence positive", () => {
    const leaf = (unknownPolicy: "manual_review" | "fail" | "ignore") => ({
      type: "text",
      field: "自定义字段",
      value: "目标值",
      match: "exact",
      unknownPolicy
    });
    const evaluate = (unknownPolicy: "manual_review" | "fail" | "ignore") =>
      evaluateCandidate(
        candidate({ fields: {}, evidence: [], raw: "候选人卡片" }),
        genericConfig({ operator: "AND", children: [leaf(unknownPolicy)] })
      );
    expect(evaluate("manual_review").decision).toBe("insufficient");
    expect(evaluate("fail").decision).toBe("not_matched");
    const ignored = evaluate("ignore");
    expect(ignored.decision).toBe("insufficient");
    expect(ignored.reasonCodes).toContain("composite_all_all_children_ignored");
    expect(ignored.evidence[0]?.status).toBe("ambiguous");
  });

  it("keeps old TEM8 nodes compatible while allowing explicit fail and ignore policies", () => {
    const capability = (unknownPolicy: "manual_review" | "fail" | "ignore") => ({
      type: "capability",
      capability: "tem8",
      match: "confirmed",
      unknownPolicy
    });
    const noCredential = candidate({ fields: {}, evidence: [], raw: "候选人卡片" });
    expect(
      evaluateCandidate(
        noCredential,
        genericConfig({ operator: "AND", children: [capability("manual_review")] })
      ).decision
    ).toBe("insufficient");
    expect(
      evaluateCandidate(
        noCredential,
        genericConfig({ operator: "AND", children: [capability("fail")] })
      ).decision
    ).toBe("not_matched");
    const ignored = evaluateCandidate(
      candidate({ fields: { 经验: "4年" }, evidence: [], raw: "候选人卡片" }),
      genericConfig({
        operator: "AND",
        children: [
          capability("ignore"),
          {
            type: "range",
            field: "yearsOfExperience",
            minimum: 2,
            unknownPolicy: "manual_review"
          }
        ]
      })
    );
    expect(ignored.decision).toBe("matched");
    expect(ignored.reasonCodes).toContain("unknown_policy_ignore");
  });

  it("lets an ignored missing leaf stay neutral beside a known match", () => {
    const result = evaluateCandidate(
      candidate({ fields: { 经验: "4年" }, evidence: [], raw: "候选人卡片" }),
      genericConfig({
        operator: "AND",
        children: [
          {
            type: "range",
            field: "yearsOfExperience",
            minimum: 2,
            unknownPolicy: "manual_review"
          },
          {
            type: "text",
            field: "未提供字段",
            value: "任意值",
            match: "exact",
            unknownPolicy: "ignore"
          }
        ]
      })
    );
    expect(result.decision).toBe("matched");
    expect(result.reasonCodes).toContain("unknown_policy_ignore");
    expect(result.evidence.find((item) => item.capabilityId === "text.未提供字段")?.status).toBe(
      "ambiguous"
    );
  });

  it("supports keyword all-scope and enum exact matching on Chinese fields", () => {
    const config = genericConfig({
      operator: "AND",
      children: [
        {
          type: "keyword",
          field: "all",
          values: ["跨境电商", "独立站"],
          mode: "all",
          unknownPolicy: "manual_review"
        },
        {
          type: "enum",
          field: "期望城市",
          values: ["上海"],
          mode: "any",
          match: "exact",
          unknownPolicy: "manual_review"
        }
      ]
    });
    const result = evaluateCandidate(
      candidate({ fields: { 期望城市: "上海 / 杭州" }, evidence: [], raw: "候选人卡片" }),
      config,
      "项目经历：负责跨境电商独立站增长"
    );
    expect(result.decision).toBe("matched");
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining(["keyword_mode_all", "enum_match_exact"])
    );
  });

  it("distinguishes text exact from contains", () => {
    const textLeaf = (match: "exact" | "contains") => ({
      type: "text",
      field: "在职状态",
      value: "离职",
      match,
      unknownPolicy: "manual_review"
    });
    const input = candidate({
      fields: { 在职状态: "离职-随时到岗" },
      evidence: [],
      raw: "候选人卡片"
    });
    expect(
      evaluateCandidate(input, genericConfig({ type: "all", children: [textLeaf("exact")] }))
        .decision
    ).toBe("not_matched");
    expect(
      evaluateCandidate(input, genericConfig({ type: "all", children: [textLeaf("contains")] }))
        .decision
    ).toBe("matched");
  });

  it("evaluates explicit Chinese education levels without keyword guessing", () => {
    const config = genericConfig({
      operator: "AND",
      children: [
        {
          type: "education_level",
          minimum: "bachelor",
          unknownPolicy: "manual_review"
        }
      ]
    });
    expect(
      evaluateCandidate(
        candidate({ fields: { 最高学历: "硕士研究生" }, evidence: [], raw: "候选人卡片" }),
        config
      ).decision
    ).toBe("matched");
    expect(
      evaluateCandidate(
        candidate({ fields: { 学历层次: "大专" }, evidence: [], raw: "候选人卡片" }),
        config
      ).decision
    ).toBe("not_matched");
    expect(
      evaluateCandidate(
        candidate({ fields: {}, evidence: [], raw: "候选人自述本科项目经验丰富" }),
        config
      ).decision
    ).toBe("insufficient");
    const bossSummary = evaluateCandidate(
      candidate({
        fields: { 信息: "22岁 / 26年应届生 / 本科" },
        evidence: [],
        raw: "候选人卡片"
      }),
      config
    );
    expect(bossSummary.decision).toBe("matched");
    expect(bossSummary.confidence).toBe(1);
    expect(bossSummary.evidence[0]).toMatchObject({
      canonicalLabel: "最低学历：本科",
      normalizedAlias: "bachelor",
      status: "positive",
      confidence: 1
    });
    expect(
      evaluateCandidate(
        candidate({ fields: { 信息: "本科项目经验丰富" }, evidence: [], raw: "候选人卡片" }),
        config
      ).decision
    ).toBe("insufficient");
  });

  it("treats CET6 and TEM8 as alternatives inside one English requirement", () => {
    const englishConfig = genericConfig({
      operator: "AND",
      children: [
        {
          type: "english_credential",
          accepted: ["cet6", "tem8"],
          mode: "any",
          minimumConfidence: 0.86,
          unknownPolicy: "manual_review"
        }
      ]
    });
    const cet6 = evaluateCandidate(
      candidate({ fields: {}, evidence: [], raw: "候选人卡片" }),
      englishConfig,
      "证书：英语六级 560 分"
    );
    expect(cet6.decision).toBe("matched");
    expect(cet6.currentEnglishLevel).toBe("CET-6（大学英语六级）");
    expect(cet6.evidence[0]).toMatchObject({
      capabilityId: "language.english.credentials",
      normalizedAlias: "cet6",
      status: "positive"
    });
    expect(
      evaluateCandidate(
        candidate({ fields: {}, evidence: [], raw: "候选人卡片" }),
        englishConfig,
        "已取得 TEM-8 证书"
      ).decision
    ).toBe("matched");
    expect(
      evaluateCandidate(
        candidate({ fields: {}, evidence: [], raw: "候选人卡片" }),
        englishConfig,
        "证书：CET-4"
      ).decision
    ).toBe("insufficient");
  });

  it("filters explicit BOSS age and graduate cohort without mistaking one for the other", () => {
    const profileConfig = genericConfig({
      operator: "AND",
      children: [
        { type: "range", field: "age", minimum: 20, maximum: 30, unknownPolicy: "manual_review" },
        {
          type: "range",
          field: "graduationYear",
          maximum: 2026,
          unknownPolicy: "manual_review"
        }
      ]
    });
    const accepted = evaluateCandidate(
      candidate({
        fields: { 信息: "23岁 / 26年应届生 / 本科" },
        evidence: [],
        raw: "候选人卡片"
      }),
      profileConfig
    );
    expect(accepted.decision).toBe("matched");
    expect(accepted.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capabilityId: "range.age", normalizedAlias: "23" }),
        expect.objectContaining({ capabilityId: "range.graduationYear", normalizedAlias: "2026" })
      ])
    );
    const futureGraduate = evaluateCandidate(
      candidate({
        fields: { 信息: "21岁 / 27年应届生 / 本科" },
        evidence: [],
        raw: "候选人卡片"
      }),
      profileConfig
    );
    expect(futureGraduate.decision).toBe("not_matched");
    expect(
      futureGraduate.evidence.find((item) => item.capabilityId === "range.graduationYear")
    ).toMatchObject({ normalizedAlias: "2027", status: "negative" });
  });

  it("recognizes 届 cohorts, expands old two-digit years, and reads OCR profile facts", () => {
    const cohortRule = genericConfig({
      operator: "AND",
      children: [
        { type: "range", field: "age", minimum: 20, maximum: 30, unknownPolicy: "manual_review" },
        { type: "range", field: "graduationYear", minimum: 2026, maximum: 2026, unknownPolicy: "manual_review" }
      ]
    });
    const fromResume = evaluateCandidate(
      candidate({ fields: {}, evidence: [], raw: "候选人卡片" }),
      cohortRule,
      "基本信息：年龄 23岁\n教育状态：2026届"
    );
    expect(fromResume.decision).toBe("matched");
    expect(fromResume.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capabilityId: "range.age", normalizedAlias: "23" }),
        expect.objectContaining({ capabilityId: "range.graduationYear", normalizedAlias: "2026" })
      ])
    );

    const historicalRule = genericConfig({
      operator: "AND",
      children: [
        { type: "range", field: "graduationYear", maximum: 2000, unknownPolicy: "manual_review" }
      ]
    });
    expect(
      evaluateCandidate(
        candidate({ fields: { 毕业年份: "99年毕业" }, evidence: [], raw: "候选人卡片" }),
        historicalRule
      ).evidence[0]
    ).toMatchObject({ normalizedAlias: "1999", status: "positive" });
  });

  it("uses a saved education period for graduation screening and preserves explicit cohort priority", () => {
    const config = genericConfig({ operator: "AND", children: [
      { type: "english_credential", accepted: ["cet6"], mode: "any", minimumConfidence: 0.86, unknownPolicy: "fail" },
      { type: "range", field: "graduationYear", maximum: 2026, unknownPolicy: "fail" }
    ] });
    const card = candidate({ fields: {}, evidence: [], raw: "候选人卡片" });
    const resume = "教育经历\n示范学院\n城市管理\n本科\n2022-2026\n在校经历:\n组织活动\n资格证书\nCET-6";
    const result = evaluateCandidate(card, config, resume);
    expect(result.decision).toBe("matched");
    expect(result.evidence.find(e => e.capabilityId === "range.graduationYear"))
      .toMatchObject({ normalizedAlias: "2026", status: "positive" });
    expect(evaluateCandidate(card, config, resume.replace("2022-2026", "2023-2027")).decision).toBe("not_matched");
    expect(evaluateCandidate(card, config, resume + "\n预计2027年毕业").decision).toBe("not_matched");
    expect(evaluateCandidate(card, config, resume.replace("2022-2026", "2022-至今")).decision).toBe("not_matched");
  });

  it("uses explicit highest education instead of treating prior degrees as conflicts", () => {
    const educationRule = genericConfig({
      operator: "AND",
      children: [
        { type: "education_level", minimum: "master", unknownPolicy: "manual_review" }
      ]
    });
    const result = evaluateCandidate(
      candidate({ fields: {}, evidence: [], raw: "候选人卡片" }),
      educationRule,
      "最高学历：硕士\n教育经历：学历：本科\n教育经历：学历：硕士"
    );
    expect(result.decision).toBe("matched");
    expect(result.evidence[0]).toMatchObject({ normalizedAlias: "master" });
  });

  it("evaluates an explicit fresh-graduate requirement without guessing from age", () => {
    const freshGraduateRule = genericConfig({
      operator: "AND",
      children: [
        {
          type: "graduate_status",
          values: ["current_or_upcoming_graduate"],
          mode: "any",
          unknownPolicy: "manual_review"
        }
      ]
    });
    expect(
      evaluateCandidate(
        candidate({ fields: {}, evidence: [], raw: "候选人卡片" }),
        freshGraduateRule,
        "求职信息：2026届应届毕业生"
      ).decision
    ).toBe("matched");
    expect(
      evaluateCandidate(
        candidate({ fields: {}, evidence: [], raw: "候选人卡片" }),
        freshGraduateRule,
        "求职信息：往届生，已毕业"
      ).decision
    ).toBe("not_matched");
    expect(
      evaluateCandidate(
        candidate({ fields: {}, evidence: [], raw: "候选人卡片" }),
        freshGraduateRule,
        "求职信息：非应届，2020届"
      ).decision
    ).toBe("not_matched");
    expect(
      evaluateCandidate(
        candidate({ fields: { 年龄: "23" }, evidence: [], raw: "候选人卡片" }),
        freshGraduateRule
      ).decision
    ).toBe("insufficient");
  });

  it("does not use gender alone to approve or reject a candidate", () => {
    const genderConfig = genericConfig({
      operator: "AND",
      children: [
        {
          type: "enum",
          field: "gender",
          values: ["女"],
          mode: "any",
          match: "exact",
          unknownPolicy: "manual_review"
        }
      ]
    });
    expect(
      evaluateCandidate(
        candidate({ name: "王女士", fields: {}, evidence: [], raw: "候选人卡片" }),
        genderConfig
      ).decision
    ).toBe("insufficient");
    expect(
      evaluateCandidate(
        candidate({ fields: { 性别: "女" }, evidence: [], raw: "候选人卡片" }),
        genderConfig
      ).decision
    ).toBe("insufficient");
    expect(
      evaluateCandidate(
        candidate({ fields: { 信息: "24岁 / 男 / 2年 / 本科" }, evidence: [], raw: "候选人卡片" }),
        genderConfig
      ).decision
    ).toBe("insufficient");
  });
});

describe("strict rule snapshot validation", () => {
  it("rejects an empty root and unknown nodes", () => {
    expect(() =>
      parseRuleConfig({ schemaVersion: "1.0", root: { operator: "AND", children: [] } })
    ).toThrow(/must not be empty/u);
    expect(() =>
      parseRuleConfig({
        schemaVersion: "1.0",
        root: { operator: "AND", children: [{ type: "llm_guess" }] }
      })
    ).toThrow(/unsupported rule node/u);
  });

  it("rejects a modified catalog snapshot and a mismatched catalog version", () => {
    const tampered = structuredClone(catalog);
    tampered.institutions[0]!.standardName = "被修改的大学";
    expect(() =>
      parseRuleConfig({
        schemaVersion: "1.0",
        root: { operator: "AND", children: [institutionLeaf()] },
        institutionCatalog: tampered
      })
    ).toThrow(/modified|content does not match/u);
    expect(() =>
      parseRuleConfig({
        schemaVersion: "1.0",
        root: {
          type: "all",
          children: [institutionLeaf({ catalogVersion: "different-version" })]
        },
        institutionCatalog: catalog
      })
    ).toThrow(/does not match snapshot/u);
  });

  it("rejects unknown fields even when the catalog hash would otherwise ignore them", () => {
    expect(() =>
      parseRuleConfig({
        schemaVersion: "1.0",
        root: { type: "all", children: [{ type: "tem8", minimumConfidence: 0.9 }] },
        shadowRule: true
      })
    ).toThrow(/unsupported field/u);
  });

  it("strictly validates NOT, leaf policies, bounds, values, and the node cap", () => {
    expect(() =>
      parseRuleConfig({
        schemaVersion: "1.0",
        root: {
          operator: "NOT",
          children: [
            { type: "tem8", minimumConfidence: 0.9 },
            { type: "tem8", minimumConfidence: 0.9 }
          ]
        }
      })
    ).toThrow(/exactly one/u);
    expect(() =>
      parseRuleConfig({
        schemaVersion: "1.0",
        root: {
          type: "all",
          children: [
            {
              type: "range",
              field: "yearsOfExperience",
              minimum: 9,
              maximum: 2,
              unknownPolicy: "manual_review"
            }
          ]
        }
      })
    ).toThrow(/must not exceed/u);
    expect(() =>
      parseRuleConfig({
        schemaVersion: "1.0",
        root: {
          type: "all",
          children: [
            {
              type: "keyword",
              field: "all",
              values: ["Amazon"],
              mode: "any",
              unknownPolicy: "guess"
            }
          ]
        }
      })
    ).toThrow(/manual_review, fail, or ignore/u);
    expect(() =>
      parseRuleConfig({
        schemaVersion: "1.0",
        root: {
          type: "all",
          children: [
            {
              type: "enum",
              field: "城市",
              values: [],
              mode: "any",
              match: "exact",
              unknownPolicy: "manual_review"
            }
          ]
        }
      })
    ).toThrow(/non-empty array/u);
    expect(() =>
      parseRuleConfig({
        schemaVersion: "1.0",
        root: {
          operator: "AND",
          children: Array.from({ length: 100 }, () => ({
            type: "tem8",
            minimumConfidence: 0.9
          }))
        }
      })
    ).toThrow(/more than 100 nodes/u);
  });
});
