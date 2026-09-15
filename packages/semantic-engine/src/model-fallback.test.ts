import { describe, expect, it, vi } from 'vitest';
import { semanticModels, withSemanticModelFallback } from './model-fallback.js';

describe('primary model with one fallback', () => {
  it('keeps order, trims identifiers, and does not retry an identical model', () => {
    expect(semanticModels({BOSS_FORGE_SEMANTIC_MODEL:' gpt-5.6-sol ',BOSS_FORGE_SEMANTIC_FALLBACK_MODEL:'gpt-5.6-luna'})).toEqual(['gpt-5.6-sol','gpt-5.6-luna']);
    expect(semanticModels({BOSS_FORGE_SEMANTIC_MODEL:'gpt-5.6-sol',BOSS_FORGE_SEMANTIC_FALLBACK_MODEL:'gpt-5.6-sol'})).toEqual(['gpt-5.6-sol']);
  });
  it('uses fallback only for a failed attempt, retaining a valid low score', async () => {
    const callback = vi.fn(async () => ({score:0}));
    await expect(withSemanticModelFallback(['sol','luna'],1000,callback)).resolves.toEqual({score:0});
    expect(callback).toHaveBeenCalledTimes(1);
    const fail = vi.fn().mockRejectedValueOnce(new Error('provider error')).mockResolvedValueOnce('luna result');
    await expect(withSemanticModelFallback(['sol','luna'],1000,fail)).resolves.toBe('luna result');
    expect(fail.mock.calls.map(call=>call[0])).toEqual(['sol','luna']);
  });
  it('bounds the primary and preserves the fallback timeout and never loops after both fail', async () => {
    vi.useFakeTimers();
    try {
      const models: string[]=[];
      const pending=withSemanticModelFallback(['sol','luna'],1000,(model,signal)=>new Promise((_resolve,reject)=>{models.push(model);signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})}));
      const rejection=expect(pending).rejects.toThrow('超时');
      await vi.advanceTimersByTimeAsync(1000);expect(models).toEqual(['sol','luna']);
      await vi.advanceTimersByTimeAsync(1000);await rejection;expect(vi.getTimerCount()).toBe(0);
    } finally {vi.useRealTimers()}
  });
});
