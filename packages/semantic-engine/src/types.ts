export type SemanticExecutionMode = "normalized_entity" | "semantic_rubric";
export type SemanticResult = "matched" | "not_matched" | "unknown";
export type SemanticRuntimeMode = "off" | "shadow" | "active";
export type SemanticJsonValue =
  | null
  | boolean
  | number
  | string
  | SemanticJsonValue[]
  | { [key: string]: SemanticJsonValue };

export type SemanticRule = {
  type: "semantic";
  criterionId: string;
  label: string;
  executionMode: SemanticExecutionMode;
  factType: string;
  expectedValues?: string[];
  aliases?: Record<string, string[]>;
  valueMode?: "any" | "all";
  rubric?: string;
  minimumConfidence: number;
  unknownPolicy: "manual_review" | "fail" | "ignore";
};

export type SemanticEvaluation = {
  criterionId: string;
  factType: string;
  executionMode: SemanticExecutionMode;
  result: SemanticResult;
  normalizedValue: SemanticJsonValue;
  qualifier: string | null;
  evidence: string[];
  confidence: number;
  extractor: "alias" | "llm" | "none";
  modelVersion: string | null;
  promptVersion: string;
  catalogVersion: string;
  rubricVersion: string | null;
  runtimeMode: SemanticRuntimeMode;
  reasonCodes: string[];
};

export type SemanticProviderInput = {
  candidateText: string;
  rules: SemanticRule[];
};

export interface SemanticProvider {
  readonly modelVersion: string;
  evaluate(input: SemanticProviderInput): Promise<SemanticEvaluation[]>;
}
