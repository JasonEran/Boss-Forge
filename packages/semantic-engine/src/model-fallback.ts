/** The configured primary is always tried first; a valid result never triggers fallback. */
export function semanticModels(environment: { BOSS_FORGE_SEMANTIC_MODEL?: string | undefined; BOSS_FORGE_SEMANTIC_FALLBACK_MODEL?: string | undefined }): string[] {
  return [...new Set([environment.BOSS_FORGE_SEMANTIC_MODEL, environment.BOSS_FORGE_SEMANTIC_FALLBACK_MODEL].map(value => value?.trim()).filter((value): value is string => Boolean(value)))];
}
export function chatModelParameters(model: string, maxTokens = 3000) {
  return /^gpt-(?:5|6)(?:[.-]|$)/i.test(model)
    ? { reasoning_effort: 'low', max_completion_tokens: maxTokens }
    : { temperature: 0 };
}
export async function withSemanticModelFallback<T>(models: string[], timeoutMs: number, operation: (model: string, signal: AbortSignal) => Promise<T>): Promise<T> {
  if (!models.length) throw new Error('AI 模型尚未配置。');
  // Preserve the existing model timeout for the fallback. With a fallback,
  // cap the primary at 90s: even the maximum 180s fallback finishes within
  // 270s, before the recruitment worker's existing five-minute claim expires.
  let lastError: unknown;
  for (const [index, model] of models.entries()) {
    const perAttemptMs = models.length > 1 && index === 0 ? Math.min(timeoutMs, 90_000) : timeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), perAttemptMs);
    try {
      return await operation(model, controller.signal);
    } catch (error) {
      lastError = controller.signal.aborted ? new Error('AI 分析超时，已保存简历，可以重试，无需重新采集。') : error;
    } finally { clearTimeout(timeout); }
  }
  throw lastError;
}
