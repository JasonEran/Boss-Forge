export * from "./types.js";

import type {
  SemanticEvaluation,
  SemanticJsonValue,
  SemanticProvider,
  SemanticProviderInput,
  SemanticRule,
  SemanticRuntimeMode
} from "./types.js";

export const SEMANTIC_PROMPT_VERSION = "semantic-prompt-1.0";
export const SEMANTIC_CATALOG_VERSION = "semantic-catalog-1.0";

const MAX_CANDIDATE_TEXT = 60_000;
const MAX_EVIDENCE_ITEMS = 8;
const MAX_EVIDENCE_LENGTH = 1_500;

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: JsonObject, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${path} contains unsupported field(s): ${unknown.sort().join(", ")}.`);
  }
}

function requiredString(value: unknown, path: string, maximum = 500): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  const parsed = value.trim();
  if (parsed.length > maximum) throw new Error(`${path} exceeds ${maximum} characters.`);
  return parsed;
}

function optionalString(value: unknown, path: string, maximum = 500): string | null {
  if (value === null) return null;
  return requiredString(value, path, maximum);
}

function stringArray(
  value: unknown,
  path: string,
  maximumItems: number,
  maximumLength: number
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`${path} must be an array with at most ${maximumItems} items.`);
  }
  return value.map((item, index) =>
    requiredString(item, `${path}[${index}]`, maximumLength)
  );
}

function confidence(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${path} must be between 0 and 1.`);
  }
  return value;
}

function safeJsonValue(value: unknown, path: string): SemanticJsonValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || encoded.length > 10_000) {
    throw new Error(`${path} is not a bounded JSON value.`);
  }
  return JSON.parse(encoded) as SemanticJsonValue;
}

function serializedJsonValue(value: unknown, path: string): SemanticJsonValue {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 10_000) {
    throw new Error(`${path} must be a JSON string or null.`);
  }
  try {
    return safeJsonValue(JSON.parse(value), path);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${path} must contain valid JSON.`);
    }
    throw error;
  }
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\u00a0\u2000-\u200d\u202f\u205f\u3000]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function evidenceSnippet(text: string, alias: string): string {
  const normalizedText = normalizeText(text);
  const normalizedAlias = normalizeText(alias);
  const index = normalizedText.indexOf(normalizedAlias);
  if (index < 0 || text.length <= 500) return text.slice(0, 500);
  const start = Math.max(0, index - 180);
  const end = Math.min(text.length, index + alias.length + 220);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${
    end < text.length ? "..." : ""
  }`;
}

