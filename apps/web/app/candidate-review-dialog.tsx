'use client';

import { RecruitmentAssessmentPanel } from './recruitment-assessment-panel';

import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  ShieldAlert,
  XCircle,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ResumePreview } from './resume-preview';
import { apiFetch } from './api-client';
import { candidateRuleConfidenceLabel } from './candidate-confidence';
import { candidateScreeningPresentation } from './candidate-screening-presentation';
import {
  candidateRuleEvidenceLabel,
  candidateRuleEvidenceRecognitionLabel,
  candidateRuleEvidenceSourceText,
  safeIdentifierLabel,
} from './hr-display';
import {
  canRetryResumeScreening,
  describeResumeScreeningFailure,
} from './resume-screening-error';

type CandidateDetail = {
  assessment?:
    | import('../../../packages/contracts/src/recruitment').CandidateAssessmentView
    | null;
  stateId: string;
  stateVersion: number;
  name: string;
  positionName: string;
  ruleDecision: 'matched' | 'not_matched' | 'ambiguous' | 'insufficient';
  ruleConfidence: number;
  reviewStatus: 'pending' | 'approved' | 'rejected' | 'not_required';
  resumeScreeningStatus:
    | 'not_requested'
    | 'queued'
    | 'processing'
    | 'screened'
    | 'no_text'
    | 'failed';
  currentEnglishLevel: string | null;
  resumeScreenedAt: string | null;
  resumeScreeningError: string | null;
  resumeScreeningErrorCode?: string | null;
  resumeScreeningNextAttemptAt?: string | null;
  nextAction?: string | null;
  missingRuleLabels?: string[];
  failedRuleLabels?: string[];
  resumeScreenshotAvailable: boolean;
  fields: Record<string, string>;
  evidence: string[];
  rawText: string;
  ruleVersion: number;
  dictionaryVersion: string;
  matchEvidence: Array<{
    capabilityId: string;
    canonicalLabel: string;
    sourceText: string;
    normalizedAlias: string;
    status: 'positive' | 'negative' | 'ambiguous';
    confidence: number;
    reasonCodes: string[];
  }>;
  semanticEvaluations: Array<{
    criterionId: string;
    factType: string;
    executionMode: 'normalized_entity' | 'semantic_rubric';
    result: 'matched' | 'not_matched' | 'unknown';
    normalizedValue: unknown;
    qualifier: string | null;
    evidence: string[];
    confidence: number;
    extractor: 'alias' | 'llm' | 'none';
    modelVersion: string | null;
    promptVersion: string;
    catalogVersion: string;
    rubricVersion: string | null;
    runtimeMode: 'shadow' | 'active';
    reasonCodes: string[];
  }>;
  reviews: Array<{
    id: string;
    decision: 'approved' | 'rejected';
    note: string;
    reviewerId: string;
    createdAt: string;
  }>;
};

type CandidateReviewDialogProps = {
  open: boolean;
  stateId: string | null;
  controlApi: string;
  onOpenChange: (open: boolean) => void;
  onReviewed: () => Promise<void> | void;
  canReview?: boolean;
  canRetryScreening?: boolean;
  onPrevious?: () => void;
  onNext?: () => void;
  queueLabel?: string;
};

async function responseJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { message?: string };
  if (!response.ok)
    throw new Error(payload.message ?? `HTTP ${response.status}`);
  return payload;
}

const screeningLabel: Record<CandidateDetail['resumeScreeningStatus'], string> =
  {
    not_requested: '未安排简历精筛',
    queued: '等待简历预览',
    processing: '正在读取完整简历',
    screened: '完整简历已精筛',
    no_text: '简历已预览，未识别到正文',
    failed: '简历精筛失败',
  };

const extractorLabel = {
  alias: '同义词匹配',
  llm: '大模型分析',
  none: '未能识别',
} as const;

const evidenceStatusLabel = {
  positive: '已找到支持证据',
  negative: '已找到不符合证据',
  ambiguous: '证据不明确',
} as const;

const candidateFieldLabel: Record<string, string> = {
  信息: '基本信息',
  期望: '求职期望',
  薪资: '期望薪资',
  经验: '工作经验',
  学历: '学历',
  年龄: '年龄',
  性别: '性别',
  毕业年份: '毕业年份',
  证书: '证书 / 语言能力',
  技能: '技能',
  学校: '学校',
  专业: '专业',
  地点: '所在地点',
  age: '年龄',
  gender: '性别',
  graduation_year: '毕业年份',
  certificate: '证书 / 语言能力',
  skills: '技能',
  education: '学历',
  experience: '工作经验',
};

