import { createHash } from "node:crypto";
import {
  INSTITUTION_CATEGORY_CODES,
  type CatalogValidationIssue,
  type CatalogValidationResult,
  type Institution,
  type InstitutionAlias,
  type InstitutionAliasKind,
  type InstitutionCatalog,
  type InstitutionCatalogDraft,
  type InstitutionResolution
} from "./institution-types.js";

const CATALOG_STATUSES = new Set(["draft", "validated", "published", "retired"]);
const INSTITUTION_KINDS = new Set([
  "university",
  "college",
  "independent_college",
  "campus",
  "research_institute",
  "other"
]);
const ALIAS_KINDS = new Set<InstitutionAliasKind>([
  "abbreviation",
  "english_name",
  "former_name",
  "ocr_variant",
  "campus_mapping"
]);
const CATEGORY_CODES = new Set<string>(INSTITUTION_CATEGORY_CODES);
const CONTENT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const SELF_REPORTED_CATEGORY_PATTERN =
  /^(?:985|211|985(?:或|和|及|\/)?211|211(?:或|和|及|\/)?985|985院校|211院校|双一流|重点大学)$/u;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type CatalogMatch = {
  institution: Institution;
  alias: InstitutionAlias | null;
};

const VALIDATION_CACHE = new WeakMap<object, CatalogValidationResult>();
const INDEX_CACHE = new WeakMap<object, Map<string, CatalogMatch[]>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidDateOnly(value: unknown): value is string {
  if (!isNonEmptyString(value) || !DATE_PATTERN.test(value)) return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]!);
  const month = Number(match[2]!);
  const day = Number(match[3]!);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function isValidDateTime(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function issue(
  severity: CatalogValidationIssue["severity"],
  code: CatalogValidationIssue["code"],
  path: string,
  message: string
): CatalogValidationIssue {
  return { severity, code, path, message };
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key] ?? null)}`)
    .join(",")}}`;
}

function canonicalDraft(draft: InstitutionCatalogDraft): JsonValue {
  return {
    schemaVersion: draft.schemaVersion,
    version: draft.version,
    status: draft.status,
    source: {
      name: draft.source.name,
      asOfDate: draft.source.asOfDate,
      ...(draft.source.url ? { url: draft.source.url } : {})
    },
    importedBy: draft.importedBy,
    reviewedBy: draft.reviewedBy,
    publishedAt: draft.publishedAt,
    changeSummary: draft.changeSummary,
    institutions: [...draft.institutions]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((institution) => ({
        id: institution.id,
        standardName: institution.standardName,
        countryOrRegion: institution.countryOrRegion,
        kind: institution.kind,
        categories: [...institution.categories].sort(),
        aliases: [...institution.aliases]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((alias) => ({
            id: alias.id,
            value: alias.value,
            kind: alias.kind,
            ...(alias.confidence === undefined ? {} : { confidence: alias.confidence })
          })),
        ...(institution.doubleFirstClassDisciplines
          ? { doubleFirstClassDisciplines: [...institution.doubleFirstClassDisciplines].sort() }
          : {}),
        ...(institution.validFrom ? { validFrom: institution.validFrom } : {}),
        ...(institution.validTo ? { validTo: institution.validTo } : {})
      }))
  };
}

/**
 * NFKC + case/punctuation folding for exact matches only. This deliberately does
 * not perform fuzzy matching, prefix inheritance, suffix removal, or model calls.
 */
