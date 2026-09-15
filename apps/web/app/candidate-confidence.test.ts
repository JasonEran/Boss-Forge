import { describe, expect, it } from 'vitest';
import { candidateRuleConfidenceLabel } from './candidate-confidence';

describe('candidate rule confidence label', () => {
  it('uses a status label instead of a misleading zero for unresolved conclusions', () => {
    expect(candidateRuleConfidenceLabel('insufficient', 0)).toBe('待确认');
    expect(candidateRuleConfidenceLabel('ambiguous', 0.6)).toBe('待确认');
  });

  it('keeps percentages for resolved conclusions', () => {
    expect(candidateRuleConfidenceLabel('matched', 0.99)).toBe('99%');
    expect(candidateRuleConfidenceLabel('not_matched', 1)).toBe('100%');
  });
});
