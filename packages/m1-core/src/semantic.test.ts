import type { ParsedCandidate } from "@boss-forge/contracts";
import type { RuleConfig } from "@boss-forge/data";
import type { SemanticEvaluation } from "@boss-forge/semantic-engine";
import { describe, expect, it } from "vitest";
import { collectSemanticRules, evaluateCandidate } from "./index.js";

const candidate: ParsedCandidate = {
  index: 1,
  name: "候选人甲",
  source: "recommend",
  fields: { 技能: "Java 后端", 经验: "5年" },
  evidence: [],
  raw: "负责12人研发团队的排期、绩效和交付"
};

const config: RuleConfig = {
  schemaVersion: "1.1",
  name: "研发负责人",
  root: {
    operator: "AND",
    children: [
      {
        type: "semantic",
        criterionId: "semantic.management",
        label: "具有团队管理经验",
        executionMode: "semantic_rubric",
        factType: "team_management",
        rubric: "明确负责团队排期、绩效或交付才符合。",
        minimumConfidence: 0.8,
        unknownPolicy: "manual_review"
      }
    ]
  }
};

function evaluation(runtimeMode: "shadow" | "active"): SemanticEvaluation {
  return {
    criterionId: "semantic.management",
    factType: "team_management",
    executionMode: "semantic_rubric",
    result: "matched",
    normalizedValue: { teamSize: 12 },
    qualifier: "led",
    evidence: ["负责12人研发团队的排期、绩效和交付"],
    confidence: 0.96,
    extractor: "llm",
    modelVersion: "local-model-v1",
    promptVersion: "semantic-prompt-1.0",
    catalogVersion: "semantic-catalog-1.0",
    rubricVersion: "semantic.management:1",
    runtimeMode,
    reasonCodes: ["model_matched"]
  };
}

describe("semantic composite evaluation", () => {
  it("collects semantic leaves from nested rules", () => {
    expect(collectSemanticRules(config)).toHaveLength(1);
  });

  it("allows an active high-confidence result to satisfy the rule", () => {
    const result = evaluateCandidate(candidate, config, null, [evaluation("active")]);
    expect(result.decision).toBe("matched");
    expect(result.semanticEvaluations).toHaveLength(1);
    expect(result.evidence[0]?.canonicalLabel).toBe("具有团队管理经验");
  });

  it("keeps model output in manual review while shadowing", () => {
    const result = evaluateCandidate(candidate, config, null, [evaluation("shadow")]);
    expect(result.decision).toBe("insufficient");
    expect(result.reasonCodes).toContain("semantic_shadow_mode");
  });

  it("fails closed when no semantic evaluation is available", () => {
    const result = evaluateCandidate(candidate, config);
    expect(result.decision).toBe("insufficient");
    expect(result.reasonCodes).toContain("semantic_evaluation_missing");
  });
});
