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

export type DetectedEnglishLevel = {
  code: "tem8" | "tem4" | "cet6" | "cet4" | "ielts" | "toefl" | "bec";
  label: string;
  sourceText: string;
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
  detectedEnglishLevels: DetectedEnglishLevel[];
};
