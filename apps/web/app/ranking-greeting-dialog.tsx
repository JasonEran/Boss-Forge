'use client';

import { ContactDispatchControl } from './contact-dispatch-control';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCheck, LoaderCircle, RefreshCw, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import type { Candidate } from './dashboard-client';
import { apiFetch } from './api-client';
import { GreetingRequestError, waitForGreeting } from './greeting-request';
import {
  MessageTemplateEditor,
  type MessageTemplate,
} from './message-template-editor';
import { AssessmentScore } from './recruitment-assessment-panel';
import { Field, Notice } from './workspace-ui';
import {
  assertRankingGreetingPreview,
  greetingBatches,
  rankingGreetingBlockReason,
  type GreetingIntent,
  type RankingGreetingPreview,
} from './ranking-greeting-model';

async function json<T>(response: Response): Promise<T> {
  const result = (await response.json()) as T & {
    message?: string;
    code?: string;
  };
  if (!response.ok)
    throw new GreetingRequestError(
      result.message ?? `请求失败（${response.status}）`,
      result.code,
    );
  return result;
}

export function RankingGreetingDialog({
  candidates,
  task,
  intents,
  controlApi,
  hrName,
  onChanged,
  onClose,
}: {
  candidates: Candidate[];
  task: { id: string; positionId: string; positionName: string };
  intents: GreetingIntent[];
  controlApi: string;
  hrName: string;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(() =>
    candidates
      .filter((item) => !rankingGreetingBlockReason(item, intents))
      .slice(0, 200)
      .map((item) => item.stateId),
  );
  const [body, setBody] = useState('');
  const [needsGreetingSetup, setNeedsGreetingSetup] = useState(false);
  const [draftBody, setDraftBody] = useState(() => {
    const named = `你好，我们正在招聘${task.positionName}。看了你的经历，想邀请你进一步交流这个岗位。`;
    return named.length <= 100
      ? named
      : '你好，看了你的经历，感觉与我们正在招聘的岗位比较契合。方便进一步交流吗？';
  });
  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [interval, setInterval] = useState(10);
  const [previews, setPreviews] = useState<RankingGreetingPreview[]>([]);
  const [previewScope, setPreviewScope] = useState('');
  const [realContact, setRealContact] = useState(false);
  const [canDispatch, setCanDispatch] = useState(false);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [busy, setBusy] = useState<
    'read' | 'apply' | 'preview' | 'send' | null
  >(null);
  const [progress, setProgress] = useState<{
    label: string;
    value: number;
    max: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [submittedIds, setSubmittedIds] = useState<string[]>([]);
  const [greetingWait, setGreetingWait] = useState<number | null>(null);
  const greetingAbort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const lock = useRef(false);
  const confirmation = useRef<HTMLDivElement>(null);
  const selectedCandidates = candidates.filter((item) =>
    selected.includes(item.stateId),
  );
  const pending = selectedCandidates.filter(
    (item) => item.reviewStatus === 'pending',
  );
  const blockReason = (candidate: Candidate) =>
    submittedIds.includes(candidate.stateId)
      ? '已加入发送队列'
      : rankingGreetingBlockReason(candidate, intents);
  const available = candidates.filter((item) => !blockReason(item));
  const invalidSelection =
    selectedCandidates.length !== selected.length ||
    selectedCandidates.some((item) => blockReason(item));
  const scope = JSON.stringify({
    selected,
    body,
    interval,
    taskId: task.id,
    positionId: task.positionId,
  });
  const ready =
    !!previews.length &&
    canDispatch &&
    previewScope === scope &&
    !invalidSelection &&
    previews.every((item) => item.readiness.ready);
  const intervalValid =
    Number.isInteger(interval) && interval >= 10 && interval <= 600;
  const nativeTemplate =
    template?.body
      ?.replaceAll('{{position_name}}', task.positionName)
      .replaceAll('{{hr_name}}', hrName)
      .trim() ?? '';
  const templateValid =
    nativeTemplate.length >= 2 &&
    nativeTemplate.length <= 100 &&
    !nativeTemplate.includes('{{');
  const currentIntents = intents.filter(
    (item) =>
      item.actionKind === 'greet' &&
      candidates.some(
        (candidate) => candidate.stateId === item.candidateStateId,
      ),
  );
  const queueCount = currentIntents.filter((item) =>
    ['ready', 'processing'].includes(item.status),
  ).length;
  const completedCount = currentIntents.filter((item) =>
    ['sent', 'simulated', 'failed', 'uncertain', 'cancelled'].includes(
      item.status,
    ),
  ).length;

  const readGreeting = useCallback(async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy('read');
    setGreetingWait(null);
    const controller = new AbortController();
    greetingAbort.current = controller;
    setNeedsGreetingSetup(false);
    setMessage(null);
    setError(null);
    setPreviews([]);
    setBody('');
    try {
      const result = await waitForGreeting(
        async (signal) =>
          json<{
            configured?: boolean;
            preview: { body: string } | null;
          }>(
            await apiFetch(
              `${controlApi}/api/positions/${task.positionId}/boss-greeting`,
              { cache: 'no-store', signal },
              45000,
            ),
          ),
        { signal: controller.signal, onWait: setGreetingWait },
      );
      if (mounted.current) {
        if (result.configured === false && result.preview === null)
          setNeedsGreetingSetup(true);
        else if (result.preview?.body) setBody(result.preview.body);
        else throw new Error('BOSS 返回的招呼语不完整，请重新读取。');
      }
    } catch (failure) {
      if (mounted.current)
        setError(
          failure instanceof Error
            ? failure.message.includes('greeting_unavailable')
              ? '读取 BOSS 招呼语失败，请稍后重新读取。'
              : failure.message
            : '读取招呼语失败，请重试。',
        );
    } finally {
      lock.current = false;
      if (mounted.current) {
        setBusy(null);
        setGreetingWait(null);
      }
    }
  }, [controlApi, task.positionId]);

  useEffect(() => {
    mounted.current = true;
    const timer = window.setTimeout(() => void readGreeting(), 0);
    return () => {
      mounted.current = false;
      greetingAbort.current?.abort();
      window.clearTimeout(timer);
    };
  }, [readGreeting]);

  async function applyGreeting(content = nativeTemplate) {
    if (
      lock.current ||
      content.trim().length < 2 ||
      content.trim().length > 100 ||
      content.includes('{{')
    )
      return;
    lock.current = true;
    setBusy('apply');
    setGreetingWait(null);
    const controller = new AbortController();
    greetingAbort.current = controller;
    setMessage(null);
    setError(null);
    setPreviews([]);
    try {
      const result = await waitForGreeting(
        async (signal) =>
          json<{ preview: { body: string } }>(
            await apiFetch(
              `${controlApi}/api/positions/${task.positionId}/boss-greeting`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  body: content.trim(),
                  confirmUpdate: true,
                }),
                signal,
              },
              45000,
            ),
          ),
        { signal: controller.signal, onWait: setGreetingWait },
      );
      if (!mounted.current) return;
      setBody(result.preview.body);
      setNeedsGreetingSetup(false);
      setMessage('已更新 BOSS 岗位招呼语，下方参考内容已同步。');
    } catch (failure) {
      if (!mounted.current) return;
      setBody('');
      setError(
        failure instanceof Error
          ? failure.message
          : '保存结果未确认，请重新读取。',
      );
    } finally {
      lock.current = false;
      if (mounted.current) {
        setBusy(null);
        setGreetingWait(null);
      }
    }
  }

  async function preview() {
    if (
      lock.current ||
      !selected.length ||
      invalidSelection ||
      !body ||
      !intervalValid ||
      (pending.length && !reviewConfirmed)
    )
      return;
    lock.current = true;
    setBusy('preview');
    setError(null);
    setMessage(null);
    setPreviews([]);
    let reviewed = 0;
    try {
      for (const candidate of pending) {
        setProgress({
          label: '保存审核结果',
          value: reviewed,
          max: pending.length,
        });
        await json(
          await apiFetch(
            `${controlApi}/api/candidate-position-states/${candidate.stateId}/reviews`,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'Idempotency-Key': `ranking-greet-review:${candidate.stateId}:${candidate.stateVersion}`,
              },
              body: JSON.stringify({
                decision: 'approved',
                expectedVersion: candidate.stateVersion,
                note: 'HR 在规则通过 AI 排名中查看名单并确认批量联系。',
              }),
            },
          ),
        );
        reviewed += 1;
      }
      const all: RankingGreetingPreview[] = [];
      let mode: boolean | undefined;
      let dispatch: boolean | undefined;
      for (const stateIds of greetingBatches(selected)) {
        setProgress({
          label: '核对收件人和招呼语',
          value: all.length,
          max: selected.length,
        });
        const result = await json<{
          previews: RankingGreetingPreview[];
          realContact: boolean;
          dispatchMode: string;
        }>(
          await apiFetch(`${controlApi}/api/contact-batches/preview`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ stateIds, actionKind: 'greet' }),
          }),
        );
        assertRankingGreetingPreview(result.previews, {
          stateIds,
          taskId: task.id,
          positionId: task.positionId,
          body,
        });
        if (mode !== undefined && mode !== result.realContact)
          throw new Error('发送模式已变化，请重新预览。');
        const dispatchAllowed =
          result.realContact || result.dispatchMode === 'fake';
        if (dispatch !== undefined && dispatch !== dispatchAllowed)
          throw new Error('发送模式已变化，请重新预览。');
        dispatch = dispatchAllowed;
        mode = result.realContact;
        all.push(...result.previews);
      }
      setPreviews(all);
      setPreviewScope(scope);
      setRealContact(mode === true);
      setCanDispatch(dispatch === true);
      window.setTimeout(() => confirmation.current?.focus(), 0);
    } catch (failure) {
      setError(
        `${failure instanceof Error ? failure.message : '预览失败'}${reviewed ? ` 已保存 ${reviewed} 人的审核结果，尚未发送招呼。` : ''}`,
      );
    } finally {
      // Refresh even after a partial failure: approvals already saved must be visible.
      try {
        await onChanged();
      } finally {
        lock.current = false;
        setBusy(null);
        setProgress(null);
      }
    }
  }

  async function send() {
    if (lock.current || !ready) return;
    lock.current = true;
    setBusy('send');
    setError(null);
    setMessage(null);
    const submitted: string[] = [];
    try {
      assertRankingGreetingPreview(previews, {
        stateIds: selected,
        taskId: task.id,
        positionId: task.positionId,
        body,
      });
      const batchId = crypto.randomUUID();
      for (const batch of greetingBatches(previews)) {
        if (
          realContact &&
          batch.some(
            (item) =>
              !item.approval ||
              Date.parse(item.approval.expiresAt) <= Date.now(),
          )
        )
          throw new Error('预览已过期，请重新预览剩余候选人。');
        setProgress({
          label: '加入发送队列',
          value: submitted.length,
          max: selected.length,
        });
        const stateIds = batch.map((item) => item.preview.candidateStateId);
        const result = await json<{
          submitted: number;
          requested: number;
          results: { stateId: string; intentId?: string; error?: string }[];
        }>(
          await apiFetch(`${controlApi}/api/contact-batches`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              batchId,
              stateIds,
              actionKind: 'greet',
              intervalSeconds: interval,
              confirmRealContact: realContact,
              tokens: Object.fromEntries(
                batch.map((item) => [
                  item.preview.candidateStateId,
                  item.approval?.token,
                ]),
              ),
            }),
          }),
        );
        submitted.push(
          ...result.results
            .filter((item) => item.intentId && stateIds.includes(item.stateId))
            .map((item) => item.stateId),
        );
        setSubmittedIds((current) => [...new Set([...current, ...submitted])]);
        if (result.submitted !== stateIds.length)
          throw new Error('部分候选人状态已变化，已停止提交后续批次。');
      }
      setMessage(
        `已加入发送队列 ${submitted.length} 人，相邻任务至少间隔 ${interval} 秒启动，上一人完成后继续，处理时间计入间隔。可以关闭窗口，后台会继续执行。`,
      );
      setSelected([]);
    } catch (failure) {
      setError(
        `${failure instanceof Error ? failure.message : '提交结果未确认'} 已确认入队 ${submitted.length} 人。请查看联系记录，核对剩余名单后重新预览。`,
      );
      setSelected((current) => current.filter((id) => !submitted.includes(id)));
    } finally {
      setPreviews([]);
      try {
        await onChanged();
      } finally {
        lock.current = false;
        setBusy(null);
        setProgress(null);
      }
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && (!lock.current || busy === 'read')) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
        showCloseButton={!busy}
      >
        <DialogHeader className="border-b p-5 pr-12">
          <DialogTitle>一键打招呼</DialogTitle>
          <DialogDescription>
            {task.positionName} · 当前排名名单 {candidates.length}{' '}
            人（含全部分页）。确认文案与名单后，按 AI 排名依次联系。
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto p-4 sm:p-5">
          <Notice error={error} message={message} errorHint={null} />
          {progress ? (
            <output className="block space-y-2 text-sm">
              <p>
                {progress.label} · {progress.value}/{progress.max} 人
              </p>
              <Progress
                value={progress.value}
                max={progress.max}
                aria-label={progress.label}
              />
            </output>
          ) : null}
          {greetingWait !== null || busy === 'apply' ? (
            <output className="flex items-center gap-2 rounded-lg bg-muted p-3 text-sm">
              <LoaderCircle
                className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              {greetingWait !== null
                ? `BOSS 正在处理其他操作，正在等待空闲后${busy === 'apply' ? '应用' : '读取'}招呼语…已等待 ${greetingWait} 秒，最多等待 2 分钟。`
                : '正在应用招呼语并核对 BOSS 保存结果…'}
            </output>
          ) : null}
          <div className="grid items-start gap-4 md:grid-cols-2">
            <div className="space-y-4 md:order-2">
              <section
                className="space-y-3 rounded-xl border bg-muted/20 p-4"
                aria-label="招呼消息参考"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-semibold">招呼消息参考</h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!!busy}
                    onClick={() => void readGreeting()}
                  >
                    <RefreshCw className="size-4" aria-hidden="true" />
                    重新读取
                  </Button>
                </div>
                {busy === 'read' ? (
                  <output className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                    <LoaderCircle
                      className="size-4 animate-spin"
                      aria-hidden="true"
                    />
                    正在读取 BOSS 岗位招呼语…
                  </output>
                ) : body ? (
                  <p className="whitespace-pre-wrap break-words rounded-lg bg-card p-3 text-sm leading-6">
                    {body}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {needsGreetingSetup ? (
                      <output className="block rounded-lg bg-muted p-3 text-sm leading-6">
                        该岗位还没有专属招呼语。请确认或修改下方参考消息，再点击“应用参考消息到
                        BOSS”完成首次设置。
                      </output>
                    ) : null}
                    <Field
                      label="建议参考消息（尚未应用）"
                      hint="可以修改为 2–100 字。应用后会成为此 BOSS 岗位的首次招呼语。"
                    >
                      <Textarea
                        value={draftBody}
                        aria-label="参考招呼消息"
                        maxLength={100}
                        disabled={!!busy}
                        onChange={(event) => setDraftBody(event.target.value)}
                      />
                    </Field>
                    <Button
                      variant="outline"
                      disabled={
                        !!busy ||
                        draftBody.trim().length < 2 ||
                        draftBody.trim().length > 100 ||
                        draftBody.includes('{{')
                      }
                      onClick={() => void applyGreeting(draftBody)}
                    >
                      应用参考消息到 BOSS
                    </Button>
                  </div>
                )}
                {body ? (
                  <p className="text-xs leading-5 text-muted-foreground">
                    这是 BOSS
                    当前已生效的岗位招呼语，所有所选候选人收到同一条首次招呼。
                  </p>
                ) : null}
              </section>
              <details className="rounded-xl border p-4">
                <summary className="cursor-pointer text-sm font-medium">
                  更换招呼语 / 使用快捷模板
                </summary>
                <fieldset disabled={!!busy} className="mt-4 min-w-0 space-y-3">
                  <MessageTemplateEditor
                    compact
                    controlApi={controlApi}
                    canManage
                    positionId={task.positionId}
                    onSelected={setTemplate}
                  />
                  {nativeTemplate ? (
                    <p className="whitespace-pre-wrap break-words rounded-lg bg-muted/30 p-3 text-sm leading-6">
                      {nativeTemplate}
                    </p>
                  ) : null}
                  <p className="text-xs leading-5 text-muted-foreground">
                    保存模板后点击应用，将修改此 BOSS 岗位后续首次招呼。需 2–100
                    字，不含候选人姓名变量。
                  </p>
                  <Button
                    variant="outline"
                    disabled={!!busy || !templateValid}
                    onClick={() => void applyGreeting()}
                  >
                    应用到 BOSS 岗位招呼语
                  </Button>
                </fieldset>
              </details>
              <ContactDispatchControl key={task.positionId} positionId={task.positionId} controlApi={controlApi} />
              <Field
                label="启动间隔（秒）"
                hint="相邻任务至少间隔 10–600 秒启动，处理时间计入间隔。上一人完成后继续，可在“联系”页面查看进度。"
              >
                <Input
                  type="number"
                  min={10}
                  max={600}
                  step={1}
                  value={interval}
                  disabled={!!busy}
                  onChange={(event) => {
                    setInterval(Number(event.target.value));
                    setPreviews([]);
                  }}
                />
              </Field>
            </div>
            <section
              className="overflow-hidden rounded-xl border md:order-1"
              aria-label="本次招呼名单"
            >
              <div className="space-y-3 border-b p-4">
                <h3 className="font-semibold">已选择 {selected.length} 人</h3>
                <p className="text-xs leading-5 text-muted-foreground">
                  可联系 {available.length} 人 · 跳过{' '}
                  {candidates.length - available.length} 人。超过 20
                  人自动分批提交，最多选择 200 人。
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!!busy || !available.length}
                    onClick={() => {
                      setSelected(
                        available.slice(0, 200).map((item) => item.stateId),
                      );
                      setPreviews([]);
                      setReviewConfirmed(false);
                    }}
                  >
                    <CheckCheck className="size-4" aria-hidden="true" />
                    全选可联系人
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!!busy || !selected.length}
                    onClick={() => {
                      setSelected([]);
                      setPreviews([]);
                      setReviewConfirmed(false);
                    }}
                  >
                    清空
                  </Button>
                </div>
              </div>
              <div className="max-h-80 divide-y overflow-y-auto">
                {candidates.map((candidate) => {
                  const reason = blockReason(candidate);
                  return (
                    <label
                      key={candidate.stateId}
                      className={`flex min-h-20 items-start gap-3 p-4 ${selected.includes(candidate.stateId) ? 'bg-primary/5' : ''}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-1 size-4 accent-primary"
                        aria-label={`选择 ${candidate.name}`}
                        checked={selected.includes(candidate.stateId)}
                        disabled={
                          !!busy ||
                          !!reason ||
                          (!selected.includes(candidate.stateId) &&
                            selected.length >= 200)
                        }
                        onChange={(event) => {
                          setSelected((current) =>
                            event.target.checked
                              ? candidates
                                  .filter(
                                    (item) =>
                                      current.includes(item.stateId) ||
                                      item.stateId === candidate.stateId,
                                  )
                                  .map((item) => item.stateId)
                              : current.filter(
                                  (id) => id !== candidate.stateId,
                                ),
                          );
                          setPreviews([]);
                          setReviewConfirmed(false);
                        }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center justify-between gap-2">
                          <strong className="text-sm">{candidate.name}</strong>
                          <AssessmentScore assessment={candidate.assessment} />
                        </span>
                        <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                          {reason ??
                            (candidate.reviewStatus === 'pending'
                              ? '待人工确认 · 下一步将审核通过'
                              : '人工已通过，可以联系')}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </section>
          </div>
          {pending.length ? (
            <label className="flex items-start gap-3 rounded-xl border bg-muted/25 p-4 text-sm leading-6">
              <input
                type="checkbox"
                className="mt-1 size-4 accent-primary"
                checked={reviewConfirmed}
                disabled={!!busy}
                onChange={(event) => setReviewConfirmed(event.target.checked)}
              />
              我已查看名单，同意将所选 {pending.length}{' '}
              位待审核候选人标记为人工通过，再预览招呼。
            </label>
          ) : null}
          {invalidSelection ? (
            <p role="alert" className="text-sm text-destructive">
              部分候选人状态已变化，请点击“全选可联系人”更新名单。
            </p>
          ) : null}
          {previews.length && previewScope === scope ? (
            <div
              ref={confirmation}
              tabIndex={-1}
              className="space-y-4 rounded-xl border bg-card p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <h3 className="font-semibold">
                发送前确认 ·{' '}
                {realContact
                  ? '将通过 BOSS 真实发送'
                  : canDispatch
                    ? '模拟发送'
                    : '仅预览，发送未开启'}{' '}
                {previews.length} 人
              </h3>
              <p className="whitespace-pre-wrap break-words rounded-lg bg-muted/30 p-3 text-sm leading-6">
                {body}
              </p>
              <div className="max-h-60 divide-y overflow-y-auto">
                {previews.map((item) => (
                  <div
                    key={item.preview.candidateStateId}
                    className="space-y-1 py-2 text-sm"
                  >
                    <p>
                      {item.preview.candidateName} ·{' '}
                      {item.readiness.ready ? '可以发送' : '暂不可发送'}
                    </p>
                    {item.readiness.checks
                      .filter((check) => !check.passed)
                      .map((check) => (
                        <p
                          key={check.label}
                          className="text-xs text-destructive"
                        >
                          {check.label}：{check.detail}
                        </p>
                      ))}
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                共 {previews.length} 人，相邻任务至少间隔 {interval} 秒启动，处理时间计入间隔。
                {!ready ? '请先处理未通过的检查，再重新预览。' : ''}
              </p>
              <Button
                className="w-full sm:w-auto"
                disabled={!!busy || !ready}
                onClick={() => void send()}
              >
                <Send aria-hidden="true" />
                确认并{realContact ? '发送' : '模拟'} {previews.length} 人
              </Button>
            </div>
          ) : (
            <Button
              className="w-full"
              disabled={
                !!busy ||
                !selected.length ||
                invalidSelection ||
                !body ||
                !intervalValid ||
                (pending.length > 0 && !reviewConfirmed)
              }
              onClick={() => void preview()}
            >
              {busy === 'preview' ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <Send aria-hidden="true" />
              )}
              {pending.length
                ? '通过所选审核并预览'
                : `预览 ${selected.length} 人的招呼语`}
            </Button>
          )}
          {currentIntents.length ? (
            <div
              className="space-y-2 rounded-xl border p-4 text-sm"
              aria-live="polite"
            >
              <p>
                后台招呼进度 · 等待 / 执行 {queueCount} 人 · 已结束{' '}
                {completedCount} 人
              </p>
              <Progress
                value={completedCount}
                max={currentIntents.length}
                aria-label="后台招呼进度"
              />
              <p className="text-xs text-muted-foreground">
                已发送{' '}
                {currentIntents.filter((item) => item.status === 'sent').length}{' '}
                · 模拟{' '}
                {
                  currentIntents.filter((item) => item.status === 'simulated')
                    .length
                }{' '}
                · 失败 / 待核实{' '}
                {
                  currentIntents.filter((item) =>
                    ['failed', 'uncertain'].includes(item.status),
                  ).length
                }
              </p>
            </div>
          ) : null}
        </div>
        <div className="flex items-center justify-between gap-3 border-t bg-muted/20 p-4">
          <p className="text-xs text-muted-foreground">
            触发 BOSS 限制或发送结果不确定时，后台会暂停。
          </p>
          <Button
            variant="outline"
            disabled={!!busy && busy !== 'read'}
            onClick={() => {
              onClose();
            }}
          >
            关闭
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
