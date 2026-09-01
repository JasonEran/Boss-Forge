import { describe, expect, it } from "vitest";
import {
  OpenAiCompatibleSemanticProvider,
  evaluateAliases,
  evaluateSemanticRules,
  parseSemanticModelResponse,
  semanticProviderFromEnvironment,
  semanticRuntimeMode,
  type SemanticProvider,
  type SemanticRule
} from "./index.js";

const entityRule: SemanticRule = {
  type: "semantic",
  criterionId: "semantic.skill.java",
  label: "具备 Java 后端能力",
  executionMode: "normalized_entity",
  factType: "skill",
  expectedValues: ["Java"],
  aliases: { Java: ["J2EE", "Java 后端"] },
  valueMode: "any",
  minimumConfidence: 0.8,
  unknownPolicy: "manual_review"
};

const rubricRule: SemanticRule = {
  type: "semantic",
  criterionId: "semantic.management",
  label: "具有团队管理经验",
  executionMode: "semantic_rubric",
  factType: "team_management",
  rubric: "只有明确负责团队排期、绩效或交付才符合。",
  minimumConfidence: 0.8,
  unknownPolicy: "manual_review"
};

describe("semantic engine", () => {
  it("normalizes configured aliases without a model", () => {
    const result = evaluateAliases(
      entityRule,
      "技术栈：Spring Boot、J2EE、MySQL",
      "shadow"
    );
    expect(result).toMatchObject({
      result: "matched",
      normalizedValue: ["Java"],
      extractor: "alias",
      confidence: 1
    });
    expect(result?.evidence[0]).toContain("J2EE");
  });

  it("does not turn negated or aspirational aliases into positive facts", () => {
    expect(evaluateAliases(entityRule, "不具备 Java 开发经验", "active")).toBeNull();
    expect(evaluateAliases(entityRule, "正在学习 J2EE", "active")).toBeNull();
    expect(evaluateAliases(entityRule, "熟练 Java 后端开发", "active")?.result).toBe(
      "matched"
    );
  });

  it("fails closed to unknown when no provider is configured", async () => {
    const result = (await evaluateSemanticRules({
      candidateText: "负责产品需求分析。",
      rules: [rubricRule],
      provider: null,
      runtimeMode: "shadow"
    }))[0]!;
    expect(result).toMatchObject({
      result: "unknown",
      extractor: "none",
      reasonCodes: ["semantic_model_unavailable"]
    });
  });

  it("forces unsupported or missing evidence back to unknown", () => {
    const result = parseSemanticModelResponse(
      {
        evaluations: [
          {
            criterionId: rubricRule.criterionId,
            result: "matched",
            normalizedValue: '{"teamSize":12}',
            qualifier: "led",
            evidence: ["负责20人团队"],
            confidence: 0.95,
            reasonCodes: ["model_matched"]
          }
        ]
      },
      [rubricRule],
      "local-model-v1",
      "active",
      "负责12人研发团队的排期、绩效和交付"
    )[0]!;
    expect(result.result).toBe("unknown");
    expect(result.normalizedValue).toEqual({ teamSize: 12 });
    expect(result.reasonCodes).toContain("semantic_evidence_not_in_source");
  });

  it("calls an OpenAI-compatible endpoint with a strict schema", async () => {
    let requestBody: Record<string, unknown> | null = null;
    let authorization: string | null = null;
    const provider = new OpenAiCompatibleSemanticProvider({
      baseUrl: "http://semantic-model.internal/v1/",
      apiKey: "test-key",
      model: "semantic-test-v1",
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        authorization = new Headers(init?.headers).get("authorization");
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    evaluations: [
                      {
                        criterionId: rubricRule.criterionId,
                        result: "matched",
                        normalizedValue: '{"teamSize":12}',
                        qualifier: "led",
                        evidence: ["负责12人研发团队的排期、绩效和交付"],
                        confidence: 0.96,
                        reasonCodes: ["model_matched"]
                      }
                    ]
                  })
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    });

    const result = await provider.evaluate({
      candidateText: "负责12人研发团队的排期、绩效和交付",
      rules: [rubricRule]
    });

    expect(authorization).toBe("Bearer test-key");
    expect(requestBody).toMatchObject({
      model: "semantic-test-v1",
      temperature: 0,
      response_format: { type: "json_schema", json_schema: { strict: true } }
    });
    expect(result[0]).toMatchObject({
      result: "matched",
      normalizedValue: { teamSize: 12 },
      modelVersion: "semantic-test-v1"
    });
  });

  it("preserves shadow mode for model results", async () => {
    const provider: SemanticProvider = {
      modelVersion: "fake-model",
      async evaluate() {
        return [
          {
            criterionId: rubricRule.criterionId,
            factType: rubricRule.factType,
            executionMode: rubricRule.executionMode,
            result: "matched",
            normalizedValue: { teamSize: 12 },
            qualifier: "led",
            evidence: ["负责12人研发团队的排期、绩效和交付"],
            confidence: 0.96,
            extractor: "llm",
            modelVersion: "fake-model",
            promptVersion: "semantic-prompt-1.0",
            catalogVersion: "semantic-catalog-1.0",
            rubricVersion: "semantic.management:1",
            runtimeMode: "active",
            reasonCodes: ["model_matched"]
          }
        ];
      }
    };
    const result = (await evaluateSemanticRules({
      candidateText: "负责12人研发团队的排期、绩效和交付",
      rules: [rubricRule],
      provider,
      runtimeMode: "shadow"
    }))[0]!;
    expect(result.runtimeMode).toBe("shadow");
    expect(result.result).toBe("matched");
  });

  it("defaults runtime to shadow and requires endpoint/model when enabled", () => {
    expect(semanticRuntimeMode({})).toBe("shadow");
    expect(semanticProviderFromEnvironment({ BOSS_FORGE_SEMANTIC_ENABLED: "0" })).toBeNull();
    expect(() =>
      semanticProviderFromEnvironment({ BOSS_FORGE_SEMANTIC_ENABLED: "1" })
    ).toThrow(/BASE_URL/u);
  });
});
