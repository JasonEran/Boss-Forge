'use client';

import { Progress } from '@/components/ui/progress';

import { AssessmentScore } from './recruitment-assessment-panel';
import { TaskProgress } from './task-progress';

import { useState } from 'react';
import {
  ArrowRight,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Eye,
  Inbox,
  LoaderCircle,
  RefreshCw,
  Search,
  Send,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeLink as Link } from './native-link';
import type { Candidate } from './dashboard-client';
import { candidateRuleConfidenceLabel } from './candidate-confidence';
import { candidateScreeningPresentation } from './candidate-screening-presentation';
import {
  canRetryResumeScreening,
  describeResumeScreeningFailure,
} from './resume-screening-error';
import { taskWorkspaceHref } from './workspace-scope';
import {
  filterCandidateInbox,
  type CandidateFilter,
} from './candidate-inbox-model';
import { semanticDisplayStatus } from './semantic-status';
import { RankingGreetingDialog } from './ranking-greeting-dialog';
import type { GreetingIntent } from './ranking-greeting-model';

const screenings = {
  not_requested: '未安排精筛',
  queued: '等待精筛',
  processing: '精筛中',
  screened: '已精筛',
  no_text: '未识别到正文',
  failed: '精筛异常',
};
const reviews = {
  pending: '待审核',
  approved: '已通过',
  rejected: '人工淘汰',
  not_required: '规则未通过',
};
const pageSize = 20;

