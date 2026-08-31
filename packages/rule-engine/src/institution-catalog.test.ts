import { describe, expect, it } from "vitest";
import {
  calculateInstitutionCatalogHash,
  createInstitutionCatalog,
  InstitutionCatalogValidationError,
  loadInstitutionCatalog,
  normalizeInstitutionName,
  resolveInstitution,
  validateInstitutionCatalog
} from "./institution-catalog.js";
import {
  buildInstitutionCatalog,
  institutionCatalogDraft,
  TEST_CATALOG_VERSION
} from "./institution-test-support.js";
import type { InstitutionCatalog } from "./institution-types.js";

describe("versioned institution catalog", () => {
  it("creates a validated immutable snapshot with a stable content hash", () => {
    const first = buildInstitutionCatalog();
    const reordered = institutionCatalogDraft();
    reordered.institutions.reverse();
    reordered.institutions.forEach((institution) => {
      institution.categories.reverse();
      institution.aliases.reverse();
      institution.doubleFirstClassDisciplines?.reverse();
    });
    const second = createInstitutionCatalog(reordered);

    expect(first.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(second.contentHash).toBe(first.contentHash);
    expect(calculateInstitutionCatalogHash(first)).toBe(first.contentHash);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.institutions[0])).toBe(true);
  });

  it("detects content changes without silently accepting the old hash", () => {
    const catalog = buildInstitutionCatalog();
    const tampered = structuredClone(catalog) as InstitutionCatalog;
    tampered.institutions[0]!.categories = ["other_domestic"];

    const validation = validateInstitutionCatalog(tampered);
    expect(validation.valid).toBe(false);
    expect(validation.errors.map((item) => item.code)).toContain("content_hash_mismatch");
  });

  it("validates and freezes externally loaded catalog snapshots", () => {
    const external = structuredClone(buildInstitutionCatalog());
    const loaded = loadInstitutionCatalog(external);
    expect(loaded).not.toBe(external);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(validateInstitutionCatalog(loaded).valid).toBe(true);
  });

  it("rejects impossible calendar dates", () => {
    const draft = institutionCatalogDraft();
    draft.source.asOfDate = "2026-02-30";
    expect(() => createInstitutionCatalog(draft)).toThrow(InstitutionCatalogValidationError);
  });

  it("requires reviewed discipline data for a discipline category", () => {
    const draft = institutionCatalogDraft();
    const disciplineInstitution = draft.institutions.find(
      (institution) => institution.id === "inst-discipline"
    )!;
    delete disciplineInstitution.doubleFirstClassDisciplines;

    expect(() => createInstitutionCatalog(draft)).toThrow(InstitutionCatalogValidationError);
    try {
      createInstitutionCatalog(draft);
    } catch (error) {
      expect((error as InstitutionCatalogValidationError).validation.errors.map((item) => item.code)).toContain(
        "missing_discipline"
      );
    }
  });

  it("rejects duplicate names within one institution but records cross-school ambiguity", () => {
    const validCatalog = buildInstitutionCatalog();
    const validResult = validateInstitutionCatalog(validCatalog);
    expect(validResult.valid).toBe(true);
    expect(validResult.warnings.map((item) => item.code)).toContain("ambiguous_alias");

    const draft = institutionCatalogDraft();
    draft.institutions[0]!.aliases.push({
      id: "alias-duplicate-standard",
      value: " 北 京 大 学 ",
      kind: "ocr_variant"
    });
    expect(() => createInstitutionCatalog(draft)).toThrow(InstitutionCatalogValidationError);
  });
});

describe("deterministic institution resolution", () => {
  const catalog = buildInstitutionCatalog();

  it.each([
    ["北京大学", "exact_standard_name", null],
    ["北大", "exact_reviewed_alias", "alias-peking-abbr"],
    ["PEKING UNIVERSITY", "exact_reviewed_alias", "alias-peking-en"],
    ["京师大学堂", "exact_reviewed_alias", "alias-peking-former"],
    ["北京大學", "exact_reviewed_alias", "alias-peking-ocr"]
  ] as const)("resolves a reviewed exact name: %s", (raw, reason, aliasId) => {
    const result = resolveInstitution(raw, catalog);
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.institutionId).toBe("inst-peking");
    expect(result.reason).toBe(reason);
    expect(result.aliasId).toBe(aliasId);
    expect(result.catalogVersion).toBe(TEST_CATALOG_VERSION);
  });

  it("normalizes typography but does not remove semantic words", () => {
    expect(normalizeInstitutionName(" Peking-University（北京） ")).toBe("pekinguniversity北京");
    expect(resolveInstitution("北京大", catalog).status).toBe("unknown");
  });

  it("never treats a category self-description as an institution", () => {
    const result = resolveInstitution("985/211", catalog);
    expect(result.status).toBe("unknown");
    if (result.status === "unknown") expect(result.reason).toBe("self_reported_category_only");
  });

  it("returns all candidates for a reviewed but ambiguous alias", () => {
    const result = resolveInstitution("城大", catalog);
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") return;
    expect(result.candidateInstitutionIds).toEqual(["inst-city-a", "inst-city-b"]);
  });

  it("does not inherit a parent category by name prefix", () => {
    const result = resolveInstitution("北京大学独立学院", catalog);
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.institutionId).toBe("inst-independent");
    expect(result.categories).toEqual(["other_domestic"]);
  });

  it("requires an explicit reviewed campus mapping", () => {
    const verified = resolveInstitution("北京大学", catalog, {
      campusOrCollege: "深圳研究生院"
    });
    expect(verified.status).toBe("resolved");
    if (verified.status === "resolved") expect(verified.aliasKind).toBe("campus_mapping");

    const unknown = resolveInstitution("北京大学", catalog, {
      campusOrCollege: "未收录研究院"
    });
    expect(unknown.status).toBe("unknown");
    if (unknown.status === "unknown") expect(unknown.reason).toBe("unverified_campus_or_college");
  });
});
