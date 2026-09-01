'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, LoaderCircle, ShieldAlert, XCircle } from 'lucide-react';

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

type CandidateDetail = {
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
  resumeScreenshotAvailable: boolean;
  fields: Record<string, string>;
  evidence: string[];
  rawText: string;
  ruleVersion: number;
  dictionaryVersion: string;
  matchEvidence: Array<{
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
};

async function responseJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { message?: string };
  if (!response.ok)
    throw new Error(payload.message ?? `HTTP ${response.status}`);
  return payload;
}

const decisionLabel = {
  matched: '符合',
  not_matched: '不符合',
  ambiguous: '有歧义',
  insufficient: '信息不足',
} as const;

const screeningLabel: Record<CandidateDetail['resumeScreeningStatus'], string> = {
  not_requested: '未安排简历精筛',
  queued: '等待简历预览',
  processing: '正在读取完整简历',
  screened: '完整简历已精筛',
  no_text: '简历已预览，OCR 无正文',
  failed: '简历精筛失败',
};

export function CandidateReviewDialog({
  open,
  stateId,
  controlApi,
  onOpenChange,
  onReviewed,
}: CandidateReviewDialogProps) {
  const [candidate, setCandidate] = useState<CandidateDetail | null>(null);
  const [note, setNote] = useState('');
  const [correctionCode, setCorrectionCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !stateId) return;
    const timer = window.setTimeout(() => {
      setCandidate(null);
      setLoading(true);
      setError(null);
      void fetch(`${controlApi}/api/candidate-position-states/${stateId}`, {
        cache: 'no-store',
      })
        .then((response) =>
          responseJson<{ candidate: CandidateDetail }>(response),
        )
        .then((payload) => setCandidate(payload.candidate))
        .catch((loadError: unknown) =>
          setError(
            loadError instanceof Error ? loadError.message : String(loadError),
          ),
        )
        .finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [controlApi, open, stateId]);

  async function review(decision: 'approved' | 'rejected') {
    if (!candidate || submitting) return;
    if (decision === 'rejected' && !note.trim()) {
      setError('拒绝候选人时请填写审核原因。');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(
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
      onOpenChange(false);
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
      const response = await fetch(
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
    if (!nextOpen) {
      setNote('');
      setCorrectionCode(null);
      setError(null);
    }
    onOpenChange(nextOpen);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{candidate?.name ?? '候选人详情'}</DialogTitle>
          <DialogDescription>
            {candidate
              ? `${candidate.positionName} · 规则 v${candidate.ruleVersion} · 词典 ${candidate.dictionaryVersion}`
              : '正在读取规则证据'}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="grid min-h-48 place-items-center text-sm text-muted-foreground">
            <LoaderCircle
              className="size-5 animate-spin"
              aria-label="正在加载"
            />
          </div>
        ) : candidate ? (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={
                  candidate.ruleDecision === 'matched' ? 'secondary' : 'outline'
                }
              >
                {decisionLabel[candidate.ruleDecision]}
              </Badge>
              <span className="text-sm font-medium tabular-nums">
                置信度 {Math.round(candidate.ruleConfidence * 100)}%
              </span>
              <span className="text-xs text-muted-foreground">
                状态版本 {candidate.stateVersion}
              </span>
              <Badge variant="outline">
                {screeningLabel[candidate.resumeScreeningStatus]}
              </Badge>
            </div>

            <section className="rounded-lg border bg-muted/30 p-3">
              <h3 className="text-sm font-semibold">识别到的英语等级</h3>
              <p className="mt-1 text-sm">
                {candidate.currentEnglishLevel ?? '完整简历中未识别到明确的英语证书或成绩'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                仅展示简历明确写出的考试等级/成绩，不在 TEM、CET、IELTS、TOEFL 之间进行等值换算。
                {candidate.resumeScreenshotAvailable ? ' 已保存简历预览截图。' : ''}
              </p>
              {candidate.resumeScreeningError ? (
                <p className="mt-2 text-xs text-destructive">
                  {candidate.resumeScreeningError}
                </p>
              ) : null}
            </section>

            {candidate.semanticEvaluations.length > 0 ? (
              <section>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">通用语义评估</h3>
                  <span className="text-xs text-muted-foreground">
                    模型结果必须有简历原文证据
                  </span>
                </div>
                <div className="space-y-2">
                  {candidate.semanticEvaluations.map((item) => (
                    <div
                      key={item.criterionId}
                      className="rounded-lg border bg-muted/20 p-3"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">
                          {item.criterionId}
                        </span>
                        <Badge variant="outline">{item.factType}</Badge>
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
                        {item.runtimeMode === 'shadow' &&
                        item.extractor === 'llm' ? (
                          <Badge variant="outline">影子模式</Badge>
                        ) : null}
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {Math.round(item.confidence * 100)}%
                        </span>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        提取器 {item.extractor}
                        {item.modelVersion ? ` · 模型 ${item.modelVersion}` : ''}
                        {` · 提示词 ${item.promptVersion}`}
                        {item.rubricVersion
                          ? ` · 评分标准 ${item.rubricVersion}`
                          : ''}
                      </p>
                      {item.normalizedValue !== null ? (
                        <pre className="mt-2 overflow-x-auto rounded bg-background p-2 text-xs">
                          {JSON.stringify(item.normalizedValue, null, 2)}
                        </pre>
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
                    <dt className="text-xs text-muted-foreground">{key}</dt>
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
                    当前候选人列表中没有 TEM8 相关原文。
                  </p>
                )}
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold">规则命中详情</h3>
              {candidate.matchEvidence.length > 0 ? (
                <div className="space-y-2">
                  {candidate.matchEvidence.map((item) => (
                    <div
                      key={`${item.normalizedAlias}-${item.sourceText}`}
                      className="rounded-lg border p-3"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <Badge variant="outline">{item.normalizedAlias}</Badge>
                        <span>{item.status}</span>
                        <span className="tabular-nums">
                          {Math.round(item.confidence * 100)}%
                        </span>
                      </div>
                      <p className="mt-2 text-sm leading-6">
                        {item.sourceText}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex gap-2 rounded-lg border border-warning/30 bg-warning/8 p-3 text-sm">
                  <ShieldAlert
                    className="mt-0.5 size-4 shrink-0"
                    aria-hidden="true"
                  />
                  规则未找到可确认的 TEM8 证据，请人工复核。
                </div>
              )}
            </section>

            <section className="grid gap-3 sm:grid-cols-[1fr_220px]">
              <label
                htmlFor="review-note"
                className="space-y-1.5 text-sm font-medium"
              >
                <span>审核备注</span>
                <Textarea
                  id="review-note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="记录通过/拒绝原因，拒绝时必填"
                />
              </label>
              <label
                htmlFor="correction-code"
                className="space-y-1.5 text-sm font-medium"
              >
                <span>规则纠错类型</span>
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
                    <SelectItem value="concept_confusion">概念混淆</SelectItem>
                    <SelectItem value="other">其他</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            </section>

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
                        {reviewItem.reviewerId}
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
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          {candidate &&
          !['queued', 'processing'].includes(candidate.resumeScreeningStatus) ? (
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => void requeueResumeScreening()}
            >
              重新精筛简历
            </Button>
          ) : null}
          <Button
            type="button"
            variant="destructive"
            disabled={
              !candidate ||
              submitting ||
              ['not_requested', 'queued', 'processing'].includes(
                candidate.resumeScreeningStatus,
              )
            }
            onClick={() => void review('rejected')}
          >
            <XCircle aria-hidden="true" />
            拒绝
          </Button>
          <Button
            type="button"
            disabled={
              !candidate ||
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
            通过审核
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
