'use client';

import { Progress } from '@/components/ui/progress';

import { useEffect, useState } from 'react';
import { LoaderCircle, RefreshCw, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { CandidateAssessmentView } from '../../../packages/contracts/src/recruitment';
import { apiFetch } from './api-client';

export function AssessmentScore({
  assessment,
}: {
  assessment?: CandidateAssessmentView | null;
}) {
  if (!assessment)
    return (
      <span className="text-xs text-muted-foreground">未安排 AI 分析</span>
    );
  if (assessment.status !== 'completed' || !assessment.result)
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        {['queued', 'processing'].includes(assessment.status) ? (
          <LoaderCircle
            className="size-3.5 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : null}
        {assessment.status === 'cancelled'
          ? 'AI 分析已取消'
          : assessment.status === 'failed'
            ? 'AI 分析异常'
            : assessment.status === 'queued'
              ? '等待 AI 分析'
              : 'AI 正在分析'}
      </span>
    );
  return (
    <span className="inline-flex flex-wrap items-baseline gap-1.5">
      <strong className="text-lg tabular-nums">
        {assessment.result.score}
      </strong>
      <span className="text-xs text-muted-foreground">
        / 100 ·{' '}
        {assessment.result.recommendation === 'recommended'
          ? 'AI 推荐'
          : '低分待复核'}
      </span>
    </span>
  );
}

export function RecruitmentAssessmentPanel({
  initial,
  stateId,
  controlApi,
  canRetry,
}: {
  initial?: CandidateAssessmentView | null;
  stateId: string;
  controlApi: string;
  canRetry: boolean;
}) {
  const [assessment, setAssessment] = useState(initial ?? null);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!assessment || !['queued', 'processing'].includes(assessment.status))
      return;
    let cancelled = false;
    const timer = setInterval(() => {
      void apiFetch(`${controlApi}/api/candidate-position-states/${stateId}`)
        .then(async (response) => {
          if (!response.ok) return;
          const body = (await response.json()) as {
            candidate: { assessment?: CandidateAssessmentView | null };
          };
          if (!cancelled) setAssessment(body.candidate.assessment ?? null);
        })
        .catch(() => undefined);
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [assessment, stateId, controlApi]);
  async function retry() {
    setRetrying(true);
    setError('');
    try {
      const response = await apiFetch(
        `${controlApi}/api/candidate-position-states/${stateId}/ai-retry`,
        { method: 'POST' },
      );
      const body = (await response.json()) as { message?: string };
      if (!response.ok) throw new Error(body.message ?? '重试失败');
      setAssessment((current) =>
        current
          ? { ...current, status: 'queued', error: null, result: null }
          : current,
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '重试失败');
    } finally {
      setRetrying(false);
    }
  }
  if (!assessment) return null;
  const result = assessment.result;
  return (
    <section
      className="space-y-4 rounded-xl border border-primary/25 bg-primary/3 p-4"
      aria-label="AI 岗位匹配分析"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="size-4 text-primary" aria-hidden="true" />
          AI 岗位匹配分析
        </h3>
        <AssessmentScore assessment={assessment} />
      </div>
      {assessment.status === 'completed' && result ? (
        <>
          <p className="text-sm leading-6">{result.summary}</p>
          <p className="text-xs text-muted-foreground">
            本次规则分界 {result.threshold} 分。
            {result.recommendation === 'below_threshold'
              ? '已移入低分复核，仍可查看证据并人工审核。'
              : '建议优先阅读以下证据，再作审核决定。'}
          </p>
          <details className="rounded-lg border bg-card p-3">
            <summary className="cursor-pointer text-sm font-medium">
              AI 对招聘目的与目标的理解
            </summary>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-6">
              {result.understanding}
            </p>
          </details>
          <div className="grid gap-3">
            {result.dimensions.map((item) => (
              <div key={item.key} className="rounded-lg border bg-card p-3">
                <div className="mb-2 flex items-center justify-between gap-3 text-sm font-medium">
                  <span>{item.label}</span>
                  <span className="tabular-nums">
                    {item.score} / {item.maximum}
                  </span>
                </div>
                <Progress
                  className="h-1.5 w-full accent-primary"
                  value={item.score}
                  max={item.maximum}
                  aria-label={item.label}
                />
                <p className="mt-2 text-sm leading-6">{item.reason}</p>
                {item.evidence.map((quote, index) => (
                  <blockquote
                    key={index}
                    className="mt-2 border-l-2 border-primary/35 pl-3 text-xs leading-5 text-muted-foreground"
                  >
                    {quote}
                  </blockquote>
                ))}
              </div>
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <h4 className="mb-2 text-sm font-semibold">不足与待核实项</h4>
              <ul className="list-disc space-y-2 pl-4 text-xs leading-5">
                {result.gaps.length ? (
                  result.gaps.map((item, index) => <li key={index}>{item}</li>)
                ) : (
                  <li>未列出额外缺口，仍需核实实际经历。</li>
                )}
              </ul>
            </div>
            <div>
              <h4 className="mb-2 text-sm font-semibold">建议面试追问</h4>
              <ul className="list-disc space-y-2 pl-4 text-xs leading-5">
                {result.interviewQuestions.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {result.model} ·{' '}
            {new Date(result.completedAt).toLocaleString('zh-CN')} ·
            按本任务保存的岗位目标分析
          </p>
        </>
      ) : (
        <div className="space-y-3 text-sm" aria-live="polite">
          <p>
            {['failed', 'cancelled'].includes(assessment.status)
              ? assessment.error || '分析未完成，请重试。'
              : '正在使用已保存的完整简历分析岗位匹配度。你可以离开本页，结果会自动更新。'}
          </p>
          {assessment.status === 'failed' && canRetry ? (
            <Button
              size="sm"
              variant="outline"
              disabled={retrying}
              onClick={() => void retry()}
            >
              <RefreshCw
                className={retrying ? 'animate-spin' : ''}
                aria-hidden="true"
              />
              重新分析已存简历
            </Button>
          ) : null}
        </div>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
