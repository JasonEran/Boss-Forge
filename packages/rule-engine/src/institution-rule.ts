import {
  normalizeDisciplineName,
  normalizeInstitutionName,
  resolveInstitution,
  validateInstitutionCatalog
} from "./institution-catalog.js";
import {
  INSTITUTION_CATEGORY_CODES,
  type EducationExperienceInput,
  type EducationStage,
  type EducationStageResolution,
  type Institution,
  type InstitutionCatalog,
  type InstitutionCategoryRule,
  type InstitutionResolution,
  type InstitutionRuleEvaluation,
  type InstitutionRuleEvidence,
  type InstitutionRuleReasonCode
} from "./institution-types.js";

const CATEGORY_CODES = new Set<string>(INSTITUTION_CATEGORY_CODES);
const EDUCATION_STAGES = new Set(["associate", "bachelor", "master", "doctor", "other"]);
const EDUCATION_STAGE_SELECTORS = new Set([
  "associate",
  "bachelor",
  "master",
  "doctor",
  "other",
  "highest",
  "any",
  "all"
]);
const MODES = new Set(["any", "all"]);
const UNKNOWN_POLICIES = new Set(["manual_review", "fail", "ignore"]);
const STAGE_RANK: Record<EducationStage, number> = {
  other: 0,
  associate: 1,
  bachelor: 2,
  master: 3,
  doctor: 4
};
const STAGE_PATTERNS: ReadonlyArray<{ stage: EducationStage; pattern: RegExp }> = [
  { stage: "doctor", pattern: /博士|博士研究生|doctorate|\bph\.?\s*d\.?\b/iu },
  { stage: "master", pattern: /硕士|硕士研究生|\bmaster(?:'s)?\b|\bm\.?\s*sc\.?\b|\bmba\b/iu },
  { stage: "bachelor", pattern: /本科|学士|\bbachelor(?:'s)?\b|\bb\.?\s*sc\.?\b/iu },
  { stage: "associate", pattern: /专科|大专|副学士|\bassociate(?:'s)?\b/iu }
];

type ExperienceState = {
  input: EducationExperienceInput;
  stage: EducationStageResolution;
  evidence: InstitutionRuleEvidence;
};

const ALWAYS_MANUAL_REVIEW = new Set<InstitutionRuleReasonCode>([
  "conflicting_education_stage",
  "ambiguous_institution",
  "unverified_campus_or_college",
  "conflicting_target_experiences",
  "catalog_version_mismatch",
  "catalog_not_published",
  "catalog_validation_failed"
]);

export class InstitutionRuleConfigurationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues.join("; "));
    this.name = "InstitutionRuleConfigurationError";
    this.issues = issues;
  }
}

export function validateInstitutionCategoryRule(value: unknown): string[] {
  const issues: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["Rule must be an object."];
  }
  const rule = value as Record<string, unknown>;
  if (rule.type !== "institution_category") issues.push("type must be institution_category.");
  if (typeof rule.educationStage !== "string" || !EDUCATION_STAGE_SELECTORS.has(rule.educationStage)) {
    issues.push("educationStage is invalid.");
  }
  if (!Array.isArray(rule.categories) || rule.categories.length === 0) {
    issues.push("categories must contain at least one category.");
  } else {
    const seen = new Set<string>();
    for (const category of rule.categories) {
      if (typeof category !== "string" || !CATEGORY_CODES.has(category)) {
        issues.push(`Unknown institution category: ${String(category)}.`);
      } else if (seen.has(category)) {
        issues.push(`Duplicate institution category: ${category}.`);
      }
      if (typeof category === "string") seen.add(category);
    }
  }
  if (typeof rule.mode !== "string" || !MODES.has(rule.mode)) issues.push("mode is invalid.");
  if (typeof rule.required !== "boolean") issues.push("required must be boolean.");
  if (typeof rule.catalogVersion !== "string" || rule.catalogVersion.trim().length === 0) {
    issues.push("catalogVersion is required.");
  }
  if (typeof rule.unknownPolicy !== "string" || !UNKNOWN_POLICIES.has(rule.unknownPolicy)) {
    issues.push("unknownPolicy is invalid.");
  }
  return issues;
}

export function resolveEducationStage(
  input: Pick<EducationExperienceInput, "stage" | "degree" | "qualification">
): EducationStageResolution {
  const text = `${input.degree ?? ""} ${input.qualification ?? ""}`.normalize("NFKC");
  const detected = STAGE_PATTERNS.filter((definition) => definition.pattern.test(text)).map(
    (definition) => definition.stage
  );
  const candidates = [...new Set(detected)];

  if (input.stage !== undefined) {
    if (!EDUCATION_STAGES.has(input.stage)) {
      return { status: "unknown", candidates: [], reason: "missing_stage_evidence" };
    }
    if (candidates.length > 0 && candidates.some((candidate) => candidate !== input.stage)) {
      return {
        status: "ambiguous",
        candidates: [...new Set([input.stage, ...candidates])],
        reason: "conflicting_stage_evidence"
      };
    }
    return { status: "resolved", stage: input.stage, source: "explicit" };
  }

  if (candidates.length === 1) {
    return { status: "resolved", stage: candidates[0]!, source: "degree_text" };
  }
  if (candidates.length > 1) {
    return { status: "ambiguous", candidates, reason: "conflicting_stage_evidence" };
  }
  return { status: "unknown", candidates: [], reason: "missing_stage_evidence" };
}

function uniqueReasons(reasons: InstitutionRuleReasonCode[]): InstitutionRuleReasonCode[] {
  return [...new Set(reasons)];
}

function institutionForResolution(
  resolution: InstitutionResolution,
  catalog: InstitutionCatalog
): Institution | null {
  if (resolution.status !== "resolved") return null;
  return catalog.institutions.find((item) => item.id === resolution.institutionId) ?? null;
}

function baseEvidence(
  input: EducationExperienceInput,
  stage: EducationStageResolution,
  catalog: InstitutionCatalog,
  resolution: InstitutionResolution | null
): Omit<InstitutionRuleEvidence, "result" | "reasons"> {
  const resolved = resolution?.status === "resolved" ? resolution : null;
  return {
    experienceId: input.id ?? null,
    educationStage: stage.status === "resolved" ? stage.stage : null,
    stageStatus: stage.status,
    institutionRaw: input.institutionRaw,
    evaluatedInstitutionRaw: resolution?.rawName ?? input.institutionRaw,
    normalizedInstitution: resolution?.normalizedName ?? normalizeInstitutionName(input.institutionRaw),
    institutionResolutionStatus: resolution?.status ?? null,
    institutionResolutionReason: resolution?.reason ?? null,
    candidateInstitutionIds:
      resolution && resolution.status !== "resolved" ? [...resolution.candidateInstitutionIds] : [],
    institutionId: resolved?.institutionId ?? null,
    standardInstitution: resolved?.standardName ?? null,
    aliasId: resolved?.aliasId ?? null,
    aliasKind: resolved?.aliasKind ?? null,
    categoriesSnapshot: resolved ? [...resolved.categories] : [],
    catalogVersion: catalog.version,
    major: input.major?.trim() || null,
    campusOrCollege: input.campusOrCollege?.trim() || null,
    confidence: resolved?.confidence ?? 0,
    sourceText: input.evidence?.sourceText ?? null,
    sourcePage: input.evidence?.page ?? null,
    artifactRef: input.evidence?.artifactRef ?? null
  };
}

function unresolvedEvidence(
  input: EducationExperienceInput,
  stage: EducationStageResolution,
  catalog: InstitutionCatalog,
  reasons: InstitutionRuleReasonCode[],
  resolution: InstitutionResolution | null = null
): InstitutionRuleEvidence {
  return {
    ...baseEvidence(input, stage, catalog, resolution),
    result: "unknown",
    reasons: uniqueReasons(reasons)
  };
}

function evaluateCategories(
  input: EducationExperienceInput,
  stage: EducationStageResolution,
  resolution: Extract<InstitutionResolution, { status: "resolved" }>,
  institution: Institution,
  catalog: InstitutionCatalog,
  rule: InstitutionCategoryRule
): InstitutionRuleEvidence {
  const matches: boolean[] = [];
  const reasons: InstitutionRuleReasonCode[] = [];
  let hasUnknown = false;

  for (const category of rule.categories) {
    if (!institution.categories.includes(category)) {
      matches.push(false);
      reasons.push("category_not_present");
      continue;
    }
    if (category !== "double_first_class_discipline") {
      matches.push(true);
      reasons.push("category_matched");
      continue;
    }

    const major = input.major?.trim();
    if (!major) {
      matches.push(false);
      hasUnknown = true;
      reasons.push("missing_major_for_discipline");
      continue;
    }
    const normalizedMajor = normalizeDisciplineName(major);
    const disciplines = institution.doubleFirstClassDisciplines ?? [];
    if (disciplines.some((item) => normalizeDisciplineName(item) === normalizedMajor)) {
      matches.push(true);
      reasons.push("discipline_matched");
    } else {
      matches.push(false);
      reasons.push("discipline_not_listed");
    }
  }

  const matched = rule.mode === "any" ? matches.some(Boolean) : matches.every(Boolean);
  const result = matched ? "matched" : hasUnknown ? "unknown" : "not_matched";
  return {
    ...baseEvidence(input, stage, catalog, resolution),
    result,
    reasons: uniqueReasons(reasons)
  };
}

function evaluateExperience(
  input: EducationExperienceInput,
  catalog: InstitutionCatalog,
  rule: InstitutionCategoryRule
): ExperienceState {
  const stage = resolveEducationStage(input);
  const attendanceType = input.attendanceType ?? "formal_degree";
  if (["exchange", "training", "short_course"].includes(attendanceType)) {
    return {
      input,
      stage,
      evidence: {
        ...baseEvidence(input, stage, catalog, null),
        result: "excluded",
        reasons: ["non_formal_education_ignored"]
      }
    };
  }
  if (attendanceType === "unknown") {
    return {
      input,
      stage,
      evidence: unresolvedEvidence(input, stage, catalog, ["unknown_attendance_type"])
    };
  }

  let institutionRaw = input.institutionRaw;
  if (attendanceType === "joint_program") {
    if (!input.awardingInstitutionConfirmed || !input.awardingInstitutionRaw?.trim()) {
      return {
        input,
        stage,
        evidence: unresolvedEvidence(input, stage, catalog, ["unconfirmed_awarding_institution"])
      };
    }
    institutionRaw = input.awardingInstitutionRaw;
  }

  if (stage.status !== "resolved") {
    return {
      input,
      stage,
      evidence: unresolvedEvidence(input, stage, catalog, [
        stage.status === "ambiguous"
          ? "conflicting_education_stage"
          : "unknown_education_stage"
      ])
    };
  }

  const resolution = resolveInstitution(institutionRaw, catalog, {
    ...(input.campusOrCollege ? { campusOrCollege: input.campusOrCollege } : {})
  });
  if (resolution.status !== "resolved") {
    const reason: InstitutionRuleReasonCode =
      resolution.status === "ambiguous"
        ? "ambiguous_institution"
        : resolution.reason === "unverified_campus_or_college"
          ? "unverified_campus_or_college"
          : "unknown_institution";
    return {
      input,
      stage,
      evidence: unresolvedEvidence(input, stage, catalog, [reason], resolution)
    };
  }

  const institution = institutionForResolution(resolution, catalog);
  if (!institution) {
    return {
      input,
      stage,
      evidence: unresolvedEvidence(input, stage, catalog, ["unknown_institution"], resolution)
    };
  }
  return {
    input,
    stage,
    evidence: evaluateCategories(input, stage, resolution, institution, catalog, rule)
  };
}

function resultShell(
  rule: InstitutionCategoryRule,
  decision: InstitutionRuleEvaluation["decision"],
  reasonCodes: InstitutionRuleReasonCode[],
  evidence: InstitutionRuleEvidence[]
): InstitutionRuleEvaluation {
  return {
    ruleType: "institution_category",
    decision,
    required: rule.required,
    catalogVersion: rule.catalogVersion,
    categories: [...rule.categories],
    mode: rule.mode,
    educationStage: rule.educationStage,
    reasonCodes: uniqueReasons(reasonCodes),
    evidence
  };
}

function unknownResult(
  rule: InstitutionCategoryRule,
  reasons: InstitutionRuleReasonCode[],
  evidence: InstitutionRuleEvidence[]
): InstitutionRuleEvaluation {
  const unique = uniqueReasons(reasons);
  if (unique.some((reason) => ALWAYS_MANUAL_REVIEW.has(reason))) {
    return resultShell(rule, "manual_review", [...unique, "unknown_policy_manual_review"], evidence);
  }
  switch (rule.unknownPolicy) {
    case "manual_review":
      return resultShell(rule, "manual_review", [...unique, "unknown_policy_manual_review"], evidence);
    case "fail":
      return resultShell(rule, "not_matched", [...unique, "unknown_policy_fail"], evidence);
    case "ignore":
      return resultShell(rule, "ignored", [...unique, "unknown_policy_ignore"], evidence);
  }
}

function selectEvidence(
  states: ExperienceState[],
  selector: InstitutionCategoryRule["educationStage"]
): InstitutionRuleEvidence[] {
  const included = states.filter((state) => state.evidence.result !== "excluded");
  if (selector === "any" || selector === "all") return included.map((state) => state.evidence);

  if (selector === "highest") {
    const resolved = included.filter(
      (state): state is ExperienceState & { stage: Extract<EducationStageResolution, { status: "resolved" }> } =>
        state.stage.status === "resolved"
    );
    if (resolved.length === 0) return included.map((state) => state.evidence);
    const highestRank = Math.max(...resolved.map((state) => STAGE_RANK[state.stage.stage]));
    const highest = resolved
      .filter((state) => STAGE_RANK[state.stage.stage] === highestRank)
      .map((state) => state.evidence);
    const unresolved = included
      .filter((state) => state.stage.status !== "resolved")
      .map((state) => state.evidence);
    return [...highest, ...unresolved];
  }

  const selected = included
    .filter((state) => state.stage.status === "resolved" && state.stage.stage === selector)
    .map((state) => state.evidence);
  if (selected.length > 0) return selected;
  return included
    .filter((state) => state.stage.status !== "resolved")
    .map((state) => state.evidence);
}

function aggregateSelected(
  rule: InstitutionCategoryRule,
  selected: InstitutionRuleEvidence[],
  allEvidence: InstitutionRuleEvidence[]
): InstitutionRuleEvaluation {
  if (selected.length === 0) {
    return unknownResult(rule, ["no_target_education"], allEvidence);
  }

  const matched = selected.filter((item) => item.result === "matched");
  const notMatched = selected.filter((item) => item.result === "not_matched");
  const unknown = selected.filter((item) => item.result === "unknown");
  const evidenceReasons = selected.flatMap((item) => item.reasons);

  if (rule.educationStage === "any") {
    if (matched.length > 0) return resultShell(rule, "matched", ["category_matched"], allEvidence);
    if (unknown.length > 0) return unknownResult(rule, evidenceReasons, allEvidence);
    return resultShell(rule, "not_matched", ["category_not_present"], allEvidence);
  }

  if (rule.educationStage === "all") {
    if (notMatched.length > 0) {
      return resultShell(rule, "not_matched", ["category_not_present"], allEvidence);
    }
    if (unknown.length > 0) return unknownResult(rule, evidenceReasons, allEvidence);
    return resultShell(rule, "matched", ["category_matched"], allEvidence);
  }

  if (unknown.length > 0) return unknownResult(rule, evidenceReasons, allEvidence);
  if (matched.length > 0 && notMatched.length > 0) {
    return unknownResult(rule, ["conflicting_target_experiences"], allEvidence);
  }
  if (matched.length > 0) return resultShell(rule, "matched", ["category_matched"], allEvidence);
  return resultShell(rule, "not_matched", ["category_not_present"], allEvidence);
}

export function evaluateInstitutionCategoryRule(
  rule: InstitutionCategoryRule,
  experiences: readonly EducationExperienceInput[],
  catalog: InstitutionCatalog
): InstitutionRuleEvaluation {
  const ruleIssues = validateInstitutionCategoryRule(rule);
  if (ruleIssues.length > 0) throw new InstitutionRuleConfigurationError(ruleIssues);

  const catalogValidation = validateInstitutionCatalog(catalog);
  if (!catalogValidation.valid) {
    return unknownResult(rule, ["catalog_validation_failed"], []);
  }
  if (catalog.status !== "published") {
    return unknownResult(rule, ["catalog_not_published"], []);
  }
  if (catalog.version !== rule.catalogVersion) {
    return unknownResult(rule, ["catalog_version_mismatch"], []);
  }

  const states = experiences.map((experience) => evaluateExperience(experience, catalog, rule));
  const allEvidence = states.map((state) => state.evidence);
  const selected = selectEvidence(states, rule.educationStage);
  return aggregateSelected(rule, selected, allEvidence);
}
