import type { Candidate } from './dashboard-client';

export type GreetingIntent = {
  candidateStateId: string;
  actionKind: string;
  status: string;
};

export type RankingGreetingPreview = {
  preview: {
    candidateStateId: string;
    candidateName: string;
    positionId: string;
    taskId: string;
    actionKind: string;
    renderedMessage: string;
  };
  readiness: {
    ready: boolean;
    checks: { passed: boolean; label: string; detail: string }[];
  };
  approval: { token: string; expiresAt: string } | null;
};

export function rankingGreetingBlockReason(
  candidate: Candidate,
  intents: readonly GreetingIntent[],
): string | null {
  if (
    intents.some(
      (item) =>
        item.candidateStateId === candidate.stateId &&
        item.actionKind === 'greet' &&
        ['ready', 'processing', 'sent', 'uncertain', 'simulated'].includes(
          item.status,
        ),
    )
  )
    return '已打过招呼、排队中或待核实，本次跳过';
  if (
    candidate.ruleDecision !== 'matched' ||
    candidate.resumeScreeningStatus !== 'screened'
  )
    return '规则结果已变化，请重新查看候选人';
  if (
    candidate.reviewStatus === 'rejected' ||
    candidate.reviewStatus === 'not_required'
  )
    return '已淘汰，请先单独复核';
  if (candidate.reviewStatus !== 'approved' && candidate.assessment) {
    if (
      candidate.assessment.status !== 'completed' ||
      !candidate.assessment.result
    )
      return 'AI 分析未完成，请先完成分析或单独复核';
    if (candidate.assessment.result.recommendation !== 'recommended')
      return 'AI 低分，需先单独复核通过';
  }
  return null;
}

export function greetingBatches<T>(items: readonly T[]): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += 20)
    batches.push(items.slice(index, index + 20));
  return batches;
}

export function assertRankingGreetingPreview(
  previews: readonly RankingGreetingPreview[],
  expected: {
    stateIds: readonly string[];
    taskId: string;
    positionId: string;
    body: string;
  },
): void {
  const ids = previews.map((item) => item.preview.candidateStateId);
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== expected.stateIds.length ||
    previews.some(
      ({ preview }) =>
        !expected.stateIds.includes(preview.candidateStateId) ||
        preview.taskId !== expected.taskId ||
        preview.positionId !== expected.positionId ||
        preview.actionKind !== 'greet',
    )
  )
    throw new Error('预览名单与当前任务不一致，请重新打开一键打招呼。');
  if (previews.some((item) => item.preview.renderedMessage !== expected.body))
    throw new Error('BOSS 岗位招呼语已变化，请重新读取招呼语并预览。');
}