function containsAlias(text: string, alias: string): boolean {
  const source = normalizeText(text);
  const needle = normalizeText(alias);
  if (!needle) return false;
  const asciiToken = /^[a-z0-9.+#-]+$/iu.test(needle);
  let index = source.indexOf(needle);
  while (index >= 0) {
    const beforeCharacter = source[index - 1] ?? "";
    const afterCharacter = source[index + needle.length] ?? "";
    const tokenBoundary =
      !asciiToken ||
      (!/[a-z0-9]/iu.test(beforeCharacter) && !/[a-z0-9]/iu.test(afterCharacter));
    const before = source.slice(Math.max(0, index - 18), index);
    const after = source.slice(index + needle.length, index + needle.length + 12);
    const riskyContext =
      /(?:未|没有|无|不具备|不熟悉|不会|缺乏|仅了解|正在学习|学习中|备考|计划|目标|希望)[^。；，,\n]{0,8}$/u.test(
        before
      ) ||
      /^(?:[^。；，,\n]{0,6})?(?:未通过|未取得|不足|欠缺|学习中|备考中)/u.test(
        after
      );
    if (tokenBoundary && !riskyContext) return true;
    index = source.indexOf(needle, index + needle.length);
  }
  return false;
}

function unknownEvaluation(
  rule: SemanticRule,
  runtimeMode: SemanticRuntimeMode,
  reasonCodes: string[]
): SemanticEvaluation {
  return {
    criterionId: rule.criterionId,
    factType: rule.factType,
    executionMode: rule.executionMode,
    result: "unknown",
    normalizedValue: null,
    qualifier: null,
    evidence: [],
    confidence: 0,
    extractor: "none",
    modelVersion: null,
    promptVersion: SEMANTIC_PROMPT_VERSION,
    catalogVersion: SEMANTIC_CATALOG_VERSION,
    rubricVersion:
      rule.executionMode === "semantic_rubric" ? `${rule.criterionId}:1` : null,
    runtimeMode,
    reasonCodes
  };
}

export function evaluateAliases(
  rule: SemanticRule,
  candidateText: string,
  runtimeMode: SemanticRuntimeMode
): SemanticEvaluation | null {
  if (rule.executionMode !== "normalized_entity") return null;
  const expected = rule.expectedValues ?? [];
  if (expected.length === 0) return null;
  const matched = expected.flatMap((canonical) => {
    const candidates = unique([canonical, ...(rule.aliases?.[canonical] ?? [])]);
    const alias = candidates.find((value) => containsAlias(candidateText, value));
    return alias ? [{ canonical, alias }] : [];
  });
  const satisfied =
    (rule.valueMode ?? "any") === "all"
      ? matched.length === expected.length
      : matched.length > 0;
  if (!satisfied) return null;
  return {
    criterionId: rule.criterionId,
    factType: rule.factType,
    executionMode: rule.executionMode,
    result: "matched",
    normalizedValue: matched.map((item) => item.canonical),
    qualifier: "confirmed",
    evidence: matched.map((item) => evidenceSnippet(candidateText, item.alias)),
    confidence: 1,
    extractor: "alias",
    modelVersion: null,
    promptVersion: SEMANTIC_PROMPT_VERSION,
    catalogVersion: SEMANTIC_CATALOG_VERSION,
    rubricVersion: null,
    runtimeMode,
    reasonCodes: [
      "semantic_alias_matched",
      `semantic_value_mode_${rule.valueMode ?? "any"}`
    ]
  };
}

export function parseSemanticModelResponse(
  value: unknown,
  rules: readonly SemanticRule[],
  modelVersion: string,
  runtimeMode: SemanticRuntimeMode,
  candidateText?: string
): SemanticEvaluation[] {
  if (!isRecord(value)) throw new Error("semantic response must be an object.");
  exactKeys(value, ["evaluations"], "semantic response");
  if (!Array.isArray(value.evaluations)) {
    throw new Error("semantic response.evaluations must be an array.");
  }
  if (value.evaluations.length !== rules.length) {
    throw new Error("semantic response must contain exactly one result per requested criterion.");
  }
  const byId = new Map(rules.map((rule) => [rule.criterionId, rule]));
  const seen = new Set<string>();
  const source = candidateText ? normalizeText(candidateText) : null;
  const parsed = value.evaluations.map((item, index) => {
    const path = `semantic response.evaluations[${index}]`;
    if (!isRecord(item)) throw new Error(`${path} must be an object.`);
    exactKeys(
      item,
      [
        "criterionId",
        "result",
        "normalizedValue",
        "qualifier",
        "evidence",
        "confidence",
        "reasonCodes"
      ],
      path
    );
    const criterionId = requiredString(item.criterionId, `${path}.criterionId`, 100);
    const rule = byId.get(criterionId);
    if (!rule) throw new Error(`${path}.criterionId is not requested.`);
    if (seen.has(criterionId)) throw new Error(`${path}.criterionId is duplicated.`);
    seen.add(criterionId);
    if (
      item.result !== "matched" &&
      item.result !== "not_matched" &&
      item.result !== "unknown"
    ) {
      throw new Error(`${path}.result must be matched, not_matched, or unknown.`);
    }
    const evidence = stringArray(
      item.evidence,
      `${path}.evidence`,
      MAX_EVIDENCE_ITEMS,
      MAX_EVIDENCE_LENGTH
    );
    const parsedConfidence = confidence(item.confidence, `${path}.confidence`);
    const reasons = stringArray(item.reasonCodes, `${path}.reasonCodes`, 20, 100);
    const missingEvidence = item.result !== "unknown" && evidence.length === 0;
    const unverifiableEvidence =
      item.result !== "unknown" &&
      source !== null &&
      evidence.some((snippet) => !source.includes(normalizeText(snippet)));
    const forcedUnknown = missingEvidence || unverifiableEvidence;
    return {
      criterionId,
      factType: rule.factType,
      executionMode: rule.executionMode,
      result: forcedUnknown ? "unknown" : item.result,
      normalizedValue: serializedJsonValue(
        item.normalizedValue,
        `${path}.normalizedValue`
      ),
      qualifier: optionalString(item.qualifier, `${path}.qualifier`, 100),
      evidence,
      confidence: forcedUnknown ? 0 : parsedConfidence,
      extractor: "llm",
      modelVersion,
      promptVersion: SEMANTIC_PROMPT_VERSION,
      catalogVersion: SEMANTIC_CATALOG_VERSION,
      rubricVersion:
        rule.executionMode === "semantic_rubric" ? `${rule.criterionId}:1` : null,
      runtimeMode,
      reasonCodes: unique([
        ...reasons,
        ...(missingEvidence ? ["semantic_evidence_required"] : []),
        ...(unverifiableEvidence ? ["semantic_evidence_not_in_source"] : [])
      ])
    } satisfies SemanticEvaluation;
  });
  if (seen.size !== rules.length) {
    throw new Error("semantic response is missing a requested criterion.");
  }
  return parsed;
}

function responseSchema(rules: readonly SemanticRule[]): JsonObject {
  return {
    name: "boss_forge_semantic_evaluations",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["evaluations"],
      properties: {
        evaluations: {
          type: "array",
          minItems: rules.length,
          maxItems: rules.length,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "criterionId",
              "result",
              "normalizedValue",
              "qualifier",
              "evidence",
              "confidence",
              "reasonCodes"
            ],
            properties: {
              criterionId: {
                type: "string",
                enum: rules.map((rule) => rule.criterionId)
              },
              result: {
                type: "string",
                enum: ["matched", "not_matched", "unknown"]
              },
              normalizedValue: {
                type: ["string", "null"],
                maxLength: 10_000
              },
              qualifier: { type: ["string", "null"] },
              evidence: {
                type: "array",
                maxItems: MAX_EVIDENCE_ITEMS,
                items: { type: "string", maxLength: MAX_EVIDENCE_LENGTH }
              },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              reasonCodes: {
                type: "array",
                maxItems: 20,
                items: { type: "string", maxLength: 100 }
              }
            }
          }
        }
      }
    }
  };
}