function fieldLabel(key: string): string {
  return candidateFieldLabel[key] ?? safeIdentifierLabel(key);
}

function normalizedValueSummary(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number')
    return String(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.join('、');
  }
  return '已提取结构化信息';
}

function semanticCriterionLabel(
  candidate: CandidateDetail,
  criterionId: string,
): string {
  return (
    candidate.matchEvidence.find(
      (item) => item.capabilityId === `semantic.${criterionId}`,
    )?.canonicalLabel ?? criterionId
  );
}

export function CandidateReviewDialog({
  open,
  stateId,
  controlApi,
  onOpenChange,
  onReviewed,
  canReview = true,
  canRetryScreening = true,
  onPrevious,
  onNext,
  queueLabel,
}: CandidateReviewDialogProps) {
  const [resumeExpanded, setResumeExpanded] = useState(false);
  const [loadedCandidate, setCandidate] = useState<CandidateDetail | null>(
    null,
  );
  const candidate =
    loadedCandidate?.stateId === stateId ? loadedCandidate : null;
  const [continueReviewing, setContinueReviewing] = useState(true);
  const [note, setNote] = useState('');
  const [correctionCode, setCorrectionCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const screeningFailure = describeResumeScreeningFailure(
    candidate?.resumeScreeningErrorCode ??
      candidate?.resumeScreeningError ??
      null,
  );

  useEffect(() => {
    if (!open || !stateId) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setCandidate(null);
      setResumeExpanded(false);
      setNote('');
      setCorrectionCode(null);
      setLoading(true);
      setError(null);
      void apiFetch(`${controlApi}/api/candidate-position-states/${stateId}`, {
        cache: 'no-store',
      })
        .then((response) =>
          responseJson<{ candidate: CandidateDetail }>(response),
        )
        .then((payload) => {
          if (!cancelled) setCandidate(payload.candidate);
        })
        .catch((loadError: unknown) => {
          if (!cancelled)
            setError(
              loadError instanceof Error
                ? loadError.message
                : String(loadError),
            );
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [controlApi, open, stateId]);

  async function review(decision: 'approved' | 'rejected') {
    if (!candidate || submitting) return;
    if (decision === 'rejected' && !note.trim()) {
      setError('拒绝候选人时请填写审核原因。');
      return;
    }
    if (
      decision === 'approved' &&
      (candidate.ruleDecision !== 'matched' ||
        (candidate.assessment &&
          (candidate.assessment.status !== 'completed' ||
            candidate.assessment.result?.recommendation ===
              'below_threshold'))) &&
      !note.trim()
    ) {
      setError('人工改判为通过时，请说明改判原因。');
      return;
    }
    if (
      decision === 'approved' &&
      (candidate.ruleDecision !== 'matched' ||
        (candidate.assessment &&
          (candidate.assessment.status !== 'completed' ||
            candidate.assessment.result?.recommendation ===
              'below_threshold'))) &&
      !correctionCode
    ) {
      setError('人工改判为通过时，请选择一项规则纠错类型。');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await apiFetch(
        `${controlApi}/api/candidate-position-states/${candidate.stateId}/reviews`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': crypto.randomUUID(),
          },
          body: JSON.stringify({
            decision,
            note,
            correctionCode,
            reviewerId: 'hr:dashboard',
            expectedVersion: candidate.stateVersion,
          }),
        },
      );
      await responseJson(response);
      await onReviewed();
      setNote('');
      setCorrectionCode(null);
      if (continueReviewing && onNext) onNext();
      else onOpenChange(false);
    } catch (reviewError) {
      setError(
        reviewError instanceof Error
          ? reviewError.message
          : String(reviewError),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function requeueResumeScreening() {
    if (!candidate || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await apiFetch(
        `${controlApi}/api/candidate-position-states/${candidate.stateId}/resume-screenings`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ actorId: 'hr:dashboard' }),
        },
      );
      await responseJson(response);
      await onReviewed();
      onOpenChange(false);
    } catch (screeningError) {
      setError(
        screeningError instanceof Error
          ? screeningError.message
          : String(screeningError),
      );
    } finally {
      setSubmitting(false);
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    if (submitting) return;
    if (!nextOpen) {
      setNote('');
      setCorrectionCode(null);
      setError(null);
    }
    onOpenChange(nextOpen);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader className="shrink-0 border-b px-6 py-4 pr-14">
          <DialogTitle>{candidate?.name ?? '候选人详情'}</DialogTitle>
          <DialogDescription>
            {candidate
              ? `${candidate.positionName} · 规则 v${candidate.ruleVersion}`
              : '正在读取规则证据'}
          </DialogDescription>
          {queueLabel ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="上一位候选人"
                disabled={
                  !onPrevious || loading || submitting || Boolean(note.trim())
                }
                onClick={onPrevious}
              >
                <ChevronLeft />
              </Button>
              <span className="text-xs tabular-nums text-muted-foreground">
                {queueLabel}
              </span>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="下一位候选人"
                disabled={
                  !onNext || loading || submitting || Boolean(note.trim())
                }
                onClick={onNext}
              >
                <ChevronRight />
              </Button>
              {note.trim() ? (
                <span className="text-xs text-muted-foreground">
                  提交或清空备注后可切换
                </span>
              ) : null}
            </div>
          ) : null}
        </DialogHeader>

        {loading ? (
          <div className="grid min-h-48 place-items-center text-sm text-muted-foreground">
            <LoaderCircle
              className="size-5 animate-spin"
              aria-label="正在加载"
            />
          </div>
        ) : candidate ? (
          <div
            key={stateId}
            className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={
                  candidate.ruleDecision === 'matched' ? 'secondary' : 'outline'
                }
              >
                {candidateScreeningPresentation(candidate).label}
              </Badge>
              <span className="text-sm font-medium tabular-nums">
                结论置信度{' '}
                {candidateRuleConfidenceLabel(
                  candidate.ruleDecision,
                  candidate.ruleConfidence,
                )}
              </span>
              <Badge variant="outline">
                {screeningLabel[candidate.resumeScreeningStatus]}
              </Badge>
            </div>
            <p className="rounded-lg border bg-muted/25 px-3 py-2 text-sm leading-6">
              {candidateScreeningPresentation(candidate).detail}
            </p>
            <RecruitmentAssessmentPanel
              key={candidate.stateId}
              initial={candidate.assessment}
              stateId={candidate.stateId}
              controlApi={controlApi}
              canRetry={canReview}
            />
            {candidate.assessment && !resumeExpanded ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => setResumeExpanded(true)}
              >
                展开已保存的完整简历
              </Button>
            ) : (
              <ResumePreview
                stateId={candidate.stateId}
                name={candidate.name}
                available={candidate.resumeScreenshotAvailable}
                controlApi={controlApi}
              />
            )}
            <details className="rounded-lg border bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer font-medium text-foreground">
                查看记录版本
              </summary>
              <p className="mt-2 leading-5">
                规则版本 {candidate.ruleVersion} · 识别词典版本{' '}
                {candidate.dictionaryVersion} · 状态版本{' '}
                {candidate.stateVersion}
              </p>
            </details>

            {candidate.ruleDecision !== 'matched' ||
            (candidate.assessment &&
              (candidate.assessment.status !== 'completed' ||
                candidate.assessment.result?.recommendation ===
                  'below_threshold')) ? (
              <section className="rounded-lg border border-warning/35 bg-warning/8 p-3 text-sm leading-6">
                <p className="font-semibold">可以人工改判</p>
                <p className="mt-1 text-muted-foreground">
                  人工通过只会更改审核结果，不会改写机器判定。请填写原因并选择纠错类型，便于后续改进规则。
                </p>
              </section>
            ) : null}

            <section className="rounded-lg border bg-muted/30 p-3">
              <h3 className="text-sm font-semibold">识别到的英语等级</h3>
              <p className="mt-1 text-sm">
                {candidate.currentEnglishLevel ??
                  '完整简历中未识别到明确的英语证书或成绩'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                仅展示简历明确写出的考试等级/成绩，不在 TEM、CET、IELTS、TOEFL
                之间进行等值换算。
                {candidate.resumeScreenshotAvailable
                  ? ' 已保存简历预览截图。'
                  : ''}
              </p>
              {screeningFailure ? (
                <div
                  role="alert"
                  className="mt-3 rounded-md border border-destructive/25 bg-destructive/5 p-3"
                >
                  <p className="text-sm font-medium text-destructive">
                    {screeningFailure.title}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {screeningFailure.guidance}
                  </p>
                  {candidate.nextAction ? (
                    <p className="mt-1 text-xs font-medium">
                      下一步：{candidate.nextAction}
                    </p>
                  ) : null}
                  {candidate.resumeScreeningNextAttemptAt ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      预计重试：
                      {new Date(
                        candidate.resumeScreeningNextAttemptAt,
                      ).toLocaleString('zh-CN')}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </section>

            {candidate.semanticEvaluations.length > 0 ? (
              <section>
                <div className="mb-2">
                  <h3 className="text-sm font-semibold">智能识别结果</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    “试运行”结果仅供核对，不会改变当前筛选结论；所有结果都必须有简历原文证据。
                  </p>
                </div>
                <div className="space-y-2">
                  {candidate.semanticEvaluations.map((item) => (
                    <div
                      key={item.criterionId}
                      className="rounded-lg border bg-muted/20 p-3"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">
                          {semanticCriterionLabel(candidate, item.criterionId)}
                        </span>
                        <Badge
                          variant={
                            item.result === 'matched' ? 'secondary' : 'outline'
                          }
                        >
                          {item.result === 'matched'
                            ? '符合'
                            : item.result === 'not_matched'
                              ? '不符合'
                              : '待人工复核'}
                        </Badge>
                        {item.runtimeMode === 'shadow' ? (
                          <Badge variant="outline">试运行</Badge>
                        ) : (
                          <Badge variant="secondary">已生效</Badge>
                        )}
                        {item.extractor === 'llm' ? (
                          <Badge variant="outline">大模型分析</Badge>
                        ) : null}
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {Math.round(item.confidence * 100)}%
                        </span>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        识别方式：{extractorLabel[item.extractor]}
                        {item.modelVersion
                          ? ` · 模型 ${item.modelVersion}`
                          : ''}
                      </p>
                      {item.normalizedValue !== null ? (
                        <div className="mt-2 text-sm">
                          <span className="font-medium">识别结果：</span>
                          {normalizedValueSummary(item.normalizedValue)}
                          {typeof item.normalizedValue === 'object' ? (
                            <details className="mt-2 rounded border bg-background p-2 text-xs">
                              <summary className="cursor-pointer font-medium">
                                查看技术识别数据
                              </summary>
                              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">
                                {JSON.stringify(item.normalizedValue, null, 2)}
                              </pre>
                            </details>
                          ) : null}
                        </div>
                      ) : null}
                      {item.evidence.length > 0 ? (
                        <div className="mt-2 space-y-1">
                          {item.evidence.map((evidence) => (
                            <p
                              key={evidence}
                              className="rounded border bg-card p-2 text-sm leading-6"
                            >
                              {evidence}
                            </p>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-2 text-xs text-warning-foreground">
                          没有可验证原文，结果不会自动通过或淘汰。
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <section>
              <h3 className="mb-2 text-sm font-semibold">候选人列表字段</h3>
              <dl className="grid gap-2 rounded-lg border bg-muted/30 p-3 sm:grid-cols-2">
                {Object.entries(candidate.fields).map(([key, value]) => (
                  <div key={key}>
                    <dt className="text-xs text-muted-foreground">
                      {fieldLabel(key)}
                    </dt>
                    <dd className="mt-0.5 text-sm">{value}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold">原文证据</h3>
              <div className="space-y-2">
                {candidate.evidence.length > 0 ? (
                  candidate.evidence.map((item) => (
                    <p
                      key={item}
                      className="rounded-lg border bg-card p-3 text-sm leading-6"
                    >
                      {item}
                    </p>
                  ))
                ) : (
                  <p className="rounded-lg border border-warning/30 bg-warning/8 p-3 text-sm">
                    当前候选人卡片没有提供可核对的原文。
                  </p>
                )}
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold">筛选条件核对</h3>
              {candidate.matchEvidence.length > 0 ? (
                <div className="space-y-2">
                  {candidate.matchEvidence.map((item) => (
                    <div
                      key={`${item.normalizedAlias}-${item.sourceText}`}
                      className="rounded-lg border p-3"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-medium">
                          {candidateRuleEvidenceLabel(item)}
                        </span>
                        <Badge variant="outline">
                          {evidenceStatusLabel[item.status]}
                        </Badge>
                        <span className="tabular-nums">
                          {Math.round(item.confidence * 100)}%
                        </span>
                      </div>
                      <p className="mt-2 text-sm leading-6">
                        {candidateRuleEvidenceSourceText(item)}
                      </p>
                      <details className="mt-2 text-xs text-muted-foreground">
                        <summary className="cursor-pointer">
                          查看识别细节
                        </summary>
                        <p className="mt-1 break-words">
                          核对结果：
                          {candidateRuleEvidenceRecognitionLabel(
                            item.normalizedAlias,
                          )}
                          。
                        </p>
                      </details>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex gap-2 rounded-lg border border-warning/30 bg-warning/8 p-3 text-sm">
                  <ShieldAlert
                    className="mt-0.5 size-4 shrink-0"
                    aria-hidden="true"
                  />
                  暂未找到可确认的规则证据，请结合原文复核。
                </div>
              )}
            </section>

            {canReview ? (
              <section className="grid gap-3 sm:grid-cols-[1fr_220px]">
                <label
                  htmlFor="review-note"
                  className="space-y-1.5 text-sm font-medium"
                >
                  <span>审核备注（淘汰或人工改判时必填）</span>
                  <Textarea
                    id="review-note"
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder={
                      candidate.ruleDecision === 'matched'
                        ? '记录通过或淘汰原因，淘汰时必填'
                        : '通过或淘汰均需填写；通过时请说明机器结论为何不准确'
                    }
                  />
                </label>
                <label
                  htmlFor="correction-code"
                  className="space-y-1.5 text-sm font-medium"
                >
                  <span>
                    规则纠错类型
                    {candidate.ruleDecision === 'matched'
                      ? '（可选）'
                      : '（人工改判通过时必选）'}
                  </span>
                  <Select
                    value={correctionCode ?? 'none'}
                    onValueChange={(value) =>
                      setCorrectionCode(value === 'none' ? null : value)
                    }
                  >
                    <SelectTrigger id="correction-code" className="w-full">
                      <SelectValue placeholder="无需纠错" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">无需纠错</SelectItem>
                      <SelectItem value="alias_missing">别名遗漏</SelectItem>
                      <SelectItem value="negative_detection">
                        否定识别错误
                      </SelectItem>
                      <SelectItem value="concept_confusion">
                        概念混淆
                      </SelectItem>
                      <SelectItem value="other">其他</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
              </section>
            ) : (
              <p className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
                当前账号可查看证据，审核结论由 HR 或招聘负责人提交。
              </p>
            )}

            {candidate.reviews.length > 0 ? (
              <section>
                <h3 className="mb-2 text-sm font-semibold">历史审核</h3>
                <div className="space-y-2">
                  {candidate.reviews.map((reviewItem) => (
                    <div
                      key={reviewItem.id}
                      className="rounded-lg border p-3 text-xs"
                    >
                      <span className="font-medium">
                        {reviewItem.decision === 'approved'
                          ? '审核通过'
                          : '审核拒绝'}
                      </span>
                      <span className="ml-2 text-muted-foreground">
                        {safeIdentifierLabel(reviewItem.reviewerId)}
                      </span>
                      {reviewItem.note ? (
                        <p className="mt-1 leading-5">{reviewItem.note}</p>
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="px-6 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter className="shrink-0 flex-wrap items-center border-t bg-card px-6 py-4">
          {canReview && queueLabel ? (
            <label className="mr-auto flex min-h-11 items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={continueReviewing}
                onChange={(event) => setContinueReviewing(event.target.checked)}
                className="size-4 accent-primary"
              />
              审核后自动下一位
            </label>
          ) : null}
          {canReview &&
          canRetryScreening &&
          candidate &&
          canRetryResumeScreening(
            candidate.resumeScreeningStatus,
            candidate.resumeScreeningErrorCode ??
              candidate.resumeScreeningError,
          ) ? (
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => void requeueResumeScreening()}
            >
              重新精筛简历
            </Button>
          ) : null}
          {canReview ? (
            <>
              <Button
                type="button"
                variant="destructive"
                disabled={
                  !candidate ||
                  loading ||
                  submitting ||
                  ['not_requested', 'queued', 'processing'].includes(
                    candidate.resumeScreeningStatus,
                  )
                }
                onClick={() => void review('rejected')}
              >
                <XCircle aria-hidden="true" />
                人工淘汰
              </Button>
              <Button
                type="button"
                disabled={
                  !candidate ||
                  loading ||
                  submitting ||
                  ['not_requested', 'queued', 'processing'].includes(
                    candidate.resumeScreeningStatus,
                  )
                }
                onClick={() => void review('approved')}
              >
                {submitting ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : (
                  <CheckCircle2 aria-hidden="true" />
                )}
                {candidate?.ruleDecision === 'matched'
                  ? '通过审核'
                  : '人工改判为通过'}
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
