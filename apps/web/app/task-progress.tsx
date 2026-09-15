'use client';
import { Progress } from '@/components/ui/progress';
import { describeBossFilters } from '../../../packages/contracts/src/boss-recommendation-filters';
import {
  taskProgress,
  type ProgressTask,
  type ProgressCandidate,
} from './task-progress-model';

export function ProgressRing({
  value,
  active = false,
  size = 56,
}: {
  value: number | null;
  active?: boolean;
  size?: number;
}) {
  const normalized = value === null ? null : Math.max(0, Math.min(100, value));
  return (
    <span
      className="relative inline-grid shrink-0 place-items-center text-primary"
      style={{ width: size, height: size }}
    >
      <svg
        viewBox="0 0 40 40"
        className={`size-full -rotate-90 ${normalized === null && active ? 'motion-safe:animate-spin' : ''}`}
        aria-hidden="true"
      >
        <circle
          cx="20"
          cy="20"
          r="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          className="text-border"
        />
        <circle
          cx="20"
          cy="20"
          r="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          pathLength="100"
          strokeDasharray={`${normalized ?? (active ? 26 : 0)} 100`}
          className="transition-[stroke-dasharray] motion-reduce:transition-none"
        />
      </svg>
      {size >= 48 ? (
        <span className="absolute text-xs font-semibold tabular-nums">
          {normalized === null ? '—' : `${normalized}%`}
        </span>
      ) : null}
      <span className="sr-only">
        {normalized === null
          ? active
            ? '后台正在处理，数量待确认'
            : '暂无进度'
          : `已处理 ${normalized}%`}
      </span>
    </span>
  );
}

export function TaskProgress({
  task,
  candidates,
  compact = false,
}: {
  task: ProgressTask;
  candidates: readonly ProgressCandidate[];
  compact?: boolean;
}) {
  const p = taskProgress(task, candidates);
  if (compact)
    return (
      <div className="min-w-28 space-y-1.5">
        <p className="text-xs tabular-nums">
          {p.processed} / {p.total} 份已处理
        </p>
        <Progress
          aria-label="简历处理进度"
          value={p.percent}
          className="h-1.5"
        />
        <p className="text-[11px] text-muted-foreground">
          {p.label}
          {p.errors ? ` · ${p.errors} 份异常` : ''}
        </p>
      </div>
    );
  return (
    <section
      aria-label="后台简历处理进度"
      className="space-y-3 rounded-xl border bg-muted/20 p-4"
    >
      <div className="flex items-center gap-4">
        <ProgressRing value={p.percent} active={p.active} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-semibold">
            {p.active ? (
              <span className="size-1.5 rounded-full bg-primary motion-safe:animate-pulse" />
            ) : null}
            {p.label}
          </p>
          <p className="mt-1 text-sm tabular-nums text-muted-foreground">
            {p.total
              ? `${p.processed} / ${p.total} 份已处理`
              : p.emptyCompleted
                ? '本次未采集到候选人'
                : '候选人数量尚未确定'}
            {p.errors ? `，其中 ${p.errors} 份异常` : ''}
          </p>
        </div>
      </div>
      <Progress aria-label="简历处理进度" value={p.percent} />
      {p.emptyCompleted ? (
        <p className="text-sm text-muted-foreground">
          可检查 BOSS 推荐列表，或调整岗位的官方筛选条件后新建任务。
        </p>
      ) : null}
      {task.candidateLimit && p.total <= task.candidateLimit ? (
        <p className="text-xs text-muted-foreground">
          本次上限 {task.candidateLimit} 人 · 已收集 {p.total}{' '}
          人，未通过与异常也计入人数
        </p>
      ) : null}
      {task.sourceBossFilters ? (
        <p className="text-xs leading-5 text-muted-foreground">
          <span className="font-medium text-foreground">
            BOSS 官方筛选已应用：
          </span>
          {describeBossFilters(task.sourceBossFilters)}
        </p>
      ) : task.status === 'running' ? (
        <p className="text-xs text-muted-foreground">
          正在准备岗位来源、应用筛选并读取候选人列表…
        </p>
      ) : null}
      <div className="grid grid-cols-4 gap-2 text-center text-xs">
        <div>
          <p className="font-semibold tabular-nums">{p.queued + p.remaining}</p>
          <p className="mt-1 text-muted-foreground">
            {task.status === 'cancelled' ? '已停止' : '待处理'}
          </p>
        </div>
        <div>
          <p className="font-semibold tabular-nums text-primary">
            {p.processing}
          </p>
          <p className="mt-1 text-muted-foreground">处理中</p>
        </div>
        <div>
          <p className="font-semibold tabular-nums text-success">{p.success}</p>
          <p className="mt-1 text-muted-foreground">精筛完成</p>
        </div>
        <div>
          <p className="font-semibold tabular-nums text-warning">{p.errors}</p>
          <p className="mt-1 text-muted-foreground">需处理</p>
        </div>
      </div>
      {p.retryAt ? (
        <p className="text-xs leading-5 text-muted-foreground">
          计划继续：{new Date(p.retryAt).toLocaleString('zh-CN')}
          ，以实际调度为准。
        </p>
      ) : null}
      {p.percent === 100 && !p.emptyCompleted ? (
        <p className="text-xs text-muted-foreground">
          进度表示已处理数量，审核结果与异常请分别查看。
        </p>
      ) : null}
    </section>
  );
}
