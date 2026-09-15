import { describe, expect, it, vi } from 'vitest';
import { collectRecommendationBatches, type RecommendationBatch } from './boss-recommendation-collection.js';

const cards = (from: number, to: number) => Array.from({ length: to - from }, (_, n) => ({ geekId: `person-${from + n}` }));
function fixture(pages: RecommendationBatch<{ geekId: string }>[]) {
  let index = 0;
  return { read: vi.fn(async () => pages[index]!), advance: vi.fn(async () => { index++; }) };
}
describe('continuous recommendation collection', () => {
  it('fills the requested limit across pages and never admits the excess', async () => {
    const f = fixture([{ cards: cards(0, 15), ended: false, pageNumber: 1 }, { cards: cards(0, 30), ended: false, pageNumber: 2 }]);
    const result = await collectRecommendationBatches({ ...f, limit: 20 });
    expect(result).toEqual({ cards: cards(0, 20), stopReason: 'limit', loadedPages: 1 });
    expect(f.advance).toHaveBeenCalledOnce();
  });
  it('does not scroll at all when the existing list already meets a small limit', async () => {
    const f = fixture([{ cards: cards(0, 30), ended: false, pageNumber: 1 }]);
    expect((await collectRecommendationBatches({ ...f, limit: 1 })).cards).toEqual(cards(0, 1));
    expect(f.advance).not.toHaveBeenCalled();
  });
  it('deduplicates overlapping pages while retaining different people with the same name', async () => {
    const sameName = (from: number, to: number) => cards(from, to).map(c => ({ ...c, name: '同名候选人' }));
    const f = fixture([{ cards: sameName(0, 10), ended: false, pageNumber: 1 }, { cards: sameName(5, 15), ended: false, pageNumber: 2 }, { cards: sameName(10, 25), ended: false, pageNumber: 3 }]);
    const result = await collectRecommendationBatches({ ...f, limit: 20 });
    expect(result.cards).toHaveLength(20);
    expect(new Set(result.cards.map(c => c.geekId)).size).toBe(20);
    expect(f.advance).toHaveBeenCalledTimes(2);
  });
  it.each([0, 13, 18])('stops at a confirmed exhausted pool of %i even below the limit', async count => {
    const f = fixture([{ cards: cards(0, count), ended: true, pageNumber: 2 }]);
    expect(await collectRecommendationBatches({ ...f, limit: 20 })).toMatchObject({ cards: cards(0, count), stopReason: 'exhausted' });
    expect(f.advance).not.toHaveBeenCalled();
  });
  it('continues after a short or duplicate page instead of treating it as exhausted', async () => {
    const f = fixture([{ cards: cards(0, 3), ended: false, pageNumber: 1 }, { cards: cards(0, 3), ended: false, pageNumber: 2 }, { cards: cards(0, 10), ended: false, pageNumber: 3 }]);
    expect((await collectRecommendationBatches({ ...f, limit: 10 })).cards).toHaveLength(10);
    expect(f.advance).toHaveBeenCalledTimes(2);
  });
  it('reports repeated no-progress pages as an error, never as successful exhaustion', async () => {
    const f = fixture(Array.from({ length: 4 }, (_, i) => ({ cards: cards(0, 3), ended: false, pageNumber: i + 1 })));
    await expect(collectRecommendationBatches({ ...f, limit: 20 })).rejects.toThrow('BOSS_RECOMMEND_STALLED');
    expect(f.advance).toHaveBeenCalledTimes(3);
  });
  it('propagates loading failures without reporting a partial collection as complete', async () => {
    await expect(collectRecommendationBatches({ limit: 20, read: async () => ({ cards: cards(0, 3), ended: false, pageNumber: 1 }), advance: async () => { throw new Error('BOSS risk response'); } })).rejects.toThrow('BOSS risk response');
  });
  it('stops after cancellation before any further page load', async () => {
    let active = true;
    const f = fixture([{ cards: cards(0, 15), ended: false, pageNumber: 1 }, { cards: cards(0, 30), ended: false, pageNumber: 2 }]);
    const advance = vi.fn(async () => { await f.advance(); active = false; });
    await expect(collectRecommendationBatches({ ...f, advance, limit: 50, assertActive: async () => { if (!active) throw new Error('Task cancelled'); } })).rejects.toThrow('Task cancelled');
    expect(advance).toHaveBeenCalledOnce();
    expect(f.read).toHaveBeenCalledOnce();
  });
  it('supports 200 people and rejects invalid limits before reading the browser', async () => {
    const f = fixture(Array.from({ length: 14 }, (_, i) => ({ cards: cards(i * 15, (i + 1) * 15), ended: false, pageNumber: i + 1 })));
    expect((await collectRecommendationBatches({ ...f, limit: 200 })).cards).toHaveLength(200);
    const invalid = fixture([]);
    await expect(collectRecommendationBatches({ ...invalid, limit: 201 })).rejects.toThrow('1–200');
    expect(invalid.read).not.toHaveBeenCalled();
  });
});
