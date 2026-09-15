'use client';

import { useEffect, useState } from 'react';
import {
  CircleCheck,
  CircleX,
  LoaderCircle,
  MessageSquareText,
  ShieldCheck,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from './api-client';
import { contactRuntimePresentation } from './hr-display';

export type ContactActionKind = 'greet' | 'message';

type Preview = {
  actionKind: ContactActionKind;
  templateVersionId: string | null;
  templateVersion?: number;
  providerJobId: string | null;
  providerJobName?: string | null;
  providerGreetingId: string | null;
  body: string;
  renderedMessage: string;
  renderedMessageSha256: string;
  candidateStateId: string;
  candidateId: string;
  candidateName: string;
  positionId: string;
  positionName: string;
  taskId: string;
  bossAccountId: string;
  source: 'recommend' | 'search';
  sourceLocatorHint: string | null;
  sourceLocatorSha256: string | null;
  reviewStatus: string;
  contactStatus: string;
};

type PreviewApproval = {
  actionKind: ContactActionKind;
  token: string;
  approvalId: string;
  issuedAt: string;
  expiresAt: string;
  renderedMessageSha256: string;
};

type ReadinessCheck = {
  key: string;
  label: string;
  passed: boolean;
  detail: string;
};

type Readiness = {
  ready: boolean;
  reasons: string[];
  contactDispatchMode: 'disabled' | 'fake' | 'real';
  sideEffectsMode: string;
  checkedAt: string;
  checks: ReadinessCheck[];
  candidate: {
    stateId: string;
    candidateId: string;
    name: string;
  };
  position: {
    id: string;
    name: string;
    bossAccountId: string;
  };
  task: { id: string; status: string };
  source: {
    type: 'recommend' | 'search';
    stableLocatorPresent: boolean;
  };
};

type Props = {
  open: boolean;
  actionKind: ContactActionKind;
  stateId: string | null;
  positionId: string | null;
  taskId: string | null;
  controlApi: string;
  realGreetingEnabled: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => Promise<void> | void;
};

class ContactPreviewResponseError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ContactPreviewResponseError';
  }
}

async function responseJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & {
    error?: string;
    message?: string;
  };
  if (!response.ok) {
    throw new ContactPreviewResponseError(
      payload.message ?? `HTTP ${response.status}`,
      payload.error,
    );
  }
  return payload;
}

