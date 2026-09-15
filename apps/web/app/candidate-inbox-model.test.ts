import { describe, expect, it } from 'vitest';
import { filterCandidateInbox } from './candidate-inbox-model';
const candidate = (
  name: string,
  reviewStatus = 'pending',
  resumeScreeningStatus = 'screened',
) => ({
  name,
  reviewStatus,
  resumeScreeningStatus,
  ruleDecision: 'matched',
  ruleConfidence: 0.9,
  fields: { 经验: '广州 TEM8 教师' },
});
describe('candidate inbox', () => {
  const candidates = [
    candidate('等待', 'pending', 'queued'),
    candidate('可审核'),
    candidate('已通过', 'approved'),
    candidate('人工淘汰', 'rejected'),
    candidate('规则淘汰', 'not_required'),
    candidate('异常', 'pending', 'failed'),
  ];
  it('keeps every review status accessible, including approved candidates', () => {
    expect(filterCandidateInbox(candidates, 'all', '')).toHaveLength(6);
    expect(
      filterCandidateInbox(candidates, 'approved', '').map((item) => item.name),
    ).toEqual(['已通过']);
    expect(filterCandidateInbox(candidates, 'rejected', '')).toHaveLength(2);
    expect(
      filterCandidateInbox(candidates, 'failed', '').map((item) => item.name),
    ).toEqual(['异常']);
  });
  it('puts actionable candidates before unfinished screening without mutating source data', () => {
    expect(
      filterCandidateInbox(candidates, 'pending', '').map((item) => item.name),
    ).toEqual(['可审核']);
    expect(
      filterCandidateInbox(candidates, 'incomplete', '').map(
        (item) => item.name,
      ),
    ).toEqual(['等待']);
    expect(candidates[0]?.name).toBe('等待');
  });
  it('searches name and profile with case-insensitive multiple keywords', () => {
    expect(
      filterCandidateInbox(candidates, 'all', '  可审核  tem8 '),
    ).toHaveLength(1);
    expect(filterCandidateInbox(candidates, 'all', '不存在')).toHaveLength(0);
  });
});

it('ranks AI scores before rule confidence and keeps low scores available for review', () => {
  const low = { ...candidate('低分'), ruleConfidence: 1, assessment: { status: 'completed' as const, error: null, ruleVersionId: 'r1', result: { score: 65, threshold: 70, recommendation: 'below_threshold' as const } } };
  const high = { ...candidate('高分'), ruleConfidence: 0.8, assessment: { ...low.assessment, result: { score: 85, threshold: 70, recommendation: 'recommended' as const } } };
  const rows = [low, high] as unknown as (ReturnType<typeof candidate> & { assessment: import('../../../packages/contracts/src/recruitment').CandidateAssessmentView })[];
  expect(filterCandidateInbox(rows, 'matched', '').map(item => item.name)).toEqual(['高分', '低分']);
  expect(filterCandidateInbox(rows, 'pending', '').map(item => item.name)).toEqual(['高分']);
  expect(filterCandidateInbox(rows, 'ai_low', '').map(item => item.name)).toEqual(['低分']);
  expect(filterCandidateInbox(rows, 'all', '')).toHaveLength(2);
});
