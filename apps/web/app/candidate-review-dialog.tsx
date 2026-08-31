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
            </div>

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
          <Button
            type="button"
            variant="destructive"
            disabled={!candidate || submitting}
            onClick={() => void review('rejected')}
          >
            <XCircle aria-hidden="true" />
            拒绝
          </Button>
          <Button
            type="button"
            disabled={!candidate || submitting}
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
