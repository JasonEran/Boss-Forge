export type ProgressTask = {
  id: string;
  status: string;
  candidateCount: number;
  candidateLimit?: number;
  nextRunAt?: string | null;
  waitReasonCode?: string | null;
  sourceBossFilters?:
    | import('../../../packages/contracts/src/boss-recommendation-filters').BossRecommendationFilterPlan
    | null;
};
export type ProgressCandidate = {
  taskId: string;
  resumeScreeningStatus: string;
  resumeScreeningNextAttemptAt?: string | null;
};

export function taskProgress(
  task: ProgressTask,
  candidates: readonly ProgressCandidate[],
) {
  const list = candidates.filter((item) => item.taskId === task.id);
  const count = (status: string) =>
    list.filter((item) => item.resumeScreeningStatus === status).length;
  const success = count('screened');
  const errors = count('failed') + count('no_text');
  const processed = success + errors;
  const total = Math.max(
    0,
    Number.isFinite(task.candidateCount) ? task.candidateCount : 0,
    list.length,
  );
  const processing = count('processing');
  const queued = count('queued');
  const remaining = Math.max(0, total - processed - processing - queued);
  const stopped = ['cancelled', 'failed', 'completed'].includes(task.status);
  const active =
    !stopped &&
    (['queued', 'running', 'screening'].includes(task.status) ||
      processing + queued > 0);
  const percent = total
    ? Math.min(100, Math.round((processed / total) * 100))
    : task.status === 'completed'
      ? 100
      : null;
  const emptyCompleted = task.status === 'completed' && total === 0;
  const retryTimes = [
    task.nextRunAt,
    ...list
      .filter((item) => item.resumeScreeningStatus === 'queued')
      .map((item) => item.resumeScreeningNextAttemptAt),
  ]
    .filter(
      (value): value is string =>
        Boolean(value) && Number.isFinite(Date.parse(value!)),
    )
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const label =
    task.status === 'cancelled'
      ? '任务已取消'
      : task.status === 'failed'
        ? '任务需处理'
        : processing
          ? '正在读取 / 精筛简历'
          : queued
            ? '等待简历处理'
            : task.status === 'queued'
              ? '等待开始'
              : task.status === 'running'
                ? '正在采集候选人'
                : task.status === 'screening'
                  ? '正在精筛'
                  : task.status === 'waiting_review'
                    ? '等待人工审核'
                    : emptyCompleted
                      ? '采集已完成 · 0 位候选人'
                      : '处理已结束';
  return {
    total,
    processed,
    success,
    errors,
    processing,
    queued,
    remaining,
    active,
    percent,
    label,
    emptyCompleted,
    retryAt: active ? (retryTimes[0] ?? null) : null,
  };
}
