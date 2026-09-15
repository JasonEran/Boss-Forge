export type CandidateRuleDecision =
  | 'matched'
  | 'not_matched'
  | 'ambiguous'
  | 'insufficient';

export function candidateRuleConfidenceLabel(
  decision: CandidateRuleDecision,
  confidence: number,
): string {
  if (decision === 'ambiguous' || decision === 'insufficient') return '待确认';
  const normalized = Number.isFinite(confidence)
    ? Math.min(1, Math.max(0, confidence))
    : 0;
  return `${Math.round(normalized * 100)}%`;
}
