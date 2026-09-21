import type {
  CandidateSourceLocator,
  ContactActionKind,
  ParsedCandidate
} from "@boss-forge/contracts";
import type { InstitutionCatalog, InstitutionCategoryRule } from "@boss-forge/rule-engine";
import type { SemanticEvaluation, SemanticRule } from "@boss-forge/semantic-engine";

export type Position = {
  id: string;
  bossAccountId: string;
  name: string;
  bossJobKeyword: string | null;
  bossJobId?: string | null;
  bossJobNameUnique?: boolean;
  bossJobStatus?: string | null;
  bossSyncedAt?: string | null;
  status: "active" | "paused" | "closed";
  ownerName: string;
  semanticMode: "off" | "shadow" | "active";
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type LegacyRuleConfig = {
  requiredCapabilities: Array<{
    capability: "tem8";
    minimumConfidence: number;
  }>;
};

export type Tem8RuleNode = {
  type: "tem8";
  minimumConfidence: number;
  /** Defaults to manual_review for snapshots created before generic rules existed. */
  unknownPolicy?: UnknownPolicy;
};

export type UnknownPolicy = "manual_review" | "fail" | "ignore";

/** Compatibility with the generic capability leaf used by versioned rule configs. */
export type Tem8CapabilityRuleNode = {
  type: "capability";
  capability: "tem8";
  match: "confirmed";
  minimumConfidence?: number;
  unknownPolicy: UnknownPolicy;
};

export type EnglishCredentialCode = "tem8" | "cet6";

/** One understandable certificate condition; `any` means TEM8 OR CET6. */
export type EnglishCredentialRuleNode = {
  type: "english_credential";
  accepted: EnglishCredentialCode[];
  mode: "any" | "all";
  minimumConfidence: number;
  unknownPolicy: UnknownPolicy;
};

export type RangeRuleNode = {
  type: "range";
  field: "yearsOfExperience" | "age" | "graduationYear";
  minimum?: number;
  maximum?: number;
  unknownPolicy: UnknownPolicy;
};

export type KeywordRuleNode = {
  type: "keyword";
  /** `all` searches the complete candidate card and OCR text. */
  field: string | "all";
  values: string[];
  mode: "any" | "all";
  unknownPolicy: UnknownPolicy;
};

export type EnumRuleNode = {
  type: "enum";
  field: string;
  values: string[];
  mode: "any" | "all";
  match: "exact" | "contains";
  unknownPolicy: UnknownPolicy;
};

export type TextRuleNode = {
  type: "text";
  field: string | "all";
  value: string;
  match: "exact" | "contains";
  unknownPolicy: UnknownPolicy;
};

export type EducationLevel = "high_school" | "associate" | "bachelor" | "master" | "doctor";

export type EducationLevelRuleNode = {
  type: "education_level";
  minimum: EducationLevel;
  unknownPolicy: UnknownPolicy;
};

export type GraduateStatusCode = "current_or_upcoming_graduate" | "experienced";

/**
 * Explicit HR-facing graduate requirement.  This is intentionally separate
 * from graduationYear: "是否应届" is a business status, not a year-range hack.
 */
export type GraduateStatusRuleNode = {
  type: "graduate_status";
  values: GraduateStatusCode[];
  mode: "any";
  unknownPolicy: UnknownPolicy;
};

export type RuleGroupNode =
  | {
      operator: "AND" | "OR" | "NOT";
      children: RuleNode[];
    }
  | {
      type: "all" | "any";
      children: RuleNode[];
    };

export type RuleNode =
  | RuleGroupNode
  | Tem8RuleNode
  | Tem8CapabilityRuleNode
  | EnglishCredentialRuleNode
  | RangeRuleNode
  | KeywordRuleNode
  | EnumRuleNode
  | TextRuleNode
  | EducationLevelRuleNode
  | GraduateStatusRuleNode
  | InstitutionCategoryRule
  | SemanticRule;

export type CompositeRuleConfig = {
  recruitment?: import("@boss-forge/contracts").RecruitmentConfig;
  schemaVersion: "1.0" | "1.1";
  name?: string;
  root: RuleGroupNode;
  /** BOSS owns profile filters; the rule tree contains supplemental resume checks only. */
  screeningFlow?: "boss_then_resume";
  /** Official BOSS recommendation prefilter; absent configs use automatic qualification mapping. */
  bossRecommendationFilters?: import("@boss-forge/contracts").BossRecommendationFilterConfig;
  /** Immutable, published and content-hash-verified snapshot used by institution leaves. */
  institutionCatalog?: InstitutionCatalog;
};

export type RuleConfig = LegacyRuleConfig | CompositeRuleConfig;

export type RuleVersion = {
  id: string;
  ruleSetId: string;
  version: number;
  config: RuleConfig;
  dictionaryVersion: string;
  createdBy: string;
  createdAt: string;
};

export type TaskStatus =
  | "queued"
  | "running"
  | "screening"
  | "waiting_review"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskWaitReasonCode =
  | "outside_working_hours"
  | "daily_hard_limit_reached"
  | "hourly_quota_reached"
  | "daily_quota_reached"
  | "batch_break"
  | "resume_retry_scheduled"
  | "screening_pool_exhausted"
  | "greet_target_met";

export type Task = {
  id: string;
  idempotencyKey: string;
  positionId: string;
  positionName: string;
  bossAccountId: string;
  bossJobKeyword: string | null;
  bossJobId?: string | null;
  bossJobNameUnique?: boolean;
  ruleVersionId: string;
  ruleVersion: number;
  dictionaryVersion: string;
  ruleConfig: RuleConfig;
  sourceBossFilters?: import("@boss-forge/contracts").BossRecommendationFilterPlan | null;
  executionMode: "immediate" | "scheduled";
  source: "recommend" | "search";
  searchKeyword: string | null;
  status: TaskStatus;
  createdBy: string;
  candidateCount: number;
  candidateLimit?: number;
  /** When true, auto-greet matched passers after each screening chunk. */
  autoGreet?: boolean;
  newCandidateCount: number;
  repeatCandidateCount: number;
  errorMessage: string | null;
  waitReasonCode: TaskWaitReasonCode | null;
  waitReason: string | null;
  nextRunAt: string | null;
  nextAction: string;
  version: number;
  /** Opaque worker lease. Mutating a claimed task requires the current token. */
  claimToken: string | null;
  createdAt: string;
};

export type CandidateEvaluationRecord = {
  salaryScreening?: import("@boss-forge/contracts").SalaryScreening;
  sourceReference: string;
  sourceLocator?: CandidateSourceLocator;
  source: "recommend" | "search" | "deep-search";
  displayName: string;
  fingerprint: string;
  rawFields: Record<string, string>;
  sourceEvidence: string[];
  rawText: string;
  decision: "matched" | "not_matched" | "ambiguous" | "insufficient";
  confidence: number;
  capabilityId: string;
  canonicalLabel: string;
  dictionaryVersion: string;
  currentEnglishLevel: string | null;
  reasonCodes: string[];
  institutionDecision?: "matched" | "not_matched" | "unknown";
  institutionSummary?: string;
  institutionCatalogVersion?: string;
  education?: CandidateEducationEvidence[];
  semanticEvaluations?: SemanticEvaluation[];
  evidence: Array<{
    sourceText: string;
    normalizedAlias: string;
    status: "positive" | "negative" | "ambiguous";
    confidence: number;
    /** Composite rules can persist the identity and reasons of each individual leaf. */
    capabilityId?: string;
    canonicalLabel?: string;
    dictionaryVersion?: string;
    reasonCodes?: string[];
  }>;
};

export type CandidateEducationEvidence = {
  stage: "college" | "bachelor" | "master" | "doctor" | "other";
  institutionRaw: string;
  degree?: string;
  major?: string;
  campusOrCollege?: string;
  startAt?: string;
  endAt?: string;
  categorySnapshot: string[];
  confidence: number;
  evidenceText?: string;
  artifactReference?: string;
};

export type ResumeScreeningStatus =
  | "not_requested"
  | "queued"
  | "processing"
  | "screened"
  | "no_text"
  | "failed";

export type ResumeScreeningErrorCode =
  | "content_incomplete"
  | "content_empty"
  | "source_expired"
  | "target_missing"
  | "target_changed"
  | "target_ambiguous"
  | "preview_not_opened"
  | "risk_control"
  | "ocr_failed"
  | "historical_result_needs_recheck"
  | "worker_error";

export type SemanticEvaluationSummary = {
  mode: "off" | "shadow" | "active" | null;
  total: number;
  matched: number;
  notMatched: number;
  unknown: number;
  modelError: boolean;
};

export type DashboardCandidate = {
  assessment?: import("@boss-forge/contracts").CandidateAssessmentView | null;
  salaryScreening?: import("@boss-forge/contracts").SalaryScreening | null;
  stateId: string;
  candidateId: string;
  taskId: string;
  positionId: string;
  name: string;
  positionName: string;
  ruleDecision: CandidateEvaluationRecord["decision"];
  ruleConfidence: number;
  reviewStatus: "pending" | "approved" | "rejected" | "not_required";
  contactStatus: "not_contacted" | "queued" | "sent" | "simulated" | "failed" | "uncertain";
  stateVersion: number;
  resumeScreeningStatus: ResumeScreeningStatus;
  currentEnglishLevel: string | null;
  resumeScreenedAt: string | null;
  resumeScreeningError: string | null;
  resumeScreeningErrorCode: ResumeScreeningErrorCode | null;
  resumeScreeningNextAttemptAt: string | null;
  isRepeat: boolean;
  isCurrent: boolean;
  firstSeenAt: string;
  nextAction: string;
  failedRuleLabels: string[];
  missingRuleLabels: string[];
  semanticSummary: SemanticEvaluationSummary;
  evidence: string[];
  fields: Record<string, string>;
  updatedAt: string;
};

export type ReviewRecord = {
  id: string;
  decision: "approved" | "rejected";
  note: string;
  correctionCode: string | null;
  reviewerId: string;
  previousStatus: DashboardCandidate["reviewStatus"];
  resultingVersion: number;
  createdAt: string;
};

export type MatchEvidenceRecord = {
  capabilityId: string;
  canonicalLabel: string;
  dictionaryVersion: string;
  sourceText: string;
  normalizedAlias: string;
  status: "positive" | "negative" | "ambiguous";
  confidence: number;
  reasonCodes: string[];
};

export type CandidateDetail = DashboardCandidate & {
  rawText: string;
  source: string;
  collectedAt: string;
  ruleVersion: number;
  dictionaryVersion: string;
  resumeScreenshotAvailable: boolean;
  matchEvidence: MatchEvidenceRecord[];
  semanticEvaluations: SemanticEvaluation[];
  reviews: ReviewRecord[];
};

export type ResumeScreeningJob = {
  stateId: string;
  candidateId: string;
  taskId: string;
  ruleVersionId: string;
  candidateName: string;
  bossAccountId: string;
  bossJobKeyword: string | null;
  bossJobId?: string | null;
  bossJobNameUnique?: boolean;
  source: "recommend" | "search";
  searchKeyword: string | null;
  ruleConfig: RuleConfig;
  sourceBossFilters?: import("@boss-forge/contracts").BossRecommendationFilterPlan | null;
  semanticMode: "off" | "shadow" | "active";
  semanticCatalogVersionId: string | null;
  semanticCatalogEntries: unknown;
  resumeScreeningAttempts: number;
  candidate: {
    index: number;
    name: string;
    source: "recommend" | "search";
    sourceLocator?: CandidateSourceLocator;
    fields: Record<string, string>;
    evidence: string[];
    raw: string;
  };
};

export type ScheduleFrequency = "once" | "daily" | "weekdays" | "weekly";

export type Schedule = {
  candidateLimit?: number;
  /** When true, materialized tasks auto-greet matched passers after each chunk. */
  autoGreet?: boolean;
  id: string;
  positionId: string;
  positionName: string;
  source: "recommend" | "search";
  searchKeyword: string | null;
  frequency: ScheduleFrequency;
  timezone: string;
  nextRunAt: string;
  enabled: boolean;
  createdBy: string;
  version: number;
  createdAt: string;
};

export type MessagePreview = {
  templateVersionId: string;
  templateVersion: number;
  body: string;
  renderedMessage: string;
  candidateStateId: string;
  candidateId: string;
  candidateName: string;
  candidateFingerprint: string;
  positionId: string;
  positionName: string;
  taskId: string;
  bossAccountId: string;
  bossJobKeyword: string | null;
  source: "recommend" | "search";
  sourceReference: string;
  sourceLocator: CandidateSourceLocator | null;
  reviewStatus: DashboardCandidate["reviewStatus"];
  contactStatus: DashboardCandidate["contactStatus"];
};

export type ContactIntentStatus =
  | "ready"
  | "processing"
  | "sent"
  | "simulated"
  | "failed"
  | "uncertain"
  | "cancelled";

export type ContactAttemptStatus =
  | "processing"
  | "deferred"
  | "sent"
  | "simulated"
  | "failed"
  | "uncertain";

export type ContactDispatchResult = Exclude<ContactAttemptStatus, "processing" | "deferred">;

export type ContactIntent = {
  id: string;
  actionKind: ContactActionKind;
  candidateStateId: string;
  candidateId: string;
  /** Immutable screening task that authorized this contact preview/intent. */
  taskId: string;
  candidateName: string;
  positionName: string;
  bossAccountId: string;
  templateVersionId: string | null;
  providerJobId: string | null;
  providerGreetingId: string | null;
  renderedMessage: string;
  renderedMessageSha256: string;
  sourceLocatorSha256: string | null;
  transportMode: "fake" | "real";
  status: ContactIntentStatus;
  createdBy: string;
  version: number;
  createdAt: string;
  lastError: string | null;
};

export type ContactDispatchJob = ContactIntent & {
  outboxEventId: string;
  taskId: string;
  bossAccountId: string;
  bossJobKeyword: string | null;
  bossJobId?: string | null;
  bossJobNameUnique?: boolean;
  sourceBossFilters?: import("@boss-forge/contracts").BossRecommendationFilterPlan | null;
  candidateTarget: string;
  candidateFingerprint: string;
  candidateSnapshot: ParsedCandidate;
  sourceReference: string;
  source: "recommend" | "search";
  searchKeyword: string | null;
  authorizationId: string | null;
  contactPolicyVersionId: string | null;
  odooDatabaseUuid: string | null;
  odooJobId: number | null;
  odooApplicantId: number | null;
  attemptNo: number;
};

export type AuditLog = {
  id: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  createdAt: string;
};

export type DashboardSnapshot = {
  metrics: {
    totalCandidates: number;
    matchedCandidates: number;
    pendingReview: number;
    contactedToday: number;
  };
  positions: Position[];
  activeRules: Array<{
    positionId: string;
    id: string;
    version: number;
    config: RuleConfig;
    dictionaryVersion: string;
    createdAt: string;
  }>;
  latestRules: Array<{
    positionId: string;
    id: string;
    version: number;
    status: "draft" | "pending_approval" | "published" | "retired";
    active: boolean;
    config: RuleConfig;
    dictionaryVersion: string;
    createdAt: string;
  }>;
  tasks: Task[];
  candidates: DashboardCandidate[];
  schedules?: Schedule[];
  contactIntents?: ContactIntent[];
  auditLogs?: AuditLog[];
};
