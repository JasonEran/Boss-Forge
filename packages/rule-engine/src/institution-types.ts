export const INSTITUTION_CATEGORY_CODES = [
  "project_985",
  "project_211",
  "double_first_class_university",
  "double_first_class_discipline",
  "company_allowlist",
  "company_blocklist",
  "overseas",
  "other_domestic"
] as const;

export type InstitutionCategoryCode = (typeof INSTITUTION_CATEGORY_CODES)[number];

export type InstitutionAliasKind =
  | "abbreviation"
  | "english_name"
  | "former_name"
  | "ocr_variant"
  | "campus_mapping";

export type InstitutionKind =
  | "university"
  | "college"
  | "independent_college"
  | "campus"
  | "research_institute"
  | "other";

export type InstitutionCatalogStatus = "draft" | "validated" | "published" | "retired";

export type InstitutionAlias = {
  id: string;
  value: string;
  kind: InstitutionAliasKind;
  /** A reviewed exact mapping. This is provenance, not an LLM confidence score. */
  confidence?: number;
};

export type Institution = {
  id: string;
  standardName: string;
  countryOrRegion: string;
  kind: InstitutionKind;
  categories: InstitutionCategoryCode[];
  aliases: InstitutionAlias[];
  /** Required when double_first_class_discipline is present. */
  doubleFirstClassDisciplines?: string[];
  validFrom?: string;
  validTo?: string;
};

export type InstitutionCatalogSource = {
  name: string;
  asOfDate: string;
  url?: string;
};

export type InstitutionCatalogDraft = {
  schemaVersion: "1.0";
  version: string;
  status: InstitutionCatalogStatus;
  source: InstitutionCatalogSource;
  importedBy: string;
  reviewedBy: string;
  publishedAt: string;
  changeSummary: string;
  institutions: Institution[];
};

export type InstitutionCatalog = InstitutionCatalogDraft & {
  /** sha256 of the canonical catalog payload, prefixed with `sha256:`. */
  contentHash: string;
};

export type CatalogValidationIssue = {
  severity: "error" | "warning";
  code:
    | "invalid_shape"
    | "invalid_schema_version"
    | "missing_value"
    | "invalid_date"
    | "invalid_status"
    | "invalid_category"
    | "invalid_alias_kind"
    | "invalid_confidence"
    | "duplicate_institution_id"
    | "duplicate_alias_id"
    | "duplicate_alias_value"
    | "ambiguous_alias"
    | "missing_discipline"
    | "unexpected_discipline"
    | "invalid_content_hash"
    | "content_hash_mismatch";
  path: string;
  message: string;
};

export type CatalogValidationResult = {
  valid: boolean;
  errors: CatalogValidationIssue[];
  warnings: CatalogValidationIssue[];
};

export type InstitutionResolutionReason =
  | "exact_standard_name"
  | "exact_reviewed_alias"
  | "blank_institution_name"
  | "self_reported_category_only"
  | "no_exact_catalog_match"
  | "ambiguous_exact_alias"
  | "unverified_campus_or_college";

export type InstitutionResolution =
  | {
      status: "resolved";
      reason: "exact_standard_name" | "exact_reviewed_alias";
      rawName: string;
      normalizedName: string;
      institutionId: string;
      standardName: string;
      aliasId: string | null;
      aliasKind: InstitutionAliasKind | "standard_name";
      confidence: number;
      categories: InstitutionCategoryCode[];
      catalogVersion: string;
    }
  | {
      status: "unknown";
      reason:
        | "blank_institution_name"
        | "self_reported_category_only"
        | "no_exact_catalog_match"
        | "unverified_campus_or_college";
      rawName: string;
      normalizedName: string;
      candidateInstitutionIds: string[];
      confidence: 0;
      catalogVersion: string;
    }
  | {
      status: "ambiguous";
      reason: "ambiguous_exact_alias";
      rawName: string;
      normalizedName: string;
      candidateInstitutionIds: string[];
      confidence: 0;
      catalogVersion: string;
    };