export class OpenAiCompatibleSemanticProvider implements SemanticProvider {
  readonly modelVersion: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(input: {
    baseUrl: string;
    apiKey?: string | null | undefined;
    model: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  }) {
    this.baseUrl = input.baseUrl.replace(/\/+$/u, "");
    this.apiKey = input.apiKey?.trim() || null;
    this.modelVersion = requiredString(input.model, "semantic model", 200);
    this.timeoutMs = input.timeoutMs ?? 45_000;
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  async evaluate(input: SemanticProviderInput): Promise<SemanticEvaluation[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {})
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.modelVersion,
          temperature: 0,
          messages: [
            {
              role: "system",
              content:
                "你是简历事实提取器。只依据原文逐项判断，不推断敏感属性，不生成录用建议。matched/not_matched 必须引用原文；无法确认返回 unknown。normalizedValue 必须是序列化后的 JSON 字符串，未知时返回 null。"
            },
            {
              role: "user",
              content: JSON.stringify({
                promptVersion: SEMANTIC_PROMPT_VERSION,
                criteria: input.rules.map((rule) => ({
                  criterionId: rule.criterionId,
                  label: rule.label,
                  executionMode: rule.executionMode,
                  factType: rule.factType,
                  expectedValues: rule.expectedValues ?? [],
                  valueMode: rule.valueMode ?? "any",
                  rubric: rule.rubric ?? null
                })),
                candidateText: input.candidateText.slice(0, MAX_CANDIDATE_TEXT)
              })
            }
          ],
          response_format: {
            type: "json_schema",
            json_schema: responseSchema(input.rules)
          }
        })
      });
      if (!response.ok) {
        throw new Error(`Semantic model returned HTTP ${response.status}.`);
      }
      const body: unknown = await response.json();
      if (!isRecord(body) || !Array.isArray(body.choices)) {
        throw new Error("Semantic model response is missing choices.");
      }
      const choice = body.choices[0];
      if (
        !isRecord(choice) ||
        !isRecord(choice.message) ||
        typeof choice.message.content !== "string"
      ) {
        throw new Error("Semantic model response is missing message content.");
      }
      return parseSemanticModelResponse(
        JSON.parse(choice.message.content),
        input.rules,
        this.modelVersion,
        "active",
        input.candidateText
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function semanticRuntimeMode(
  environment: NodeJS.ProcessEnv = process.env
): SemanticRuntimeMode {
  return environment.BOSS_FORGE_SEMANTIC_MODE?.trim().toLowerCase() === "active"
    ? "active"
    : "shadow";
}

export function semanticProviderFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): SemanticProvider | null {
  const enabled = !["0", "false", "no", "off"].includes(
    (environment.BOSS_FORGE_SEMANTIC_ENABLED ?? "0").trim().toLowerCase()
  );
  if (!enabled) return null;
  const baseUrl = environment.BOSS_FORGE_SEMANTIC_BASE_URL?.trim();
  const model = environment.BOSS_FORGE_SEMANTIC_MODEL?.trim();
  if (!baseUrl || !model) {
    throw new Error(
      "Semantic model requires BOSS_FORGE_SEMANTIC_BASE_URL and BOSS_FORGE_SEMANTIC_MODEL."
    );
  }
  const timeout = Number(environment.BOSS_FORGE_SEMANTIC_TIMEOUT_MS ?? "45000");
  if (!Number.isFinite(timeout) || timeout < 1_000 || timeout > 180_000) {
    throw new Error(
      "BOSS_FORGE_SEMANTIC_TIMEOUT_MS must be between 1000 and 180000."
    );
  }
  return new OpenAiCompatibleSemanticProvider({
    baseUrl,
    apiKey: environment.BOSS_FORGE_SEMANTIC_API_KEY,
    model,
    timeoutMs: timeout,
    fetchImpl
  });
}