export function normalizeInstitutionName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\u00a0\u2000-\u200d\u202f\u205f\u3000\s]/gu, "")
    .replace(/[·•・.,，。'’‘`"“”()（）[\]【】{}《》<>〈〉:：;；/_\\‐‑‒–—−-]/gu, "");
}

export function normalizeDisciplineName(value: string): string {
  return normalizeInstitutionName(value);
}

export function calculateInstitutionCatalogHash(
  catalog: InstitutionCatalogDraft | InstitutionCatalog
): string {
  const { contentHash: _ignored, ...draft } = catalog as InstitutionCatalog;
  return `sha256:${createHash("sha256").update(stableJson(canonicalDraft(draft))).digest("hex")}`;
}

function validateInstitution(
  value: unknown,
  path: string,
  institutionIds: Set<string>,
  aliasIds: Set<string>,
  aliasOwners: Map<string, Set<string>>,
  errors: CatalogValidationIssue[],
  warnings: CatalogValidationIssue[]
): void {
  if (!isRecord(value)) {
    errors.push(issue("error", "invalid_shape", path, "Institution must be an object."));
    return;
  }

  if (!isNonEmptyString(value.id)) {
    errors.push(issue("error", "missing_value", `${path}.id`, "Institution id is required."));
  } else if (institutionIds.has(value.id)) {
    errors.push(
      issue("error", "duplicate_institution_id", `${path}.id`, `Duplicate id: ${value.id}`)
    );
  } else {
    institutionIds.add(value.id);
  }

  for (const field of ["standardName", "countryOrRegion"] as const) {
    if (!isNonEmptyString(value[field])) {
      errors.push(issue("error", "missing_value", `${path}.${field}`, `${field} is required.`));
    }
  }

  if (!isNonEmptyString(value.kind) || !INSTITUTION_KINDS.has(value.kind)) {
    errors.push(issue("error", "invalid_shape", `${path}.kind`, "Unknown institution kind."));
  }

  if (!Array.isArray(value.categories)) {
    errors.push(issue("error", "invalid_shape", `${path}.categories`, "Categories must be an array."));
  } else {
    const seenCategories = new Set<string>();
    value.categories.forEach((category, index) => {
      if (typeof category !== "string" || !CATEGORY_CODES.has(category)) {
        errors.push(
          issue("error", "invalid_category", `${path}.categories[${index}]`, "Unknown category.")
        );
      } else if (seenCategories.has(category)) {
        errors.push(
          issue(
            "error",
            "invalid_category",
            `${path}.categories[${index}]`,
            `Duplicate category: ${category}`
          )
        );
      } else {
        seenCategories.add(category);
      }
    });

    const disciplines = value.doubleFirstClassDisciplines;
    if (seenCategories.has("double_first_class_discipline")) {
      if (
        !Array.isArray(disciplines) ||
        disciplines.length === 0 ||
        disciplines.some((item) => !isNonEmptyString(item))
      ) {
        errors.push(
          issue(
            "error",
            "missing_discipline",
            `${path}.doubleFirstClassDisciplines`,
            "Discipline category requires at least one reviewed discipline."
          )
        );
      }
    } else if (Array.isArray(disciplines) && disciplines.length > 0) {
      warnings.push(
        issue(
          "warning",
          "unexpected_discipline",
          `${path}.doubleFirstClassDisciplines`,
          "Disciplines are ignored unless the discipline category is present."
        )
      );
    }
  }

  if (value.validFrom !== undefined && !isValidDateOnly(value.validFrom)) {
    errors.push(issue("error", "invalid_date", `${path}.validFrom`, "Use YYYY-MM-DD."));
  }
  if (value.validTo !== undefined && !isValidDateOnly(value.validTo)) {
    errors.push(issue("error", "invalid_date", `${path}.validTo`, "Use YYYY-MM-DD."));
  }
  if (
    isValidDateOnly(value.validFrom) &&
    isValidDateOnly(value.validTo) &&
    value.validFrom > value.validTo
  ) {
    errors.push(issue("error", "invalid_date", `${path}.validTo`, "validTo precedes validFrom."));
  }

  const institutionId = isNonEmptyString(value.id) ? value.id : path;
  const localAliasValues = new Set<string>();
  if (isNonEmptyString(value.standardName)) {
    const normalizedStandard = normalizeInstitutionName(value.standardName);
    const owners = aliasOwners.get(normalizedStandard) ?? new Set<string>();
    owners.add(institutionId);
    aliasOwners.set(normalizedStandard, owners);
    localAliasValues.add(normalizedStandard);
  }

  if (!Array.isArray(value.aliases)) {
    errors.push(issue("error", "invalid_shape", `${path}.aliases`, "Aliases must be an array."));
    return;
  }

  value.aliases.forEach((aliasValue, aliasIndex) => {
    const aliasPath = `${path}.aliases[${aliasIndex}]`;
    if (!isRecord(aliasValue)) {
      errors.push(issue("error", "invalid_shape", aliasPath, "Alias must be an object."));
      return;
    }
    if (!isNonEmptyString(aliasValue.id)) {
      errors.push(issue("error", "missing_value", `${aliasPath}.id`, "Alias id is required."));
    } else if (aliasIds.has(aliasValue.id)) {
      errors.push(
        issue("error", "duplicate_alias_id", `${aliasPath}.id`, `Duplicate id: ${aliasValue.id}`)
      );
    } else {
      aliasIds.add(aliasValue.id);
    }
    if (!isNonEmptyString(aliasValue.value)) {
      errors.push(issue("error", "missing_value", `${aliasPath}.value`, "Alias value is required."));
    } else {
      const normalizedAlias = normalizeInstitutionName(aliasValue.value);
      if (localAliasValues.has(normalizedAlias)) {
        errors.push(
          issue(
            "error",
            "duplicate_alias_value",
            `${aliasPath}.value`,
            "Normalized alias duplicates another name for this institution."
          )
        );
      }
      localAliasValues.add(normalizedAlias);
      const owners = aliasOwners.get(normalizedAlias) ?? new Set<string>();
      owners.add(institutionId);
      aliasOwners.set(normalizedAlias, owners);
    }
    if (!isNonEmptyString(aliasValue.kind) || !ALIAS_KINDS.has(aliasValue.kind as InstitutionAliasKind)) {
      errors.push(issue("error", "invalid_alias_kind", `${aliasPath}.kind`, "Unknown alias kind."));
    }
    if (
      aliasValue.confidence !== undefined &&
      (typeof aliasValue.confidence !== "number" ||
        !Number.isFinite(aliasValue.confidence) ||
        aliasValue.confidence <= 0 ||
        aliasValue.confidence > 1)
    ) {
      errors.push(
        issue(
          "error",
          "invalid_confidence",
          `${aliasPath}.confidence`,
          "Confidence must be greater than 0 and at most 1."
        )
      );
    }
  });
}

export function validateInstitutionCatalog(value: unknown): CatalogValidationResult {
  if (typeof value === "object" && value !== null) {
    const cached = VALIDATION_CACHE.get(value);
    if (cached) return cached;
  }
  const errors: CatalogValidationIssue[] = [];
  const warnings: CatalogValidationIssue[] = [];
  if (!isRecord(value)) {
    errors.push(issue("error", "invalid_shape", "$", "Catalog must be an object."));
    return { valid: false, errors, warnings };
  }

  if (value.schemaVersion !== "1.0") {
    errors.push(
      issue("error", "invalid_schema_version", "$.schemaVersion", "Only schema version 1.0 is supported.")
    );
  }
  for (const field of ["version", "importedBy", "reviewedBy", "changeSummary"] as const) {
    if (!isNonEmptyString(value[field])) {
      errors.push(issue("error", "missing_value", `$.${field}`, `${field} is required.`));
    }
  }
  if (!isNonEmptyString(value.status) || !CATALOG_STATUSES.has(value.status)) {
    errors.push(issue("error", "invalid_status", "$.status", "Unknown catalog status."));
  }
  if (!isValidDateTime(value.publishedAt)) {
    errors.push(issue("error", "invalid_date", "$.publishedAt", "publishedAt must be an ISO datetime."));
  }
  if (!isRecord(value.source)) {
    errors.push(issue("error", "invalid_shape", "$.source", "Source must be an object."));
  } else {
    if (!isNonEmptyString(value.source.name)) {
      errors.push(issue("error", "missing_value", "$.source.name", "Source name is required."));
    }
    if (!isValidDateOnly(value.source.asOfDate)) {
      errors.push(issue("error", "invalid_date", "$.source.asOfDate", "Use YYYY-MM-DD."));
    }
  }

  const institutionIds = new Set<string>();
  const aliasIds = new Set<string>();
  const aliasOwners = new Map<string, Set<string>>();
  if (!Array.isArray(value.institutions) || value.institutions.length === 0) {
    errors.push(
      issue("error", "invalid_shape", "$.institutions", "At least one institution is required.")
    );
  } else {
    value.institutions.forEach((institution, index) =>
      validateInstitution(
        institution,
        `$.institutions[${index}]`,
        institutionIds,
        aliasIds,
        aliasOwners,
        errors,
        warnings
      )
    );
  }

  for (const [normalizedAlias, owners] of aliasOwners) {
    if (owners.size > 1) {
      warnings.push(
        issue(
          "warning",
          "ambiguous_alias",
          "$.institutions",
          `Normalized alias ${JSON.stringify(normalizedAlias)} maps to ${[...owners].sort().join(", ")}.`
        )
      );
    }
  }

  if (!isNonEmptyString(value.contentHash) || !CONTENT_HASH_PATTERN.test(value.contentHash)) {
    errors.push(
      issue("error", "invalid_content_hash", "$.contentHash", "Expected sha256:<64 lowercase hex chars>.")
    );
  } else if (errors.length === 0) {
    const expected = calculateInstitutionCatalogHash(value as InstitutionCatalog);
    if (expected !== value.contentHash) {
      errors.push(
        issue(
          "error",
          "content_hash_mismatch",
          "$.contentHash",
          `Catalog content does not match ${value.contentHash}.`
        )
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export class InstitutionCatalogValidationError extends Error {
  readonly validation: CatalogValidationResult;

  constructor(validation: CatalogValidationResult) {
    super(validation.errors.map((item) => `${item.path}: ${item.message}`).join("; "));
    this.name = "InstitutionCatalogValidationError";
    this.validation = validation;
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function createInstitutionCatalog(draft: InstitutionCatalogDraft): InstitutionCatalog {
  const clonedDraft = structuredClone(draft);
  const catalog: InstitutionCatalog = {
    ...clonedDraft,
    contentHash: calculateInstitutionCatalogHash(clonedDraft)
  };
  const validation = validateInstitutionCatalog(catalog);
  if (!validation.valid) throw new InstitutionCatalogValidationError(validation);
  const frozen = deepFreeze(catalog);
  VALIDATION_CACHE.set(frozen, validation);
  return frozen;
}

/** Validates an externally loaded snapshot and freezes a defensive copy. */
export function loadInstitutionCatalog(value: unknown): InstitutionCatalog {
  const cloned = structuredClone(value);
  const validation = validateInstitutionCatalog(cloned);
  if (!validation.valid) throw new InstitutionCatalogValidationError(validation);
  const frozen = deepFreeze(cloned as InstitutionCatalog);
  VALIDATION_CACHE.set(frozen, validation);
  return frozen;
}

function aliasConfidence(alias: InstitutionAlias | null): number {
  if (!alias) return 1;
  if (alias.confidence !== undefined) return alias.confidence;
  switch (alias.kind) {
    case "abbreviation":
    case "english_name":
      return 0.99;
    case "former_name":
      return 0.98;
    case "ocr_variant":
      return 0.95;
    case "campus_mapping":
      return 1;
  }
}

function buildIndex(catalog: InstitutionCatalog): Map<string, CatalogMatch[]> {
  const index = new Map<string, CatalogMatch[]>();
  for (const institution of catalog.institutions) {
    const names: Array<{ value: string; alias: InstitutionAlias | null }> = [
      { value: institution.standardName, alias: null },
      ...institution.aliases.map((alias) => ({ value: alias.value, alias }))
    ];
    for (const name of names) {
      const normalized = normalizeInstitutionName(name.value);
      const matches = index.get(normalized) ?? [];
      if (!matches.some((match) => match.institution.id === institution.id)) {
        matches.push({ institution, alias: name.alias });
      }
      index.set(normalized, matches);
    }
  }
  return index;
}

function catalogIndex(catalog: InstitutionCatalog): Map<string, CatalogMatch[]> {
  const cached = INDEX_CACHE.get(catalog);
  if (cached) return cached;
  const index = buildIndex(catalog);
  if (Object.isFrozen(catalog)) INDEX_CACHE.set(catalog, index);
  return index;
}

function unknownResolution(
  reason: Extract<InstitutionResolution, { status: "unknown" }>["reason"],
  rawName: string,
  normalizedName: string,
  catalog: InstitutionCatalog,
  candidateInstitutionIds: string[] = []
): InstitutionResolution {
  return {
    status: "unknown",
    reason,
    rawName,
    normalizedName,
    candidateInstitutionIds,
    confidence: 0,
    catalogVersion: catalog.version
  };
}

/** Resolves reviewed exact names only; there is intentionally no fuzzy fallback. */
export function resolveInstitution(
  rawName: string,
  catalog: InstitutionCatalog,
  options: { campusOrCollege?: string } = {}
): InstitutionResolution {
  const normalizedName = normalizeInstitutionName(rawName);
  if (!normalizedName) {
    return unknownResolution("blank_institution_name", rawName, normalizedName, catalog);
  }

  const index = catalogIndex(catalog);
  let matches = index.get(normalizedName) ?? [];
  const campus = options.campusOrCollege?.trim() ?? "";
  if (campus) {
    const combined = normalizeInstitutionName(`${rawName}${campus}`);
    const mapped = (index.get(combined) ?? []).filter(
      (match) => match.alias?.kind === "campus_mapping" || match.institution.kind === "campus"
    );
    if (mapped.length > 0) {
      matches = mapped;
    } else if (
      !matches.some(
        (match) => match.alias?.kind === "campus_mapping" || match.institution.kind === "campus"
      )
    ) {
      return unknownResolution(
        "unverified_campus_or_college",
        rawName,
        normalizedName,
        catalog,
        matches.map((match) => match.institution.id).sort()
      );
    }
  }

  if (matches.length === 0) {
    return unknownResolution(
      SELF_REPORTED_CATEGORY_PATTERN.test(normalizedName)
        ? "self_reported_category_only"
        : "no_exact_catalog_match",
      rawName,
      normalizedName,
      catalog
    );
  }

  const distinctInstitutions = new Map(matches.map((match) => [match.institution.id, match]));
  if (distinctInstitutions.size > 1) {
    return {
      status: "ambiguous",
      reason: "ambiguous_exact_alias",
      rawName,
      normalizedName,
      candidateInstitutionIds: [...distinctInstitutions.keys()].sort(),
      confidence: 0,
      catalogVersion: catalog.version
    };
  }

  const match = [...distinctInstitutions.values()][0]!;
  return {
    status: "resolved",
    reason: match.alias ? "exact_reviewed_alias" : "exact_standard_name",
    rawName,
    normalizedName,
    institutionId: match.institution.id,
    standardName: match.institution.standardName,
    aliasId: match.alias?.id ?? null,
    aliasKind: match.alias?.kind ?? "standard_name",
    confidence: aliasConfidence(match.alias),
    categories: [...match.institution.categories],
    catalogVersion: catalog.version
  };
}
