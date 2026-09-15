import { describeResumeScreeningFailure } from './resume-screening-error';

type ScreeningInput = {
  ruleDecision: string;
  resumeScreeningStatus: string;
  resumeScreeningErrorCode?: string | null;
  resumeScreeningError?: string | null;
  missingRuleLabels?: readonly string[];
  failedRuleLabels?: readonly string[];
};

export function candidateScreeningPresentation(candidate: ScreeningInput) {
  const status = candidate.resumeScreeningStatus;
  if (status === 'failed' || status === 'no_text') {
    const failure = describeResumeScreeningFailure(
      candidate.resumeScreeningErrorCode ??
        candidate.resumeScreeningError ??
        null,
    );
    return {
      label: '简历读取未完成',
      detail: failure?.title ?? '尚未取得可用的完整简历，可重新精筛。',
      tone: 'warning',
      final: false,
    } as const;
  }
  if (status !== 'screened') {
    return {
      label: status === 'processing' ? '正在精筛' : '等待精筛',
      detail: '卡片仅供初步参考，完整简历读取后再给出结论。',
      tone: 'muted',
      final: false,
    } as const;
  }
  const labels: Record<string, string> = {
    matched: '规则通过',
    not_matched: '规则不符',
    ambiguous: '证据有歧义',
    insufficient: '证据待补充',
  };
  return {
    label: labels[candidate.ruleDecision] ?? '待核实',
    detail:
      candidate.ruleDecision === 'matched'
        ? '岗位条件已满足，等待 HR 审核。'
        : candidate.ruleDecision === 'insufficient'
          ? candidate.missingRuleLabels?.length
            ? `待核实：${candidate.missingRuleLabels.join('、')}`
            : '简历已读取，部分岗位条件尚无明确证据。'
          : candidate.ruleDecision === 'ambiguous'
            ? '证据存在冲突或表述不明确，请查看原文。'
            : [
                candidate.failedRuleLabels?.length
                  ? `未满足：${candidate.failedRuleLabels.join('、')}。`
                  : candidate.missingRuleLabels?.length
                    ? '存在按“缺少信息即不通过”处理的岗位条件。'
                    : '请查看具体未满足项及简历证据。',
                candidate.missingRuleLabels?.length
                  ? `待核实：${candidate.missingRuleLabels.join('、')}。`
                  : '',
              ].join(''),
    tone:
      candidate.ruleDecision === 'matched'
        ? 'success'
        : candidate.ruleDecision === 'not_matched'
          ? 'muted'
          : 'warning',
    final: true,
  } as const;
}
