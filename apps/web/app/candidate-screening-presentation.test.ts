import { describe, expect, it } from 'vitest';
import { candidateScreeningPresentation } from './candidate-screening-presentation';
import { filterCandidateInbox } from './candidate-inbox-model';
describe('candidate outcome presentation', () => {
  it('does not show a failed read or an unprocessed card as a hiring outcome', () => {
    expect(
      candidateScreeningPresentation({
        ruleDecision: 'insufficient',
        resumeScreeningStatus: 'failed',
        resumeScreeningErrorCode: 'source_expired',
      }),
    ).toMatchObject({ label: '简历读取未完成', final: false });
    expect(
      candidateScreeningPresentation({
        ruleDecision: 'matched',
        resumeScreeningStatus: 'queued',
      }),
    ).toMatchObject({ label: '等待精筛', final: false });
  });
  it('explains which evidence is missing after a successful read', () => {
    expect(
      candidateScreeningPresentation({
        ruleDecision: 'insufficient',
        resumeScreeningStatus: 'screened',
        missingRuleLabels: ['英语证书', '毕业年份'],
      }),
    ).toMatchObject({
      label: '证据待补充',
      detail: '待核实：英语证书、毕业年份',
      final: true,
    });
  });
  it('separates rule passage from human approval', () => {
    const candidate = {
      name: '样本',
      fields: {},
      ruleDecision: 'matched',
      ruleConfidence: 0.95,
      resumeScreeningStatus: 'screened',
      reviewStatus: 'pending',
    };
    expect(filterCandidateInbox([candidate], 'matched', '')).toHaveLength(1);
    expect(filterCandidateInbox([candidate], 'approved', '')).toHaveLength(0);
    expect(
      filterCandidateInbox(
        [{ ...candidate, resumeScreeningStatus: 'failed' }],
        'matched',
        '',
      ),
    ).toHaveLength(0);
  });
  it('keeps failed requirements separate from missing evidence in a rejected result', () => {
    expect(candidateScreeningPresentation({
      ruleDecision: 'not_matched', resumeScreeningStatus: 'screened',
      failedRuleLabels: ['BOSS 院校标签'], missingRuleLabels: ['TEM8 英语专业八级'],
    }).detail).toBe('未满足：BOSS 院校标签。待核实：TEM8 英语专业八级。');
  });
  it('explains a configured missing-information failure without claiming contradictory evidence', () => {
    expect(candidateScreeningPresentation({
      ruleDecision: 'not_matched', resumeScreeningStatus: 'screened',
      failedRuleLabels: [], missingRuleLabels: ['BOSS 院校标签'],
    }).detail).toBe('存在按“缺少信息即不通过”处理的岗位条件。待核实：BOSS 院校标签。');
  });
});
