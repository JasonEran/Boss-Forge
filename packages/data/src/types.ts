import type { ParsedCandidate } from "@boss-forge/contracts";
import type { InstitutionCatalog, InstitutionCategoryRule } from "@boss-forge/rule-engine";
import type { SemanticEvaluation, SemanticRule } from "@boss-forge/semantic-engine";

export type Position = {
  id: string;
  bossAccountId: string;
  name: string;
  bossJobKeyword: string | null;
  status: "active" | "paused" | "closed";
  ownerName: string;
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

export type RangeRuleNode = {
  type: "range";
  field: "yearsOfExperience";
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
  | RangeRuleNode
  | KeywordRuleNode
  | EnumRuleNode
  | TextRuleNode
  | EducationLevelRuleNode
  | InstitutionCategoryRule
  | SemanticRule;

export type CompositeRuleConfig = {
  schemaVersion: "1.0" | "1.1";
  name?: string;
  root: RuleGroupNode;
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

export type Task = {
  id: string;
  idempotencyKey: string;
  positionId: string;
  positionName: string;
  bossAccountId: string;
  bossJobKeyword: string | null;
  ruleVersionId: string;
  ruleConfig: RuleConfig;
  executionMode: "immediate" | "scheduled";
  source: "recommend" | "search";
  searchKeyword: string | null;
  status: TaskStatus;
  createdBy: string;
  candidateCount: number;
  errorMessage: string | null;
  /** Opaque worker lease. Mutating a claimed task requires the current token. */
  claimToken: string | null;
  createdAt: string;
};

export type CandidateEvaluationRecord = {
  sourceReference: string;
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

export type DashboardCandidate = {
  stateId: string;
  candidateId: string;
  positionId: string;
  name: string;
  positionName: string;
  ruleDecision: CandidateEvaluationRecord["decision"];
  ruleConfidence: number;
  reviewStatus: "pending" | "approved" | "rejected" | "not_required";
  contactStatus:
    | "not_contacted"
    | "queued"
    | "sent"
    | "simulated"
    | "failed"
    | "uncertain";
  stateVersion: number;
  resumeScreeningStatus: ResumeScreeningStatus;
  currentEnglishLevel: string | null;
  resumeScreenedAt: string | null;
  resumeScreeningError: string | null;
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
  taskId: string;
  ruleVersionId: string;
  candidateName: string;
  bossAccountId: string;
  bossJobKeyword: string | null;
  source: "recommend" | "search";
  searchKeyword: string | null;
  ruleConfig: RuleConfig;
  candidate: {
    index: number;
    name: string;
    source: "recommend" | "search";
    fields: Record<string, string>;
    evidence: string[];
    raw: string;
  };
};

export type ScheduleFrequency = "once" | "daily" | "weekdays" | "weekly";

export type Schedule = {
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
  candidateStateId: string;
  candidateName: string;
  positionName: string;
  renderedMessage: string;
  transportMode: "fake" | "real";
  status: ContactIntentStatus;
  createdBy: string;
  createdAt: string;
  lastError: string | null;
};

export type ContactDispatchJob = ContactIntent & {
  outboxEventId: string;
  taskId: string;
  bossAccountId: string;
  bossJobKeyword: string | null;
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
  tasks: Task[];
  candidates: DashboardCandidate[];
  schedules?: Schedule[];
  contactIntents?: ContactIntent[];
  auditLogs?: AuditLog[];
};
