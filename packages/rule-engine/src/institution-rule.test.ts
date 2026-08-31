import { describe, expect, it } from "vitest";
import { createInstitutionCatalog } from "./institution-catalog.js";
import {
  evaluateInstitutionCategoryRule,
  InstitutionRuleConfigurationError,
  resolveEducationStage,
  validateInstitutionCategoryRule
} from "./institution-rule.js";
import {
  buildInstitutionCatalog,
  institutionCatalogDraft,
  TEST_CATALOG_VERSION
} from "./institution-test-support.js";
import type {
  EducationExperienceInput,
  InstitutionCatalog,
  InstitutionCategoryRule
} from "./institution-types.js";

const catalog = buildInstitutionCatalog();

function categoryRule(
  overrides: Partial<InstitutionCategoryRule> = {}
): InstitutionCategoryRule {
  return {
    type: "institution_category",
    educationStage: "bachelor",
    categories: ["project_985", "project_211"],
    mode: "any",
    required: true,
    catalogVersion: TEST_CATALOG_VERSION,
    unknownPolicy: "manual_review",
    ...overrides
  };
}

function education(
  institutionRaw: string,
  stage: EducationExperienceInput["stage"] = "bachelor",
  overrides: Partial<EducationExperienceInput> = {}
): EducationExperienceInput {
  return {
    stage,
    institutionRaw,
    attendanceType: "formal_degree",
    evidence: { sourceText: `${stage ?? "unknown"} ${institutionRaw}` },
    ...overrides
  };
}

describe("institution category rule validation", () => {
  it("rejects incomplete or unknown rule values", () => {
    const issues = validateInstitutionCategoryRule({
      type: "institution_category",
      educationStage: "undergraduate",
      categories: ["project_985", "project_985", "top_100"],
      mode: "some",
      required: "yes",
      catalogVersion: "",
      unknownPolicy: "guess"
    });
    expect(issues).toHaveLength(7);
    expect(() =>
      evaluateInstitutionCategoryRule({ categories: [] } as unknown as InstitutionCategoryRule, [], catalog)
    ).toThrow(InstitutionRuleConfigurationError);
  });
});

describe("education stage resolution", () => {
  it.each([
    [{ degree: "本科 / 工学学士" }, "bachelor"],
    [{ qualification: "硕士研究生" }, "master"],
    [{ degree: "Ph.D." }, "doctor"],
    [{ qualification: "大专" }, "associate"],
    [{ stage: "other" as const }, "other"]
  ] as const)("resolves reviewed structured stage input", (input, expected) => {
    const result = resolveEducationStage(input);
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.stage).toBe(expected);
  });

  it("returns ambiguity instead of choosing between conflicting stages", () => {
    const result = resolveEducationStage({ stage: "bachelor", degree: "硕士研究生" });
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.candidates).toEqual(["bachelor", "master"]);
    }
  });

  it("keeps absent stage evidence unknown", () => {
    expect(resolveEducationStage({ qualification: "计算机专业" })).toEqual({
      status: "unknown",
      candidates: [],
      reason: "missing_stage_evidence"
    });
  });
});

