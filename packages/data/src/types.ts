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

export type RuleConfig = {
  requiredCapabilities: Array<{
    capability: "tem8";
    minimumConfidence: number;
  }>;
};

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
  | "waiting_review"
  | "completed"
  | "failed"
  | "cancelled";

export type Task = {
  id: string;
  idempotencyKey: string;
  positionId: string;
  positionName: string;
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
  reasonCodes: string[];
  evidence: Array<{
    sourceText: string;
    normalizedAlias: string;
    status: "positive" | "negative" | "ambiguous";
    confidence: number;
  }>;
};

export type DashboardCandidate = {
  stateId: string;
  candidateId: string;
  name: string;
  positionName: string;
  ruleDecision: CandidateEvaluationRecord["decision"];
  ruleConfidence: number;
  reviewStatus: "pending" | "approved" | "rejected" | "not_required";
  contactStatus: "not_contacted" | "queued" | "sent" | "failed" | "uncertain";
  stateVersion: number;
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
  matchEvidence: MatchEvidenceRecord[];
  reviews: ReviewRecord[];
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
  | "failed"
  | "uncertain"
  | "cancelled";

export type ContactIntent = {
  id: string;
  candidateStateId: string;
  candidateName: string;
  positionName: string;
  renderedMessage: string;
  status: ContactIntentStatus;
  createdBy: string;
  createdAt: string;
  lastError: string | null;
};

export type ContactDispatchJob = ContactIntent & {
  outboxEventId: string;
  taskId: string;
  bossJobKeyword: string | null;
  candidateTarget: string;
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
  tasks: Task[];
  candidates: DashboardCandidate[];
  schedules?: Schedule[];
  contactIntents?: ContactIntent[];
  auditLogs?: AuditLog[];
};