export type EducationStage = "associate" | "bachelor" | "master" | "doctor" | "other";

export type EducationStageSelector = EducationStage | "highest" | "any" | "all";

export type EducationAttendanceType =
  | "formal_degree"
  | "exchange"
  | "training"
  | "short_course"
  | "joint_program"
  | "unknown";

export type EducationExperienceInput = {
  id?: string;
  stage?: EducationStage;
  degree?: string;
  qualification?: string;
  major?: string;
  institutionRaw: string;
  campusOrCollege?: string;
  attendanceType?: EducationAttendanceType;
  /** For joint programs, only a confirmed awarding institution may be evaluated. */
  awardingInstitutionRaw?: string;
  awardingInstitutionConfirmed?: boolean;
  startAt?: string;
  endAt?: string;
  evidence?: {
    sourceText: string;
    page?: number;
    artifactRef?: string;
  };
};

export type EducationStageResolution =
  | {
      status: "resolved";
      stage: EducationStage;
      source: "explicit" | "degree_text";
    }
  | {
      status: "unknown";
      candidates: EducationStage[];
      reason: "missing_stage_evidence";
    }
  | {
      status: "ambiguous";
      candidates: EducationStage[];
      reason: "conflicting_stage_evidence";
    };

export type InstitutionCategoryRule = {
  type: "institution_category";
  educationStage: EducationStageSelector;
  categories: InstitutionCategoryCode[];
  mode: "any" | "all";
  required: boolean;
  catalogVersion: string;
  unknownPolicy: "manual_review" | "fail" | "ignore";
};

export type InstitutionRuleDecision = "matched" | "not_matched" | "manual_review" | "ignored";

export type InstitutionRuleReasonCode =
  | "category_matched"
  | "category_not_present"
  | "discipline_matched"
  | "discipline_not_listed"
  | "missing_major_for_discipline"
  | "no_target_education"
  | "unknown_education_stage"
  | "conflicting_education_stage"
  | "unknown_institution"
  | "ambiguous_institution"
  | "unverified_campus_or_college"
  | "non_formal_education_ignored"
  | "unknown_attendance_type"
  | "unconfirmed_awarding_institution"
  | "conflicting_target_experiences"
  | "catalog_version_mismatch"
  | "catalog_not_published"
  | "catalog_validation_failed"
  | "unknown_policy_manual_review"
  | "unknown_policy_fail"
  | "unknown_policy_ignore";

export type InstitutionRuleEvidence = {
  experienceId: string | null;
  educationStage: EducationStage | null;
  stageStatus: EducationStageResolution["status"];
  institutionRaw: string;
  evaluatedInstitutionRaw: string;
  normalizedInstitution: string;
  institutionResolutionStatus: InstitutionResolution["status"] | null;
  institutionResolutionReason: InstitutionResolutionReason | null;
  candidateInstitutionIds: string[];
  institutionId: string | null;
  standardInstitution: string | null;
  aliasId: string | null;
  aliasKind: InstitutionAliasKind | "standard_name" | null;
  categoriesSnapshot: InstitutionCategoryCode[];
  catalogVersion: string;
  major: string | null;
  campusOrCollege: string | null;
  confidence: number;
  result: "matched" | "not_matched" | "unknown" | "excluded";
  reasons: InstitutionRuleReasonCode[];
  sourceText: string | null;
  sourcePage: number | null;
  artifactRef: string | null;
};

export type InstitutionRuleEvaluation = {
  ruleType: "institution_category";
  decision: InstitutionRuleDecision;
  required: boolean;
  catalogVersion: string;
  categories: InstitutionCategoryCode[];
  mode: "any" | "all";
  educationStage: EducationStageSelector;
  reasonCodes: InstitutionRuleReasonCode[];
  evidence: InstitutionRuleEvidence[];
};
