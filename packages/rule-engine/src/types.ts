export type CapabilityDecision = "matched" | "not_matched" | "ambiguous" | "insufficient";

export type CapabilityReasonCode =
  | "confirmed_alias"
  | "negative_context"
  | "planned_or_in_progress"
  | "subjective_proficiency"
  | "conflicting_evidence"
  | "confusable_credential"
  | "no_evidence";

export type CapabilityEvidenceStatus = "positive" | "negative" | "ambiguous";

export type CapabilityEvidence = {
  sourceText: string;
  normalizedAlias: string;
  status: CapabilityEvidenceStatus;
  confidence: number;
};

export type CapabilityEvaluation = {
  capabilityId: string;
  canonicalLabel: string;
  dictionaryVersion: string;
  decision: CapabilityDecision;
  confidence: number;
  reasonCodes: CapabilityReasonCode[];
  evidence: CapabilityEvidence[];
};
