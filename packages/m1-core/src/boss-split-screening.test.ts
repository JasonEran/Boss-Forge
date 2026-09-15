import { describe, expect, it } from 'vitest';
import { planBossRecommendationFilters, type ParsedCandidate } from '@boss-forge/contracts';
import { parseRuleConfig, assertRuleScreeningSource } from '@boss-forge/data';
import { evaluateCandidate } from './index.js';

const card: ParsedCandidate = { index: 1, source: 'recommend', name: '测试候选人', fields: {}, evidence: [], raw: '' };
const certificate = { type: 'english_credential', accepted: ['tem8'], mode: 'any', minimumConfidence: 0.85, unknownPolicy: 'manual_review' };
const input = (children: unknown[] = []) => ({ schemaVersion: '1.1', screeningFlow: 'boss_then_resume', bossRecommendationFilters: { mode: 'custom', fields: { degree: ['本科'], experience: ['3-5年'] } }, root: { operator: 'AND', children } });

describe('BOSS official filters followed by supplementary résumé rules', () => {
  it('accepts official-only filtering without requiring duplicate profile evidence', () => {
    const rule = parseRuleConfig(input());
    const result = evaluateCandidate(card, rule, '工作经历与个人优势', [], planBossRecommendationFilters(rule));
    expect(result.decision).toBe('matched');
    expect(result.evidence.map(item => item.capabilityId)).toEqual(['boss.official_filters']);
  });
  it('does not apply official filtering retroactively to an unverified or different list', () => {
    const rule = parseRuleConfig(input());
    expect(evaluateCandidate(card, rule).decision).toBe('insufficient');
    expect(evaluateCandidate(card, rule, '', [], { version: 1, mode: 'custom', fields: { degree: ['硕士'] } }).decision).toBe('insufficient');
    expect(evaluateCandidate({ ...card, source: 'search' }, rule, '', [], planBossRecommendationFilters(rule)).decision).toBe('insufficient');
  });
  it('verifies the complete native plan, including ranges and new VIP fields', () => {
    const rule = parseRuleConfig({...input(), bossRecommendationFilters:{mode:'custom',fields:{age:['22','35'],salary:['5-10K'],intention:['离职-随时到岗']}}});
    const applied = planBossRecommendationFilters(rule);
    expect(evaluateCandidate(card, rule, '完整简历', [], applied).decision).toBe('matched');
    expect(evaluateCandidate(card, rule, '完整简历', [], {...applied, fields:{...applied.fields,age:['22','不限']}}).decision).toBe('insufficient');
    expect(evaluateCandidate(card, rule, '完整简历', [], {...applied, fields:{age:['22','35']}}).decision).toBe('insufficient');
  });
  it('only checks the supplementary certificate and preserves missing / negative evidence', () => {
    const rule = parseRuleConfig(input([certificate]));
    const plan = planBossRecommendationFilters(rule);
    expect(evaluateCandidate(card, rule, '已通过英语专业八级', [], plan).decision).toBe('matched');
    const missing = evaluateCandidate(card, rule, '大学英语六级', [], plan);
    expect(missing.decision).toBe('not_matched');
    expect(missing.reasonCodes).toContain('required_resume_evidence_missing');
    expect(evaluateCandidate(card, rule, '', [], plan).decision).toBe('insufficient');
    expect(evaluateCandidate(card, rule, '专八未通过', [], plan).decision).toBe('not_matched');
  });
  it('does not let an OR supplementary rule bypass official filtering', () => {
    const raw = input([certificate]); raw.root.operator = 'OR';
    expect(evaluateCandidate(card, parseRuleConfig(raw), '已通过英语专业八级').decision).toBe('insufficient');
  });
  it('rejects duplicate education, experience and school tags in the supplementary step', () => {
    for (const leaf of [
      { type: 'education_level', minimum: 'bachelor', unknownPolicy: 'manual_review' },
      { type: 'range', field: 'yearsOfExperience', minimum: 3, unknownPolicy: 'manual_review' },
      { type: 'enum', field: 'bossPlatformTags', values: ['985'], mode: 'any', match: 'exact', unknownPolicy: 'manual_review' }
    ]) expect(() => parseRuleConfig(input([leaf]))).toThrow(/BOSS/);
  });
  it('rejects an entirely empty rule and an empty nested group', () => {
    const empty = input(); empty.bossRecommendationFilters.fields = {} as typeof empty.bossRecommendationFilters.fields;
    expect(() => parseRuleConfig(empty)).toThrow();
    expect(() => parseRuleConfig(input([{ operator: 'AND', children: [] }]))).toThrow();
  });
  it('requires a bound recommendation job while keeping legacy search rules usable', () => {
    expect(() => assertRuleScreeningSource(input(), 'search', 'job')).toThrow(/推荐牛人/);
    expect(() => assertRuleScreeningSource(input(), 'recommend', null)).toThrow(/BOSS/);
    expect(() => assertRuleScreeningSource(input(), 'recommend', 'job')).not.toThrow();
    expect(() => assertRuleScreeningSource({}, 'search', null)).not.toThrow();
  });
  it('keeps legacy education checks unchanged', () => {
    const rule = parseRuleConfig({ schemaVersion: '1.0', root: { operator: 'AND', children: [{ type: 'education_level', minimum: 'bachelor', unknownPolicy: 'manual_review' }] } });
    expect(evaluateCandidate(card, rule, '', [], { version: 1, mode: 'custom', fields: { degree: ['本科'] } }).decision).toBe('insufficient');
  });
});
