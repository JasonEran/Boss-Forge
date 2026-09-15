import type { CandidateAssessmentView } from "../../../packages/contracts/src/recruitment";
export type CandidateFilter =
  | 'pending'
  | 'matched'
  | 'ai_recommended'
  | 'ai_low'
  | 'ai_waiting'
  | 'incomplete'
  | 'approved'
  | 'rejected'
  | 'failed'
  | 'all';
type InboxCandidate = {
  assessment?: CandidateAssessmentView | null;
  name: string;
  fields: Record<string, string>;
  ruleDecision: string;
  ruleConfidence: number;
  reviewStatus: string;
  resumeScreeningStatus: string;
};

export function filterCandidateInbox<T extends InboxCandidate>(
  candidates: readonly T[],
  filter: CandidateFilter,
  query: string,
): T[] {
  const terms = query
    .trim()
    .toLocaleLowerCase('zh-CN')
    .split(/\s+/u)
    .filter(Boolean);
  return candidates
    .filter((candidate) => {
      const result = candidate.assessment?.status === 'completed' ? candidate.assessment.result : null;
      if (filter === 'ai_recommended' && result?.recommendation !== 'recommended') return false;
      if (filter === 'ai_low' && result?.recommendation !== 'below_threshold') return false;
      if (filter === 'ai_waiting' && (!candidate.assessment || candidate.assessment.status === 'completed')) return false;
      if (filter === 'pending' && candidate.assessment && (candidate.assessment.status !== 'completed' || result?.recommendation === 'below_threshold')) return false;
      if (
        filter === 'matched' &&
        !(
          candidate.ruleDecision === 'matched' &&
          candidate.resumeScreeningStatus === 'screened'
        )
      )
        return false;
      if (
        filter === 'incomplete' &&
        !['queued', 'processing', 'not_requested'].includes(
          candidate.resumeScreeningStatus,
        )
      )
        return false;
      if (
        filter === 'failed' &&
        !['failed', 'no_text'].includes(candidate.resumeScreeningStatus)
      )
        return false;
      if (
        filter === 'rejected' &&
        !(
          candidate.reviewStatus === 'rejected' ||
          (candidate.reviewStatus === 'not_required' &&
            candidate.resumeScreeningStatus === 'screened')
        )
      )
        return false;
      if (
        ['pending', 'approved'].includes(filter) &&
        candidate.reviewStatus !== filter
      )
        return false;
      if (
        filter === 'pending' &&
        candidate.resumeScreeningStatus !== 'screened'
      )
        return false;
      const text = [candidate.name, ...Object.values(candidate.fields)]
        .join(' ')
        .toLocaleLowerCase('zh-CN');
      return terms.every((term) => text.includes(term));
    })
    .sort((a, b) => {
      const readiness = (candidate: T) =>
        ['screened', 'no_text', 'failed'].includes(
          candidate.resumeScreeningStatus,
        )
          ? 0
          : 1;
      return (
        readiness(a) - readiness(b) ||
        (a.ruleDecision === 'matched' ? 0 : 1) -
          (b.ruleDecision === 'matched' ? 0 : 1) ||
        (b.assessment?.result?.score ?? -1) - (a.assessment?.result?.score ?? -1) ||
        b.ruleConfidence - a.ruleConfidence
      );
    });
}
