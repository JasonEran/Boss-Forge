import { chatModelParameters, semanticModels, withSemanticModelFallback } from '@boss-forge/semantic-engine';
type SynonymEnvironment = Partial<Pick<
  NodeJS.ProcessEnv,
  | 'BOSS_FORGE_SEMANTIC_ENABLED'
  | 'BOSS_FORGE_SEMANTIC_BASE_URL'
  | 'BOSS_FORGE_SEMANTIC_MODEL'
  | 'BOSS_FORGE_SEMANTIC_FALLBACK_MODEL'
  | 'BOSS_FORGE_SEMANTIC_API_KEY'
  | 'BOSS_FORGE_SEMANTIC_TIMEOUT_MS'
>>;

type JsonRecord = Record<string, unknown>;

export class SynonymModelUnavailableError extends Error {
  constructor() {
    super('大语言模型尚未配置，暂时不能生成同义词。请联系系统管理员完成模型配置。');
    this.name = 'SynonymModelUnavailableError';
  }
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function requiredText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters.`);
  return normalized;
}

function explicitlyEnabled(value: string | undefined): boolean {
  return ['1', 'true'].includes((value ?? '0').trim().toLowerCase());
}

function secureBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SynonymModelUnavailableError();
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new SynonymModelUnavailableError();
  }
  return parsed.toString().replace(/\/+$/u, '');
}

export async function generateSynonyms(input: {
  term: string;
  positionName?: string | null;
  criterionLabel?: string | null;
}, environment: SynonymEnvironment = process.env, fetchImpl: typeof fetch = fetch): Promise<{
  term: string;
  aliases: string[];
  model: string;
}> {
  const enabled = explicitlyEnabled(environment.BOSS_FORGE_SEMANTIC_ENABLED);
  const baseUrl = environment.BOSS_FORGE_SEMANTIC_BASE_URL?.trim();
  const model = environment.BOSS_FORGE_SEMANTIC_MODEL?.trim();
  const apiKey = environment.BOSS_FORGE_SEMANTIC_API_KEY?.trim();
  if (!enabled || !baseUrl || !model || !apiKey) {
    throw new SynonymModelUnavailableError();
  }
  const safeBaseUrl = secureBaseUrl(baseUrl);

  const timeoutMs = Number(environment.BOSS_FORGE_SEMANTIC_TIMEOUT_MS ?? '45000');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 180_000) {
    throw new Error('BOSS_FORGE_SEMANTIC_TIMEOUT_MS must be between 1000 and 180000.');
  }

  const term = requiredText(input.term, 'term', 120);
  const positionName = input.positionName?.trim().slice(0, 120) || null;
  const criterionLabel = input.criterionLabel?.trim().slice(0, 200) || null;
  return withSemanticModelFallback(semanticModels(environment), timeoutMs, async (model, signal) => {
    const response = await fetchImpl(`${safeBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      signal,
      body: JSON.stringify({
        model,
        ...chatModelParameters(model, 1500),
        messages: [
          {
            role: 'system',
            content:
              '你是招聘规则词典助手。只生成与目标词语义等价、可在中文简历中直接出现的简称、全称、中英文写法和常见书写变体。不要生成上下位概念、相关技能、推断结论或歧视性条件。',
          },
          {
            role: 'user',
            content: JSON.stringify({
              task: '为招聘筛选目标词生成同义词候选，最多 12 个',
              term,
              positionName,
              criterionLabel,
            }),
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'boss_forge_synonyms',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['aliases'],
              properties: {
                aliases: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 12,
                  items: { type: 'string', minLength: 1, maxLength: 80 },
                },
              },
            },
          },
        },
      }),
    });
    if (!response.ok) throw new Error(`大语言模型请求失败（HTTP ${response.status}）。`);
    const body = record(await response.json());
    const choices = Array.isArray(body?.choices) ? body.choices : [];
    const choice = record(choices[0]);
    const message = record(choice?.message);
    if (typeof message?.content !== 'string') throw new Error('大语言模型没有返回可用的同义词。');
    const content = record(JSON.parse(message.content));
    const rawAliases = Array.isArray(content?.aliases) ? content.aliases : [];
    const seen = new Set([term.toLocaleLowerCase()]);
    const aliases = rawAliases
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => {
        if (!value || value.length > 80) return false;
        const key = value.toLocaleLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 12);
    if (aliases.length === 0) throw new Error('大语言模型没有生成可应用的同义词。');
    return { term, aliases, model };
  });
}
