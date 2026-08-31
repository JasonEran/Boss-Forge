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
  evidence: string[];
  fields: Record<string, string>;
  updatedAt: string;
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
};
