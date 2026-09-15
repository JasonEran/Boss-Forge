'use client';

import { ContactDispatchControl } from './contact-dispatch-control';

import { Progress } from '@/components/ui/progress';

import { useState } from 'react';
import { LoaderCircle, Send, CheckCheck, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  MessageTemplateEditor,
  type MessageTemplate,
} from './message-template-editor';
import type { Candidate } from './dashboard-client';
import { apiFetch } from './api-client';
import { Field, Notice, inputClass } from './workspace-ui';
import { AssessmentScore } from './recruitment-assessment-panel';

type Intent = {
  id: string;
  candidateStateId: string;
  candidateName: string;
  actionKind: string;
  status: string;
  lastError: string | null;
};
type Preview = {
  preview: {
    candidateStateId: string;
    candidateName: string;
    positionId: string;
    taskId: string;
    actionKind: string;
    renderedMessage: string;
    templateVersionId: string | null;
  };
  readiness: {
    ready: boolean;
    checks: { passed: boolean; label: string; detail: string }[];
  };
  approval: { token: string; expiresAt: string } | null;
};
async function json<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { message?: string };
  if (!response.ok)
    throw new Error(body.message ?? `请求失败（${response.status}）`);
  return body;
}

export function BatchContactWorkspace({
  candidates,
  positionId,
  positionName,
  hrName,
  controlApi,
  intents,
  canManage,
  onCreated,
}: {
  candidates: Candidate[];
  positionId: string;
  positionName: string;
  hrName: string;
  controlApi: string;
  intents: Intent[];
  canManage: boolean;
  onCreated: () => Promise<void>;
}) {
  const [action, setAction] = useState<'greet' | 'message'>('greet');
  const [selected, setSelected] = useState<string[]>([]);
  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [previewScope, setPreviewScope] = useState('');
  const [realContact, setRealContact] = useState(false);
  const [interval, setInterval] = useState(10);
  const [busy, setBusy] = useState<
    'preview' | 'send' | 'apply' | 'cancel' | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const sorted = [...candidates].sort(
    (a, b) =>
      (b.assessment?.result?.score ?? -1) - (a.assessment?.result?.score ?? -1),
  );
  const active = (id: string) =>
    intents.some(
      (item) =>
        item.candidateStateId === id &&
        item.actionKind === action &&
        ['ready', 'processing', 'sent', 'uncertain', 'simulated'].includes(
          item.status,
        ),
    );
  const available = sorted.filter((item) => !active(item.stateId));
  const nativeBody =
    template?.body
      ?.replaceAll('{{position_name}}', positionName)
      .replaceAll('{{hr_name}}', hrName)
      .trim() ?? '';
  const nativeValid =
    nativeBody.length >= 2 &&
    nativeBody.length <= 100 &&
    !nativeBody.includes('{{');
  const scope = JSON.stringify({
    selected,
    action,
    template: template?.activeVersionId,
    interval,
  });
  const readyToSend =
    previews.length === selected.length &&
    selected.length > 0 &&
    previewScope === scope &&
    previews.every((item) => item.readiness.ready);
  const queue = intents.filter((item) =>
    ['ready', 'processing'].includes(item.status),
  );
  const finished = intents.filter((item) =>
    ['sent', 'simulated', 'failed', 'uncertain', 'cancelled'].includes(
      item.status,
    ),
  );

  async function applyGreeting() {
    if (!nativeValid || busy) return;
    setBusy('apply');
    setError(null);
    setMessage(null);
    setPreviews([]);
    try {
      await json(
        await apiFetch(
          `${controlApi}/api/positions/${positionId}/boss-greeting`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ body: nativeBody, confirmUpdate: true }),
          },
        ),
      );
      setMessage(
        '已保存并读回确认 BOSS 岗位招呼语。现在可以勾选候选人并预览。',
      );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'BOSS 保存未确认，请重新读取后再发送。',
      );
    } finally {
      setBusy(null);
    }
  }
  async function preview() {
    if (!selected.length || !template?.activeVersionId || busy) return;
    setBusy('preview');
    setError(null);
    setMessage(null);
    setPreviews([]);
    try {
      const body = await json<{ previews: Preview[]; realContact: boolean }>(
        await apiFetch(`${controlApi}/api/contact-batches/preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            stateIds: selected,
            actionKind: action,
            templateVersionId: template.activeVersionId,
          }),
        }),
      );
      if (
        body.previews.length !== selected.length ||
        body.previews.some(
          (item) =>
            !selected.includes(item.preview.candidateStateId) ||
            item.preview.positionId !== positionId ||
            item.preview.actionKind !== action,
        )
      )
        throw new Error('预览名单与当前选择不一致，请刷新。');
      if (
        action === 'greet' &&
        body.previews.some(
          (item) => item.preview.renderedMessage !== nativeBody,
        )
      )
        throw new Error(
          'BOSS 当前招呼语与选中模板不同，请先点击“应用到 BOSS 岗位招呼语”，再重新预览。',
        );
      setRealContact(body.realContact);
      setPreviews(body.previews);
      setPreviewScope(scope);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '预览失败');
    } finally {
      setBusy(null);
    }
  }
  async function send() {
    if (!readyToSend || busy) return;
    if (
      realContact &&
      previews.some(
        (item) =>
          !item.approval || Date.parse(item.approval.expiresAt) <= Date.now(),
      )
    ) {
      setError('预览已过期，请重新预览后发送。');
      setPreviews([]);
      return;
    }
    setBusy('send');
    setError(null);
    setMessage(null);
    try {
      const result = await json<{ submitted: number; requested: number }>(
        await apiFetch(`${controlApi}/api/contact-batches`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            batchId: crypto.randomUUID(),
            stateIds: selected,
            actionKind: action,
            templateVersionId: template?.activeVersionId,
            intervalSeconds: interval,
            confirmRealContact: realContact,
            tokens: Object.fromEntries(
              previews.map((item) => [
                item.preview.candidateStateId,
                item.approval?.token,
              ]),
            ),
          }),
        }),
      );
      setMessage(
        `已加入发送队列 ${result.submitted}/${result.requested} 人。相邻任务至少间隔 ${interval} 秒启动，上一人完成后继续，可在下方跟踪。${result.submitted < result.requested ? '部分候选人状态发生变化，请刷新后重新选择。' : ''}`,
      );
      setSelected([]);
      setPreviews([]);
      await onCreated();
    } catch (failure) {
      setError(
        `${failure instanceof Error ? failure.message : '提交响应未确认'} 请先查看执行记录，已创建的任务不会重复发送。`,
      );
      setPreviews([]);
      await onCreated();
    } finally {
      setBusy(null);
    }
  }
  async function cancelQueued() {
    setBusy('cancel');
    setError(null);
    let count = 0;
    try {
      for (const item of queue.filter((item) => item.status === 'ready')) {
        await json(
          await apiFetch(
            `${controlApi}/api/contact-intents/${item.id}/cancel`,
            { method: 'POST' },
          ),
        );
        count += 1;
      }
      setMessage(
        `已取消 ${count} 条待发送任务。正在执行的任务以最终回执为准。`,
      );
    } catch (failure) {
      setError(
        `${failure instanceof Error ? failure.message : '取消未完成'}，已取消 ${count} 条。`,
      );
    } finally {
      await onCreated();
      setBusy(null);
    }
  }
  return (
    <section className="mb-4 space-y-4" aria-label="批量联系工作区">
      <Notice error={error} message={message} />
      <ContactDispatchControl key={positionId} positionId={positionId} controlApi={controlApi} />
      <div className="grid items-start gap-4 xl:grid-cols-[1.15fr_.85fr]">
        <div className="overflow-hidden rounded-xl border bg-card">
          <div
            className="space-y-3 border-b p-4"
            data-spotlight="contact-approved"
          >
            <h2 className="text-base font-semibold">选择已审核通过的候选人</h2>
            <p className="text-xs text-muted-foreground">
              {positionName} · 已选择 {selected.length}/20 人 · 按 AI 匹配分排序
            </p>
            <fieldset className="flex flex-wrap gap-2" aria-label="联系动作">
              {(['greet', 'message'] as const).map((value) => (
                <Button
                  key={value}
                  variant={action === value ? 'default' : 'outline'}
                  disabled={!!busy}
                  aria-pressed={action === value}
                  onClick={() => {
                    setAction(value);
                    setSelected([]);
                    setPreviews([]);
                  }}
                >
                  {value === 'greet' ? '首次打招呼' : '发送消息'}
                </Button>
              ))}
            </fieldset>
            <p className="text-xs leading-5 text-muted-foreground">
              {action === 'greet'
                ? '使用这个 BOSS 岗位已生效的招呼语，不会连带发送第二条消息。'
                : '使用快捷模板替换姓名后发消息，需要 BOSS 中已有可用会话。'}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!!busy || !available.length}
                onClick={() => {
                  setSelected(
                    available.slice(0, 20).map((item) => item.stateId),
                  );
                  setPreviews([]);
                }}
              >
                <CheckCheck aria-hidden="true" />
                选择前 {Math.min(20, available.length)} 人
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!!busy || !selected.length}
                onClick={() => {
                  setSelected([]);
                  setPreviews([]);
                }}
              >
                清空选择
              </Button>
            </div>
          </div>
          <div className="max-h-[60vh] divide-y overflow-y-auto">
            {sorted.length ? (
              sorted.map((candidate) => (
                <label
                  key={candidate.stateId}
                  className={`flex min-h-20 items-start gap-3 p-4 ${selected.includes(candidate.stateId) ? 'bg-primary/5' : 'hover:bg-muted/30'}`}
                >
                  <input
                    className="mt-1 size-4 accent-primary"
                    type="checkbox"
                    checked={selected.includes(candidate.stateId)}
                    disabled={
                      !!busy ||
                      active(candidate.stateId) ||
                      (!selected.includes(candidate.stateId) &&
                        selected.length >= 20)
                    }
                    onChange={(event) => {
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, candidate.stateId]
                          : current.filter((id) => id !== candidate.stateId),
                      );
                      setPreviews([]);
                    }}
                    aria-label={`选择 ${candidate.name}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <strong className="text-sm">{candidate.name}</strong>
                      <AssessmentScore assessment={candidate.assessment} />
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {active(candidate.stateId)
                        ? '已有发送记录或执行中，本次不可重复选择'
                        : (candidate.assessment?.result?.summary ??
                          '人工已通过，等待联系')}
                    </span>
                  </span>
                </label>
              ))
            ) : (
              <p className="p-8 text-center text-sm text-muted-foreground">
                候选人经人工审核通过后，会出现在这里。
              </p>
            )}
          </div>
          <div className="space-y-4 rounded-xl border bg-card p-4">
            <Field
              label="启动间隔（秒）"
              hint="相邻任务至少间隔 10–600 秒启动，处理时间计入间隔。上一人完成后继续；结果不确定时暂停。"
            >
              <input
                className={inputClass}
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
            <p className="text-xs leading-5 text-muted-foreground">
              间隔不代表 BOSS 官方许可，也无法保证不触发账号或 IP
              限制。请确认账号允许的沟通额度和平台规则。
            </p>
            <Button
              className="w-full"
              disabled={
                !!busy ||
                !selected.length ||
                !template?.activeVersionId ||
                interval < 10 ||
                interval > 600 ||
                !Number.isInteger(interval) ||
                (action === 'greet' && !nativeValid)
              }
              onClick={() => void preview()}
            >
              {busy === 'preview' ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <Send aria-hidden="true" />
              )}
              预览 {selected.length} 人的
              {action === 'greet' ? '招呼语' : '消息'}
            </Button>
          </div>
        </div>
        <div className="space-y-4">
          <MessageTemplateEditor
            compact
            controlApi={controlApi}
            canManage={canManage}
            positionId={positionId}
            onSelected={setTemplate}
          />
          {action === 'greet' ? (
            <div className="space-y-3 rounded-xl border bg-card p-4">
              <h3 className="text-sm font-semibold">BOSS 岗位招呼语</h3>
              <p className="text-xs leading-5 text-muted-foreground">
                应用后会修改 BOSS 中“{positionName}
                ”的岗位招呼语，影响此岗位后续首次招呼。
                {!nativeValid && nativeBody
                  ? '请调整为 2–100 字，去除候选人姓名变量。'
                  : ''}
              </p>
              <Button
                variant="outline"
                disabled={!!busy || !nativeValid || !canManage}
                onClick={() => void applyGreeting()}
              >
                {busy === 'apply' ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : null}
                应用到 BOSS 岗位招呼语
              </Button>
            </div>
          ) : null}
        </div>
      </div>
      {previews.length && previewScope === scope ? (
        <div className="space-y-4 rounded-xl border bg-card p-4">
          <h3 className="font-semibold">
            发送前确认 · {realContact ? '将通过 BOSS 真实发送' : '模拟发送'}
          </h3>
          <div className="max-h-96 divide-y overflow-y-auto">
            {previews.map((item) => (
              <div
                key={item.preview.candidateStateId}
                className="space-y-2 py-3"
              >
                <p className="text-sm font-semibold">
                  {item.preview.candidateName}
                </p>
                <p className="whitespace-pre-wrap rounded-lg bg-muted/30 p-3 text-sm leading-6">
                  {item.preview.renderedMessage}
                </p>
                {item.readiness.checks
                  .filter((check) => !check.passed)
                  .map((check) => (
                    <p key={check.label} className="text-xs text-destructive">
                      {check.label}：{check.detail}
                    </p>
                  ))}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              确认候选人及文案后加入队列，逐人间隔至少 {interval} 秒。
            </p>
            <Button
              disabled={!!busy || !readyToSend}
              onClick={() => void send()}
            >
              {busy === 'send' ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <Send aria-hidden="true" />
              )}
              确认并{realContact ? '发送' : '模拟'} {previews.length} 人
            </Button>
          </div>
        </div>
      ) : null}
      {intents.length ? (
        <div className="space-y-3 rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">后台发送队列</h3>
            <Button
              variant="outline"
              size="sm"
              disabled={
                !!busy || !queue.some((item) => item.status === 'ready')
              }
              onClick={() => void cancelQueued()}
            >
              <X aria-hidden="true" />
              取消待发送
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            成功 {intents.filter((item) => item.status === 'sent').length} ·
            模拟 {intents.filter((item) => item.status === 'simulated').length}{' '}
            · 等待 / 执行 {queue.length} · 失败 / 待核实{' '}
            {
              intents.filter((item) =>
                ['failed', 'uncertain'].includes(item.status),
              ).length
            }
          </p>
          <Progress
            className="h-2 w-full accent-primary"
            value={finished.length}
            max={intents.length}
            aria-label="发送队列进度"
          />
          <p className="text-xs text-muted-foreground">
            可以离开页面，后台会继续执行。详细结果保存在下方执行记录中。
          </p>
        </div>
      ) : null}
    </section>
  );
}