export function CandidateInbox({
  candidates,
  task,
  canReview,
  retryingId,
  onReview,
  onRetry,
  contact,
}: {
  candidates: Candidate[];
  task?: {
    id: string;
    positionId: string;
    positionName: string;
    createdAt: string;
    status: string;
    ruleVersion: number;
    candidateCount: number;
    newCandidateCount?: number;
    repeatCandidateCount?: number;
  };
  canReview: boolean;
  retryingId: string | null;
  onReview: (id: string, queue: string[]) => void;
  onRetry: (candidate: Candidate) => void;
  contact?: {
    controlApi: string;
    hrName: string;
    intents: GreetingIntent[];
    onChanged: () => Promise<void>;
  };
}) {
  const [filter, setFilter] = useState<CandidateFilter>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [greetingIds, setGreetingIds] = useState<string[] | null>(null);
  const filtered = filterCandidateInbox(candidates, filter, query);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visible = filtered.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  const ready = filtered.filter(
    (candidate) => candidate.resumeScreeningStatus === 'screened',
  );
  const tabs: { value: CandidateFilter; label: string }[] = [
    { value: 'all', label: '全部候选人' },
    { value: 'matched', label: '规则通过 · AI 排名' },
    { value: 'ai_recommended', label: 'AI 推荐' },
    { value: 'ai_low', label: '低分复核' },
    { value: 'ai_waiting', label: 'AI 等待 / 异常' },
    { value: 'pending', label: '待人工审核' },
    { value: 'incomplete', label: '等待 / 精筛中' },
    { value: 'approved', label: '人工已通过' },
    { value: 'rejected', label: '规则不符 / 人工淘汰' },
    { value: 'failed', label: '精筛异常' },
  ];
  function review(candidate: Candidate) {
    onReview(
      candidate.stateId,
      filtered.map((item) => item.stateId),
    );
  }

  return (
    <section
      className="overflow-hidden rounded-xl border bg-card shadow-xs"
      aria-label="候选人工作名单"
    >
      {task ? (
        <div className="border-b px-5 py-3">
          <TaskProgress task={task} candidates={candidates} compact />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-secondary text-primary">
            <Inbox className="size-5" />
          </span>
          <div>
            <h2 className="text-base font-semibold">
              {task?.positionName ?? '候选人名单'}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {task
                ? `${new Date(task.createdAt).toLocaleString('zh-CN')} · 规则 v${task.ruleVersion} · 采集 ${task.candidateCount} 人`
                : '选择岗位和筛选任务，开始查看候选人。'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {task && canReview ? (
            <Link
              href={taskWorkspaceHref('/contacts', task)}
              className="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground hover:text-primary"
            >
              联系已通过
              <ArrowRight className="size-4" />
            </Link>
          ) : null}
          <Button
            disabled={!ready.length}
            data-spotlight="candidate-review"
            onClick={() => ready[0] && review(ready[0])}
          >
            <CheckCheck className="size-4" />
            {canReview ? '审核已精筛简历' : '查看候选人'}
          </Button>
        </div>
      </div>
      {candidates.some((item) => item.assessment) ? (
        <div
          className="space-y-2 border-b bg-primary/3 px-5 py-3 text-xs"
          aria-live="polite"
        >
          <div className="flex flex-wrap justify-between gap-2">
            <span>AI 分析进度 · 使用已存完整简历</span>
            <span>
              {
                candidates.filter(
                  (item) => item.assessment?.status === 'completed',
                ).length
              }{' '}
              / {candidates.filter((item) => item.assessment).length} 人已完成 ·{' '}
              {
                candidates.filter(
                  (item) => item.assessment?.status === 'failed',
                ).length
              }{' '}
              人异常
            </span>
          </div>
          <Progress
            className="h-2 w-full accent-primary"
            value={
              candidates.filter((item) =>
                ['completed', 'failed', 'cancelled'].includes(
                  item.assessment?.status ?? '',
                ),
              ).length
            }
            max={candidates.filter((item) => item.assessment).length}
            aria-label="AI 分析进度"
          />
        </div>
      ) : null}
      {task?.status === 'cancelled' ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/35 px-5 py-3 text-sm">
          <span>这个任务已取消，已保存的候选人和审核记录仍可查看。</span>
          {canReview ? (
            <Link
              href={taskWorkspaceHref('/tasks', task)}
              className="inline-flex min-h-11 items-center gap-1 font-medium text-primary"
            >
              恢复任务后继续精筛
              <ArrowRight className="size-4" />
            </Link>
          ) : null}
        </div>
      ) : null}
      <div
        className="flex gap-5 overflow-x-auto border-b px-5"
        aria-label="候选人状态"
        data-spotlight="candidate-status"
      >
        {tabs.map((tab) => (
          <button
            type="button"
            key={tab.value}
            aria-pressed={filter === tab.value}
            onClick={() => {
              setFilter(tab.value);
              setPage(1);
            }}
            className={`flex min-h-12 shrink-0 items-center gap-2 border-b-2 text-sm transition-colors ${filter === tab.value ? 'border-primary font-semibold text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
            {tab.label}
            <span
              className={`rounded-md px-1.5 py-0.5 text-xs tabular-nums ${filter === tab.value ? 'bg-secondary' : 'bg-muted'}`}
            >
              {filterCandidateInbox(candidates, tab.value, '').length}
            </span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 bg-muted/25 px-5 py-3">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            aria-label="搜索候选人"
            placeholder="搜索姓名、经历、技能…"
            className="h-10 bg-card pl-9 pr-10"
          />
          {query ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute right-0 top-0 min-h-10 min-w-10"
              aria-label="清除搜索"
              onClick={() => {
                setQuery('');
                setPage(1);
              }}
            >
              <X className="size-4" />
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {query
            ? `找到 ${filtered.length} 人`
            : `新候选人 ${task?.newCandidateCount ?? candidates.filter((item) => !item.isRepeat).length} 人 · 重复出现 ${task?.repeatCandidateCount ?? candidates.filter((item) => item.isRepeat).length} 人`}
        </p>
        {filter === 'matched' && task && canReview && contact ? (
          <Button
            disabled={!filtered.length}
            onClick={() => setGreetingIds(filtered.map((item) => item.stateId))}
          >
            <Send className="size-4" aria-hidden="true" />
            一键打招呼
            <span className="text-xs opacity-80">{filtered.length} 人</span>
          </Button>
        ) : null}
      </div>
      {greetingIds && task && contact ? (
        <RankingGreetingDialog
          candidates={greetingIds.flatMap(
            (id) => candidates.find((item) => item.stateId === id) ?? [],
          )}
          task={task}
          intents={contact.intents}
          controlApi={contact.controlApi}
          hrName={contact.hrName}
          onChanged={contact.onChanged}
          onClose={() => setGreetingIds(null)}
        />
      ) : null}
      {visible.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-y bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-5 py-3 font-medium">候选人 / 经历</th>
                <th className="px-4 py-3 font-medium">AI 匹配分 · 从高到低</th>
                <th className="px-4 py-3 font-medium">规则结果</th>
                <th className="px-4 py-3 font-medium">精筛进度</th>
                <th className="px-4 py-3 font-medium">审核状态</th>
                <th className="sticky right-0 bg-card px-5 py-3 text-right font-medium">
                  操作
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {visible.map((candidate) => {
                const failure = describeResumeScreeningFailure(
                  candidate.resumeScreeningErrorCode ??
                    candidate.resumeScreeningError,
                );
                const semantic = semanticDisplayStatus(candidate);
                const presentation = candidateScreeningPresentation(candidate);
                const expired = [
                  'source_expired',
                  'target_missing',
                  'target_changed',
                ].includes(candidate.resumeScreeningErrorCode ?? '');
                return (
                  <tr
                    key={candidate.stateId}
                    className="group hover:bg-muted/25"
                  >
                    <td className="min-w-56 max-w-80 px-5 py-4 align-top">
                      <button
                        type="button"
                        className="min-h-9 text-left text-[15px] font-semibold hover:text-primary"
                        onClick={() => review(candidate)}
                      >
                        {candidate.name}
                      </button>
                      {candidate.isRepeat ? (
                        <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          曾出现
                        </span>
                      ) : null}
                      <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
                        {['信息', '期望', '经验', '薪资']
                          .map((key) => candidate.fields[key])
                          .filter(Boolean)
                          .join(' · ') || '查看原始卡片与简历证据'}
                      </p>
                    </td>
                    <td className="min-w-56 max-w-80 px-4 py-4 align-top">
                      <AssessmentScore assessment={candidate.assessment} />
                      <p className="mt-2 line-clamp-3 text-xs leading-5 text-muted-foreground">
                        {candidate.assessment?.result?.summary ??
                          candidate.assessment?.error ??
                          (candidate.salaryScreening?.status === 'above_budget'
                            ? '期望薪资最高值超出预算，未打开简历。'
                            : '')}
                      </p>
                    </td>
                    <td className="min-w-44 max-w-64 px-4 py-4 align-top">
                      <span
                        className={`inline-flex items-center gap-1.5 text-sm font-medium ${presentation.tone === 'success' ? 'text-success' : presentation.tone === 'muted' ? 'text-muted-foreground' : 'text-warning-foreground'}`}
                      >
                        <span className="size-1.5 rounded-full bg-current" />
                        {candidateScreeningPresentation(candidate).label}
                      </span>
                      <p className="mt-1 text-xs text-muted-foreground">
                        结论置信度{' '}
                        {presentation.final
                          ? candidateRuleConfidenceLabel(
                              candidate.ruleDecision,
                              candidate.ruleConfidence,
                            )
                          : '待精筛完成'}
                      </p>
                      <p className="mt-1 text-xs leading-5">
                        {presentation.final &&
                        candidate.ruleDecision === 'not_matched'
                          ? candidate.failedRuleLabels.join('、') ||
                            presentation.detail
                          : presentation.detail}
                      </p>
                      <p
                        className="mt-1 text-[11px] text-muted-foreground"
                        title={semantic.detail}
                      >
                        智能识别：{semantic.label}
                      </p>
                    </td>
                    <td className="min-w-44 max-w-64 px-4 py-4 align-top">
                      <span
                        className={`flex items-center gap-1.5 text-xs ${candidate.resumeScreeningStatus === 'failed' ? 'text-warning-foreground' : 'text-muted-foreground'}`}
                      >
                        {candidate.resumeScreeningStatus === 'processing' ? (
                          <LoaderCircle className="size-3.5 animate-spin" />
                        ) : null}
                        {candidate.salaryScreening?.status === 'above_budget'
                          ? '薪资已过滤 · 未读取简历'
                          : screenings[candidate.resumeScreeningStatus]}
                      </span>
                      {candidate.resumeScreeningStatus === 'failed' ||
                      candidate.resumeScreeningStatus === 'no_text' ? (
                        <p className="mt-2 text-xs leading-5 text-warning-foreground">
                          {failure?.title ?? '请查看原文或重新精筛'}
                        </p>
                      ) : null}
                      {candidate.resumeScreeningNextAttemptAt ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          预计重试{' '}
                          {new Date(
                            candidate.resumeScreeningNextAttemptAt,
                          ).toLocaleString('zh-CN')}
                        </p>
                      ) : candidate.nextAction ? (
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          {candidate.nextAction}
                        </p>
                      ) : null}
                      {expired && task && canReview ? (
                        <Link
                          href={taskWorkspaceHref('/tasks', task)}
                          className="mt-1 inline-flex min-h-9 items-center gap-1 text-xs font-medium text-primary"
                        >
                          重新采集该岗位
                          <ArrowRight className="size-3" />
                        </Link>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-4 py-4 align-top">
                      <Badge
                        variant={
                          candidate.reviewStatus === 'approved'
                            ? 'secondary'
                            : 'outline'
                        }
                      >
                        {reviews[candidate.reviewStatus]}
                      </Badge>
                    </td>
                    <td className="sticky right-0 bg-card px-5 py-4 text-right align-top">
                      <div className="flex flex-col items-end gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => review(candidate)}
                        >
                          <Eye className="size-4" />
                          {canReview
                            ? candidate.reviewStatus === 'pending'
                              ? '审核'
                              : '复核 / 改判'
                            : '查看证据'}
                        </Button>
                        {canReview &&
                        task &&
                        ['screening', 'waiting_review'].includes(task.status) &&
                        canRetryResumeScreening(
                          candidate.resumeScreeningStatus,
                          candidate.resumeScreeningErrorCode ??
                            candidate.resumeScreeningError,
                        ) ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={retryingId !== null}
                            onClick={() => onRetry(candidate)}
                          >
                            {retryingId === candidate.stateId ? (
                              <LoaderCircle className="size-3 animate-spin" />
                            ) : (
                              <RefreshCw className="size-3" />
                            )}
                            {expired ? '重新定位并精筛' : '重新精筛'}
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid min-h-64 place-items-center px-6 py-10 text-center">
          <div>
            <Inbox className="mx-auto mb-3 size-8 text-muted-foreground/60" />
            <p className="font-medium">
              {query
                ? '没有找到匹配的候选人'
                : filter === 'pending' && candidates.length
                  ? '这批候选人已处理完毕'
                  : '当前名单暂无候选人'}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              {query
                ? '试试姓名或更简短的关键词。'
                : candidates.length
                  ? '切换上方状态，查看其他候选人和历史结果。'
                  : '创建筛选任务后，候选人会出现在这里。'}
            </p>
            {query ? (
              <Button
                className="mt-4"
                variant="outline"
                onClick={() => setQuery('')}
              >
                清除搜索
              </Button>
            ) : candidates.length ? (
              <Button
                className="mt-4"
                variant="outline"
                onClick={() => {
                  setFilter('all');
                  setPage(1);
                }}
              >
                查看全部候选人
              </Button>
            ) : null}
          </div>
        </div>
      )}
      <div className="flex items-center justify-between border-t px-5 py-3">
        <p className="text-xs tabular-nums text-muted-foreground">
          {filtered.length
            ? `${(currentPage - 1) * pageSize + 1}–${Math.min(currentPage * pageSize, filtered.length)} / ${filtered.length} 人`
            : '共 0 人'}
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="上一页候选人"
            disabled={currentPage <= 1}
            onClick={() => setPage(currentPage - 1)}
          >
            <ChevronLeft />
          </Button>
          <span className="text-xs tabular-nums">
            {currentPage} / {totalPages}
          </span>
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="下一页候选人"
            disabled={currentPage >= totalPages}
            onClick={() => setPage(currentPage + 1)}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
    </section>
  );
}
