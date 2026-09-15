import { describe, expect, it } from 'vitest';
import type { ParsedCandidate } from '@boss-forge/contracts';
import type { RuleConfig } from '@boss-forge/data';
import { evaluateCandidate } from './index.js';

const card: ParsedCandidate = { index: 1, source: 'recommend', name: '回归样本', fields: { 学历: '本科', 毕业年份: '2025' }, evidence: [], raw: '候选人卡片' };
function config(accepted: string[] = ['tem8'], mode = 'any', policy = 'manual_review'): RuleConfig {
  return { schemaVersion: '1.1', name: '证书核验', root: { operator: 'AND', children: [
    { type: 'english_credential', accepted, mode, minimumConfidence: 0.85, unknownPolicy: policy },
    { type: 'education_level', minimum: 'bachelor', unknownPolicy: 'manual_review' },
    { type: 'range', field: 'graduationYear', maximum: 2026, unknownPolicy: 'manual_review' },
    { type: 'enum', field: 'gender', values: ['女'], mode: 'any', match: 'exact', unknownPolicy: 'manual_review' },
  ] } } as RuleConfig;
}

describe('production screening regression', () => {
  it.each(['CET-4', 'CET-6，雅思 8.0', '英语专业四级'])('does not reject TEM8 eligibility solely because the resume lists %s', text => {
    const result = evaluateCandidate(card, config(), text);
    expect(result.decision).toBe('insufficient');
    expect(result.evidence.find(item => item.capabilityId === 'language.english.credentials')?.status).toBe('ambiguous');
  });
  it('passes proven job qualifications even when the legacy gender condition has no value', () => {
    const result = evaluateCandidate(card, config(), '2025 年获得英语专业八级证书');
    expect(result.decision).toBe('matched');
    expect(result.reasonCodes).toContain('non_qualification_condition_ignored');
  });
  it('keeps an explicit failed certificate negative', () => {
    expect(evaluateCandidate(card, config(), '专八未通过').decision).toBe('not_matched');
  });
  it('does not fail an OR credential rule when one option is denied and the other is unknown', () => {
    expect(evaluateCandidate(card, config(['tem8', 'cet6']), '专八未通过').decision).toBe('insufficient');
  });
  it('fails an AND credential requirement with a known negative even if another certificate is present', () => {
    expect(evaluateCandidate(card, config(['tem8', 'cet6'], 'all'), 'CET6 已通过；专八未通过').decision).toBe('not_matched');
  });
  it('does not promote conflicting or planned certificate claims', () => {
    expect(evaluateCandidate(card, config(), '2024 年通过 TEM8；备注：专八未通过，待核实').decision).toBe('ambiguous');
    expect(evaluateCandidate(card, config(), '正在备考英语专业八级').decision).toBe('ambiguous');
  });
  it('preserves the configured missing-evidence policy instead of silently loosening it', () => {
    expect(evaluateCandidate(card, config(['tem8'], 'any', 'fail'), 'CET6').decision).toBe('not_matched');
  });
});