export function ContactPreviewDialog({
  open,
  actionKind,
  stateId,
  positionId,
  taskId,
  controlApi,
  realGreetingEnabled,
  onOpenChange,
  onCreated,
}: Props) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [approval, setApproval] = useState<PreviewApproval | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [loadedScopeKey, setLoadedScopeKey] = useState<string | null>(null);
  const [readinessFailed, setReadinessFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState(false);
  const [realContactAcknowledged, setRealContactAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (!stateId || !positionId || !taskId) {
      const timer = window.setTimeout(() => {
        setPreview(null);
        setApproval(null);
        setReadiness(null);
        setLoadedScopeKey(null);
        setRealContactAcknowledged(false);
        setReadinessFailed(true);
        setError('候选人或所属任务已变化，请关闭预览并重新选择。');
      }, 0);
      return () => window.clearTimeout(timer);
    }
    let cancelled = false;
    void Promise.resolve()
      .then(() => {
        setLoading(true);
        setCreated(false);
        setRealContactAcknowledged(false);
        setError(null);
        setPreview(null);
        setApproval(null);
        setReadiness(null);
        setLoadedScopeKey(null);
        setReadinessFailed(false);
        return apiFetch(
          `${controlApi}/api/candidate-position-states/${stateId}/${actionKind}-preview`,
          { cache: 'no-store' },
        ).then((response) =>
          responseJson<{
            preview: Preview;
            approval: PreviewApproval | null;
            readiness: Readiness;
          }>(response),
        );
      })
      .then((payload) => {
        if (cancelled) return;
        if (
          payload.preview.actionKind !== actionKind ||
          payload.preview.candidateStateId !== stateId ||
          payload.preview.positionId !== positionId ||
          payload.preview.taskId !== taskId ||
          payload.readiness.candidate.stateId !== stateId ||
          payload.readiness.candidate.candidateId !==
            payload.preview.candidateId ||
          payload.readiness.candidate.name !== payload.preview.candidateName ||
          payload.readiness.position.id !== positionId ||
          payload.readiness.position.name !== payload.preview.positionName ||
          payload.readiness.position.bossAccountId !==
            payload.preview.bossAccountId ||
          payload.readiness.task.id !== taskId ||
          payload.readiness.source.type !== payload.preview.source ||
          payload.readiness.source.stableLocatorPresent !==
            Boolean(payload.preview.sourceLocatorSha256) ||
          (actionKind === 'greet' &&
            (payload.preview.templateVersionId !== null ||
              !payload.preview.providerJobId ||
              !payload.preview.providerGreetingId)) ||
          (actionKind === 'message' &&
            (typeof payload.preview.templateVersionId !== 'string' ||
              payload.preview.providerJobId !== null ||
              payload.preview.providerGreetingId !== null)) ||
          (payload.approval !== null &&
            (payload.approval.actionKind !== actionKind ||
              payload.approval.renderedMessageSha256 !==
                payload.preview.renderedMessageSha256))
        ) {
          throw new Error(
            '服务端预览与当前候选人、BOSS 账号、岗位或任务不一致。',
          );
        }
        setPreview(payload.preview);
        setApproval(payload.approval);
        setReadiness(payload.readiness);
        setLoadedScopeKey(`${actionKind}:${stateId}:${positionId}:${taskId}`);
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        setReadinessFailed(true);
        if (
          actionKind === 'greet' &&
          loadError instanceof ContactPreviewResponseError &&
          loadError.code === 'greet_exact_content_unavailable'
        ) {
          setError(
            '无法取得这个岗位的专属招呼语。请先确认 BOSS 登录正常，并在 BOSS 岗位设置中配置专属招呼语；保存后回到这里重新打开“打招呼”预览。系统没有创建任务。',
          );
          return;
        }
        setError(
          loadError instanceof Error
            ? `无法确认联系安全状态：${loadError.message}`
            : `无法确认联系安全状态：${String(loadError)}`,
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [actionKind, controlApi, open, positionId, stateId, taskId]);

  const verifiedMode = contactRuntimePresentation({
    loaded: readiness !== null,
    requestFailed: readinessFailed,
    realGreetingEnabled,
    contactDispatchMode: readiness?.contactDispatchMode,
    sideEffectsMode: readiness?.sideEffectsMode,
  });
  const currentScopeKey =
    stateId && positionId && taskId
      ? `${actionKind}:${stateId}:${positionId}:${taskId}`
      : null;
  const readyToCreate =
    loadedScopeKey === currentScopeKey &&
    readiness?.ready === true &&
    (verifiedMode.state === 'fake' ||
      (verifiedMode.state === 'real' && approval !== null));
  const verifiedRealContact = readyToCreate && verifiedMode.allowsRealContact;
  const canConfirm =
    readyToCreate && (!verifiedRealContact || realContactAcknowledged);
  const failedChecks = readiness?.checks.filter((check) => !check.passed) ?? [];
  const passedCheckCount =
    readiness?.checks.filter((check) => check.passed).length ?? 0;
  const actionLabel = actionKind === 'greet' ? '打招呼' : '发消息';
  const previewTitle = actionKind === 'greet' ? '招呼语' : '消息';

  async function confirm() {
    if (!stateId || !preview || submitting || !canConfirm) return;
    const approvalToken = verifiedRealContact ? approval?.token : null;
    if (verifiedRealContact && !approvalToken) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await apiFetch(
        `${controlApi}/api/candidate-position-states/${stateId}/contact-intents`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': crypto.randomUUID(),
          },
          body: JSON.stringify({
            actionKind,
            ...(actionKind === 'greet'
              ? {
                  templateVersionId: null,
                  providerJobId: preview.providerJobId,
                  providerGreetingId: preview.providerGreetingId,
                  renderedMessageSha256: preview.renderedMessageSha256,
                }
              : { templateVersionId: preview.templateVersionId }),
            createdBy: 'hr:dashboard',
            ...(verifiedRealContact
              ? {
                  confirmRealContact: true,
                  contactPreviewApprovalToken: approvalToken,
                }
              : {}),
          }),
        },
      );
      await responseJson(response);
      setCreated(true);
      await onCreated();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : String(submitError),
      );
    } finally {
      setSubmitting(false);
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && submitting) return;
    if (!nextOpen) setRealContactAcknowledged(false);
    onOpenChange(nextOpen);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={!submitting}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquareText
              className="size-4 text-primary"
              aria-hidden="true"
            />
            {actionLabel}预览与人工确认
          </DialogTitle>
          <DialogDescription>
            {actionKind === 'greet'
              ? '服务端从当前 BOSS 岗位设置读取专属招呼语，避免使用错误岗位或过期内容。'
              : '服务端按当前消息模板重新渲染，避免使用过期或被篡改的消息。'}
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <output className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <LoaderCircle className="animate-spin" aria-hidden="true" />
            正在生成预览
          </output>
        ) : null}
        {preview && !loading ? (
          <div className="space-y-3">
            <dl className="grid gap-2 rounded-lg border bg-muted/30 p-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">候选人</dt>
                <dd className="font-medium">{preview.candidateName}</dd>
                <dd className="text-xs text-muted-foreground">
                  唯一记录 {preview.candidateStateId.slice(0, 8)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">岗位</dt>
                <dd className="font-medium">{preview.positionName}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted-foreground">所属任务</dt>
                <dd className="text-xs">
                  任务记录 {preview.taskId.slice(0, 8)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  发件 BOSS 账号
                </dt>
                <dd className="font-medium">{preview.bossAccountId}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  BOSS 候选人定位
                </dt>
                <dd className="font-medium">
                  {preview.source === 'recommend' ? '推荐列表' : '搜索结果'} ·{' '}
                  {preview.sourceLocatorHint ?? '缺少唯一标识'}
                </dd>
              </div>
              {actionKind === 'greet' ? (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">
                    BOSS 岗位专属招呼语
                  </dt>
                  <dd className="font-medium">
                    {preview.providerJobName ?? preview.positionName}
                  </dd>
                  <dd className="text-xs text-muted-foreground">
                    岗位标识 {preview.providerJobId} · 招呼语标识{' '}
                    {preview.providerGreetingId}
                  </dd>
                </div>
              ) : null}
            </dl>
            <label
              htmlFor="contact-preview-message"
              className="grid gap-1.5 text-sm font-medium"
            >
              最终待发送{previewTitle}
              <Textarea
                id="contact-preview-message"
                readOnly
                value={preview.renderedMessage}
                className="min-h-28 resize-none"
              />
            </label>
            <p className="text-xs text-muted-foreground">
              {actionKind === 'greet'
                ? '来自当前 BOSS 岗位专属招呼语'
                : `消息模板版本 v${preview.templateVersion}`}{' '}
              · {preview.renderedMessage.length}/500 字 · 正文指纹{' '}
              {preview.renderedMessageSha256.slice(0, 12)}
            </p>
            {verifiedMode.state === 'real' && approval ? (
              <div className="rounded-lg border p-3 text-xs leading-5">
                <p className="font-medium">
                  单次许可 {approval.approvalId.slice(0, 8)}
                </p>
                <p className="text-muted-foreground">
                  只绑定本次“{actionLabel}
                  ”、以上候选人唯一标识、发件账号、岗位、任务和正文；将在{' '}
                  {new Date(approval.expiresAt).toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}{' '}
                  失效。任一信息变化后必须重新预览确认。
                </p>
              </div>
            ) : null}
            {readiness ? (
              <section className="rounded-lg border p-3 text-xs leading-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">本次{actionLabel}安全检查</p>
                  <p className="text-muted-foreground">
                    {passedCheckCount}/{readiness.checks.length} 项通过 ·{' '}
                    {new Date(readiness.checkedAt).toLocaleTimeString('zh-CN', {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </p>
                </div>
                {failedChecks.length ? (
                  <ul
                    className="mt-2 space-y-1.5"
                    aria-label="未通过的联系安全检查"
                  >
                    {failedChecks.map((check) => (
                      <li
                        key={check.key}
                        className="flex gap-2 text-destructive"
                      >
                        <CircleX
                          className="mt-0.5 size-4 shrink-0"
                          aria-hidden="true"
                        />
                        <span>
                          <span className="font-medium">{check.label}：</span>
                          {check.detail}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 flex gap-2 text-success">
                    <CircleCheck
                      className="mt-0.5 size-4 shrink-0"
                      aria-hidden="true"
                    />
                    当前检查全部通过；创建和实际发送前仍会由服务端重新检查。
                  </p>
                )}
                <details className="mt-2">
                  <summary className="cursor-pointer select-none font-medium">
                    查看全部检查明细
                  </summary>
                  <ul className="mt-2 space-y-1.5">
                    {readiness.checks.map((check) => (
                      <li key={check.key} className="flex gap-2">
                        {check.passed ? (
                          <CircleCheck
                            className="mt-0.5 size-4 shrink-0 text-success"
                            aria-hidden="true"
                          />
                        ) : (
                          <CircleX
                            className="mt-0.5 size-4 shrink-0 text-destructive"
                            aria-hidden="true"
                          />
                        )}
                        <span>
                          <span className="font-medium">
                            {check.passed ? '通过' : '未通过'} · {check.label}：
                          </span>
                          {check.detail}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              </section>
            ) : null}
            <div className="flex gap-2 rounded-lg border border-warning/30 bg-warning/8 p-3 text-xs leading-5">
              <ShieldCheck
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              <span>
                {verifiedRealContact
                  ? `确认后将创建真实${actionLabel}任务；账号健康、人工审核、时段、额度、重复联系和紧急停止策略仍会在发送前重新检查，检查通过后可能立即执行。`
                  : verifiedMode.state === 'real'
                    ? `真实联系功能已开启，但本次${actionLabel}尚未通过全部安全检查或缺少短效许可，系统已阻止创建。请按上方提示处理后重新预览。`
                    : verifiedMode.state === 'fake'
                      ? `确认只会创建模拟${actionLabel}任务，当前不会向 BOSS 或候选人执行真实操作。`
                      : verifiedMode.state === 'preview'
                        ? `当前仅供查看最终${previewTitle}；联系发送处理程序未启动，不能创建或执行${actionLabel}任务。`
                        : '联系运行状态无法确认，系统已阻止创建任务。'}
              </span>
            </div>
            {verifiedRealContact ? (
              <section
                aria-labelledby="real-contact-confirmation-title"
                className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3"
              >
                <p
                  id="real-contact-confirmation-title"
                  className="text-sm font-semibold text-destructive"
                >
                  真实{actionLabel}前的最终确认
                </p>
                <label
                  htmlFor="real-contact-acknowledgement"
                  className="flex min-h-11 cursor-pointer items-start gap-3 text-xs leading-5"
                >
                  <Checkbox
                    id="real-contact-acknowledgement"
                    checked={realContactAcknowledged}
                    disabled={submitting}
                    onCheckedChange={(checked) =>
                      setRealContactAcknowledged(checked === true)
                    }
                    aria-describedby="real-contact-acknowledgement-detail"
                  />
                  <span id="real-contact-acknowledgement-detail">
                    我已核对本次动作是“{actionLabel}”、收件人“
                    {preview.candidateName}”、发件账号“{preview.bossAccountId}
                    ”、岗位“{preview.positionName}”、所属任务“
                    {preview.taskId.slice(0, 8)}
                    ”和上方最终正文；点击下方按钮后可能立即执行，且无法从本系统撤回。
                  </span>
                </label>
              </section>
            ) : null}
          </div>
        ) : null}
        {preview && readiness && !readiness.ready ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
          >
            <p className="font-medium text-destructive">当前不能创建联系任务</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              上方有 {Math.max(failedChecks.length, 1)}{' '}
              项安全检查未通过，系统已阻止后续操作。
            </p>
          </div>
        ) : null}
        {preview && readiness && verifiedMode.state === 'blocked' ? (
          <p role="alert" className="text-sm text-destructive">
            {verifiedMode.detail}
          </p>
        ) : null}
        {preview && verifiedMode.state === 'real' && !approval ? (
          <p role="alert" className="text-sm text-destructive">
            未取得本次{actionLabel}预览的短效许可，不能创建真实
            {actionLabel}任务。请关闭后重新预览。
          </p>
        ) : null}
        {created ? (
          <output className="text-sm text-success">
            {verifiedRealContact
              ? `真实${actionLabel}任务已创建，等待发送前安全检查。请勿重复提交。`
              : `模拟${actionLabel}任务已创建。`}
          </output>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={submitting}
            onClick={() => handleOpenChange(false)}
          >
            {created ? '完成' : '取消'}
          </Button>
          {!created ? (
            <Button
              onClick={() => void confirm()}
              disabled={!preview || submitting || !canConfirm}
              variant={verifiedRealContact ? 'destructive' : 'default'}
            >
              {submitting ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : null}
              {submitting
                ? '正在创建'
                : loading
                  ? '正在生成预览'
                  : error
                    ? '当前不可创建'
                    : verifiedRealContact
                      ? actionKind === 'greet'
                        ? `确认并仅向${preview?.candidateName ?? '该候选人'}打招呼`
                        : `确认并仅向${preview?.candidateName ?? '该候选人'}发送这一条`
                      : verifiedMode.state === 'fake'
                        ? `确认创建模拟${actionLabel}任务`
                        : verifiedMode.state === 'preview'
                          ? '发送处理程序未启动'
                          : '当前不可创建'}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
