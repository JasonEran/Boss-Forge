import { describe, expect, it } from 'vitest';
import { bossFilterValuesSchema } from '@boss-forge/contracts';
import { resolveBossMajors, type BossMajorCatalog } from './boss-major-catalog.js';

const catalog: BossMajorCatalog = { jobId: 'job', majors: [
  { code: 1, name: '英语', category: '语言类' },
  { code: 2, name: '新闻传播类', category: '文史哲类' },
], configured: [{ code: 2, name: '新闻传播学类' }] };
describe('native major selection', () => {
  it('resolves both catalog and configured names by native ID', () => {
    expect(resolveBossMajors(catalog, ['英语', '新闻传播学类']).map(item => item.code)).toEqual([1, 2]);
  });
  it('resolves verified old names even after a different rule replaces the shortcuts', () => {
    expect(resolveBossMajors({ ...catalog, configured: [] }, ['新闻传播学类'])[0]?.code).toBe(2);
  });
  it('rejects unknown, ambiguous or duplicate-alias majors before changing native choices', () => {
    expect(() => resolveBossMajors(catalog, ['不存在的专业'])).toThrow('未找到');
    expect(() => resolveBossMajors(catalog, ['新闻传播类', '新闻传播学类'])).toThrow('新旧名称');
    expect(() => resolveBossMajors({ ...catalog, configured: [{ code: 3, name: '英语' }] }, ['英语'])).toThrow('未找到');
  });
  it('enforces BOSS’s five-major limit at both saved-rule and browser boundaries', () => {
    const major = Array.from({ length: 6 }, (_, index) => `专业${index}`);
    expect(bossFilterValuesSchema.safeParse({ major }).success).toBe(false);
    expect(() => resolveBossMajors(catalog, major)).toThrow('最多选择 5');
    expect(bossFilterValuesSchema.safeParse({ major: major.slice(0, 5), keyword1: Array.from({ length: 12 }, (_, index) => `关键词${index}`) }).success).toBe(true);
  });
});