describe("985/211 and general institution category evaluation", () => {
  it.each(["北京大学", "北大", "Peking University", "京师大学堂", "北京大學"])(
    "matches standard, abbreviation, English, former, and reviewed OCR names: %s",
    (institutionRaw) => {
      const result = evaluateInstitutionCategoryRule(categoryRule(), [education(institutionRaw)], catalog);
      expect(result.decision).toBe("matched");
      expect(result.evidence[0]).toMatchObject({
        institutionRaw,
        institutionId: "inst-peking",
        standardInstitution: "北京大学",
        catalogVersion: TEST_CATALOG_VERSION,
        result: "matched"
      });
    }
  );

  it("treats category OR and AND as explicit rule semantics", () => {
    const candidate = [education("甲示范大学")];
    expect(evaluateInstitutionCategoryRule(categoryRule({ mode: "any" }), candidate, catalog).decision).toBe(
      "matched"
    );
    expect(evaluateInstitutionCategoryRule(categoryRule({ mode: "all" }), candidate, catalog).decision).toBe(
      "not_matched"
    );
  });

  it("does not imply 211 merely because the catalog says 985", () => {
    const result = evaluateInstitutionCategoryRule(
      categoryRule({ categories: ["project_211"] }),
      [education("甲示范大学")],
      catalog
    );
    expect(result.decision).toBe("not_matched");
    expect(result.evidence[0]?.categoriesSnapshot).toEqual(["project_985"]);
  });

  it("does not inherit a parent university category for an independent college", () => {
    const result = evaluateInstitutionCategoryRule(categoryRule(), [
      education("北京大学独立学院")
    ], catalog);
    expect(result.decision).toBe("not_matched");
    expect(result.evidence[0]).toMatchObject({
      institutionId: "inst-independent",
      categoriesSnapshot: ["other_domestic"]
    });
  });

  it("selects bachelor, master, highest, any, and all deterministically", () => {
    const experiences = [
      education("北京大学", "bachelor"),
      education("普通示范学院", "master")
    ];
    expect(evaluateInstitutionCategoryRule(categoryRule(), experiences, catalog).decision).toBe("matched");
    expect(
      evaluateInstitutionCategoryRule(categoryRule({ educationStage: "master" }), experiences, catalog)
        .decision
    ).toBe("not_matched");
    expect(
      evaluateInstitutionCategoryRule(categoryRule({ educationStage: "highest" }), experiences, catalog)
        .decision
    ).toBe("not_matched");
    expect(
      evaluateInstitutionCategoryRule(categoryRule({ educationStage: "any" }), experiences, catalog).decision
    ).toBe("matched");
    expect(
      evaluateInstitutionCategoryRule(categoryRule({ educationStage: "all" }), experiences, catalog).decision
    ).toBe("not_matched");
  });

  it("uses the highest stage rather than the latest array position", () => {
    const experiences = [
      education("普通示范学院", "master"),
      education("北京大学", "bachelor")
    ];
    const result = evaluateInstitutionCategoryRule(
      categoryRule({ educationStage: "highest" }),
      experiences,
      catalog
    );
    expect(result.decision).toBe("not_matched");
    expect(result.evidence.find((item) => item.educationStage === "master")?.result).toBe(
      "not_matched"
    );
  });

  it("requires both institution and major for a double-first-class discipline", () => {
    const rule = categoryRule({
      categories: ["double_first_class_discipline"]
    });
    const matched = evaluateInstitutionCategoryRule(
      rule,
      [education("学科示范大学", "bachelor", { major: "计算机科学与技术" })],
      catalog
    );
    const wrongMajor = evaluateInstitutionCategoryRule(
      rule,
      [education("学科示范大学", "bachelor", { major: "经济学" })],
      catalog
    );
    const missingMajor = evaluateInstitutionCategoryRule(
      rule,
      [education("学科示范大学")],
      catalog
    );

    expect(matched.decision).toBe("matched");
    expect(matched.reasonCodes).toContain("category_matched");
    expect(matched.evidence[0]?.reasons).toContain("discipline_matched");
    expect(wrongMajor.decision).toBe("not_matched");
    expect(wrongMajor.evidence[0]?.reasons).toContain("discipline_not_listed");
    expect(missingMajor.decision).toBe("manual_review");
    expect(missingMajor.reasonCodes).toContain("missing_major_for_discipline");
  });

  it("keeps the full evidence chain for audit", () => {
    const result = evaluateInstitutionCategoryRule(categoryRule(), [
      education("北大", "bachelor", {
        id: "edu-1",
        major: "英语",
        evidence: { sourceText: "2018-2022 北大 英语专业 本科", page: 2, artifactRef: "ocr-1" }
      })
    ], catalog);

    expect(result.evidence[0]).toMatchObject({
      experienceId: "edu-1",
      educationStage: "bachelor",
      institutionRaw: "北大",
      normalizedInstitution: "北大",
      institutionId: "inst-peking",
      standardInstitution: "北京大学",
      aliasId: "alias-peking-abbr",
      aliasKind: "abbreviation",
      categoriesSnapshot: ["project_985", "project_211", "double_first_class_university"],
      catalogVersion: TEST_CATALOG_VERSION,
      major: "英语",
      sourceText: "2018-2022 北大 英语专业 本科",
      sourcePage: 2,
      artifactRef: "ocr-1"
    });
  });
});

