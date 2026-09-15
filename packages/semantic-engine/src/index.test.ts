import { describe, expect, it } from "vitest";
import {
  OpenAiCompatibleSemanticProvider,
  applySemanticCatalogEntries,
  evaluateAliases,
  evaluateSemanticRules,
  parseSemanticModelResponse,
  semanticProviderFromEnvironment,
  semanticProviderReadinessFromEnvironment,
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

  it("accepts harmless quote wrappers around an otherwise exact source excerpt", () => {
    const result = parseSemanticModelResponse(
      {
        evaluations: [
          {
            criterionId: rubricRule.criterionId,
            result: "matched",
            normalizedValue: '{"market":"overseas"}',
            qualifier: "confirmed",
            evidence: ["“高效响应海外客户多样化需求”"],
            confidence: 0.93,
            reasonCodes: ["explicit_overseas_customer_experience"]
          }
        ]
      },
      [rubricRule],
      "local-model-v1",
      "active",
      "负责外宾接待，高效响应海外客户多样化需求。"
    )[0]!;
    expect(result.result).toBe("matched");
    expect(result.confidence).toBe(0.93);
    expect(result.reasonCodes).not.toContain("semantic_evidence_not_in_source");
  });

  it("calls an OpenAI-compatible endpoint with a strict schema", async () => {
    let requestBody: Record<string, unknown> | null = null;
    let authorization: string | null = null;
    const provider = new OpenAiCompatibleSemanticProvider({
      baseUrl: "https://semantic-model.internal/v1/",
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

  it("fails a provider error closed to an unknown shadow result", async () => {
    const provider: SemanticProvider = {
      modelVersion: "fake-model",
      async evaluate() {
        throw new Error("provider unavailable");
      }
    };
    const result = (await evaluateSemanticRules({
      candidateText: "负责12人研发团队的排期、绩效和交付",
      rules: [rubricRule],
      provider,
      runtimeMode: "shadow"
    }))[0]!;
    expect(result).toMatchObject({
      result: "unknown",
      runtimeMode: "shadow",
      confidence: 0,
      reasonCodes: ["semantic_model_error"]
    });
  });

  it("uses the position catalog version and skips extraction when the position is off", async () => {
    const result = (await evaluateSemanticRules({
      candidateText: "熟练 Java 后端开发",
      rules: [entityRule],
      runtimeMode: "off",
      catalogVersion: "catalog-position-v3"
    }))[0]!;
    expect(result).toMatchObject({
      result: "unknown",
      runtimeMode: "off",
      catalogVersion: "catalog-position-v3",
      reasonCodes: ["semantic_mode_off"]
    });
  });

  it("merges published catalog aliases into matching position rules", () => {
    const [rule] = applySemanticCatalogEntries([entityRule], [
      { canonical: "Java", aliases: ["JVM 开发", "爪哇"] },
      { canonical: "Python", aliases: ["Py"] }
    ]);
    expect(rule?.aliases?.Java).toEqual([
      "J2EE",
      "Java 后端",
      "JVM 开发",
      "爪哇"
    ]);
    expect(evaluateAliases(rule!, "负责 JVM 开发平台", "active")?.result).toBe(
      "matched"
    );
  });

  it("requires an explicit enable flag and a complete secure configuration", () => {
    expect(semanticProviderFromEnvironment({ BOSS_FORGE_SEMANTIC_ENABLED: "0" })).toBeNull();
    expect(semanticProviderFromEnvironment({ BOSS_FORGE_SEMANTIC_ENABLED: "yes" })).toBeNull();
    expect(
      semanticProviderFromEnvironment({
        BOSS_FORGE_SEMANTIC_ENABLED: "1",
        BOSS_FORGE_SEMANTIC_BASE_URL: "https://semantic-model.internal/v1",
        BOSS_FORGE_SEMANTIC_MODEL: "semantic-test-v1"
      })
    ).toBeNull();
    const missingCredential = semanticProviderReadinessFromEnvironment({
      BOSS_FORGE_SEMANTIC_ENABLED: "1",
      BOSS_FORGE_SEMANTIC_BASE_URL: "https://semantic-model.internal/v1",
      BOSS_FORGE_SEMANTIC_MODEL: "semantic-test-v1"
    });
    expect(missingCredential).toEqual({
      enabled: true,
      ready: false,
      reason: "missing_credential",
      endpointHost: "semantic-model.internal",
      model: "semantic-test-v1",
      credentialConfigured: false,
      timeoutMs: 45000
    });
    expect(JSON.stringify(missingCredential)).not.toContain("/v1");
    expect(
      semanticProviderReadinessFromEnvironment({
        BOSS_FORGE_SEMANTIC_ENABLED: "1",
        BOSS_FORGE_SEMANTIC_BASE_URL: "http://semantic-model.internal/v1",
        BOSS_FORGE_SEMANTIC_MODEL: "semantic-test-v1",
        BOSS_FORGE_SEMANTIC_API_KEY: "rotated-test-key"
      }).reason
    ).toBe("invalid_endpoint");
    expect(
      semanticProviderFromEnvironment({
        BOSS_FORGE_SEMANTIC_ENABLED: "true",
        BOSS_FORGE_SEMANTIC_BASE_URL: "https://semantic-model.internal/v1",
        BOSS_FORGE_SEMANTIC_MODEL: "semantic-test-v1",
        BOSS_FORGE_SEMANTIC_API_KEY: "rotated-test-key"
      })
    ).not.toBeNull();
  });
});