export async function evaluateSemanticRules(input: {
  candidateText: string;
  rules: SemanticRule[];
  provider?: SemanticProvider | null;
  runtimeMode?: SemanticRuntimeMode;
}): Promise<SemanticEvaluation[]> {
  const runtimeMode = input.runtimeMode ?? "shadow";
  const deterministic = new Map<string, SemanticEvaluation>();
  const unresolved: SemanticRule[] = [];
  for (const rule of input.rules) {
    const result = evaluateAliases(rule, input.candidateText, runtimeMode);
    if (result) deterministic.set(rule.criterionId, result);
    else unresolved.push(rule);
  }

  let modelResults: SemanticEvaluation[] = [];
  if (unresolved.length > 0 && input.provider) {
    try {
      modelResults = await input.provider.evaluate({
        candidateText: input.candidateText,
        rules: unresolved
      });
      modelResults = modelResults.map((item) => ({ ...item, runtimeMode }));
    } catch {
      modelResults = unresolved.map((rule) =>
        unknownEvaluation(rule, runtimeMode, ["semantic_model_error"])
      );
    }
  }
  const modelById = new Map(modelResults.map((item) => [item.criterionId, item]));
  return input.rules.map(
    (rule) =>
      deterministic.get(rule.criterionId) ??
      modelById.get(rule.criterionId) ??
      unknownEvaluation(rule, runtimeMode, [
        input.provider ? "semantic_model_missing_result" : "semantic_model_unavailable"
      ])
  );
}