describe("unknown and manual-review boundaries", () => {
  it.each([
    ["manual_review", "manual_review", "unknown_policy_manual_review"],
    ["fail", "not_matched", "unknown_policy_fail"],
    ["ignore", "ignored", "unknown_policy_ignore"]
  ] as const)("applies %s when no exact catalog match exists", (unknownPolicy, decision, reason) => {
    const result = evaluateInstitutionCategoryRule(
      categoryRule({ unknownPolicy }),
      [education("未收录示范大学")],
      catalog
    );
    expect(result.decision).toBe(decision);
    expect(result.reasonCodes).toContain(reason);
    expect(result.evidence[0]?.reasons).toContain("unknown_institution");
  });

  it("never lets an ambiguous alias auto-fail", () => {
    const result = evaluateInstitutionCategoryRule(
      categoryRule({ unknownPolicy: "fail" }),
      [education("城大")],
      catalog
    );
    expect(result.decision).toBe("manual_review");
    expect(result.reasonCodes).toContain("ambiguous_institution");
    expect(result.evidence[0]?.candidateInstitutionIds).toEqual(["inst-city-a", "inst-city-b"]);
  });

  it("never guesses an unreviewed campus mapping", () => {
    const unknown = evaluateInstitutionCategoryRule(
      categoryRule({ unknownPolicy: "fail" }),
      [education("北京大学", "bachelor", { campusOrCollege: "未收录研究院" })],
      catalog
    );
    const verified = evaluateInstitutionCategoryRule(
      categoryRule(),
      [education("北京大学", "bachelor", { campusOrCollege: "深圳研究生院" })],
      catalog
    );
    expect(unknown.decision).toBe("manual_review");
    expect(unknown.reasonCodes).toContain("unverified_campus_or_college");
    expect(verified.decision).toBe("matched");
    expect(verified.evidence[0]?.aliasId).toBe("alias-peking-shenzhen");
  });

  it("forces review for conflicting stage evidence", () => {
    const result = evaluateInstitutionCategoryRule(
      categoryRule({ unknownPolicy: "fail" }),
      [education("北京大学", "bachelor", { degree: "硕士研究生" })],
      catalog
    );
    expect(result.decision).toBe("manual_review");
    expect(result.reasonCodes).toContain("conflicting_education_stage");
  });

  it("routes multiple conflicting target institutions to review", () => {
    const result = evaluateInstitutionCategoryRule(
      categoryRule({ unknownPolicy: "fail" }),
      [education("北京大学"), education("普通示范学院")],
      catalog
    );
    expect(result.decision).toBe("manual_review");
    expect(result.reasonCodes).toContain("conflicting_target_experiences");
  });

  it("does not count training, exchange, or short courses as formal education", () => {
    for (const attendanceType of ["training", "exchange", "short_course"] as const) {
      const result = evaluateInstitutionCategoryRule(
        categoryRule(),
        [education("北京大学", "bachelor", { attendanceType })],
        catalog
      );
      expect(result.decision).toBe("manual_review");
      expect(result.reasonCodes).toContain("no_target_education");
      expect(result.evidence[0]).toMatchObject({
        result: "excluded",
        reasons: ["non_formal_education_ignored"]
      });
    }
  });

  it("uses a confirmed awarding institution for joint programs", () => {
    const pending = evaluateInstitutionCategoryRule(
      categoryRule({ educationStage: "master" }),
      [education("联合培养项目", "master", { attendanceType: "joint_program" })],
      catalog
    );
    const confirmed = evaluateInstitutionCategoryRule(
      categoryRule({ educationStage: "master" }),
      [
        education("联合培养项目", "master", {
          attendanceType: "joint_program",
          awardingInstitutionConfirmed: true,
          awardingInstitutionRaw: "北京大学"
        })
      ],
      catalog
    );
    expect(pending.decision).toBe("manual_review");
    expect(pending.reasonCodes).toContain("unconfirmed_awarding_institution");
    expect(confirmed.decision).toBe("matched");
    expect(confirmed.evidence[0]?.standardInstitution).toBe("北京大学");
  });

  it("fails closed to review for an unpublished, mismatched, or tampered catalog", () => {
    const unpublished = buildInstitutionCatalog({ status: "validated" });
    const mismatched = buildInstitutionCatalog({ version: "cn-institution-test-2026.02" });
    const tampered = structuredClone(catalog) as InstitutionCatalog;
    tampered.institutions[0]!.standardName = "被篡改的名称";

    expect(
      evaluateInstitutionCategoryRule(categoryRule(), [education("北京大学")], unpublished).reasonCodes
    ).toContain("catalog_not_published");
    expect(
      evaluateInstitutionCategoryRule(categoryRule(), [education("北京大学")], mismatched).reasonCodes
    ).toContain("catalog_version_mismatch");
    expect(
      evaluateInstitutionCategoryRule(categoryRule(), [education("北京大学")], tampered).reasonCodes
    ).toContain("catalog_validation_failed");
  });

  it("keeps old results pinned when a new catalog version changes categories", () => {
    const oldCatalog = buildInstitutionCatalog();
    const newDraft = institutionCatalogDraft({ version: "cn-institution-test-2026.02" });
    newDraft.institutions.find((item) => item.id === "inst-985-only")!.categories = ["project_211"];
    const newCatalog = createInstitutionCatalog(newDraft);
    const oldRule = categoryRule({ categories: ["project_985"] });
    const newRule = categoryRule({
      categories: ["project_985"],
      catalogVersion: newCatalog.version
    });
    const candidate = [education("甲示范大学")];

    expect(evaluateInstitutionCategoryRule(oldRule, candidate, oldCatalog).decision).toBe("matched");
    expect(evaluateInstitutionCategoryRule(newRule, candidate, newCatalog).decision).toBe("not_matched");
    expect(evaluateInstitutionCategoryRule(oldRule, candidate, newCatalog).decision).toBe("manual_review");
    expect(newCatalog.contentHash).not.toBe(oldCatalog.contentHash);
  });
});
