'use client';
import { useEffect, useState } from 'react';
import { CalendarDays, LoaderCircle, Plus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useCurrentUser } from '../auth-gate';
import { apiFetch, controlApi, userFacingRequestError } from '../api-client';
import {
  lifecycleStageLabels,
  type LifecycleCase,
  type LifecycleDetail,
  type LifecycleWorkspace,
  type RecruitmentDelivery,
  type RecruitmentMessageContext,
} from '../../../../packages/contracts/src/recruitment-lifecycle';

export type LifecycleDraft = {
  conversationId: string;
  body: string;
  delivery: RecruitmentMessageContext;
};
export const lifecycleDraftKey = (departmentId: string, userId: string) =>
  `boss-forge.lifecycle-incoming:${departmentId}:${userId}`;
export async function lifecycleRequest<T>(
  path: string,
  body?: unknown,
  method = 'POST',
): Promise<T> {
  const response = await apiFetch(
    `${controlApi}/api/recruitment/lifecycle${path}`,
    body === undefined
      ? {}
      : {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const value: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      value &&
        typeof value === 'object' &&
        'message' in value &&
        typeof value.message === 'string'
        ? value.message
        : '招聘流程暂不可用。',
    );
  return value as T;
}
const formText = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
};
const fieldClass =
  'min-h-11 w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring';
const format = (v: string) =>
  new Date(v).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}
const offers: Record<string, string> = {
  draft: '草稿',
  pending_approval: '待审批',
  approved: '已批准 · 待发送',
  sent: '已发送 · 待答复',
  accepted: '候选人已接受',
  declined: '候选人已拒绝',
  withdrawn: '已撤回',
};
const interviews: Record<string, string> = {
  scheduled: '待确认',
  confirmed: '已确认',
  completed: '已完成',
  cancelled: '已取消',
  no_show: '未到场',
};

export function LifecycleDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  caseId?: string;
  conversationId?: string;
  stateId?: string;
  onCompose?: (draft: LifecycleDraft) => void;
  onChanged?: () => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>招聘跟进</DialogTitle>
          <DialogDescription>
            候选人建档、面试、录用与入职，保留每一步的负责人和记录。
          </DialogDescription>
        </DialogHeader>
        {props.open ? (
          <LifecycleContent
            key={props.caseId ?? props.conversationId ?? props.stateId}
            {...props}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
function LifecycleContent({
  caseId,
  conversationId,
  stateId,
  onCompose,
  onChanged,
  onOpenChange,
}: {
  caseId?: string;
  conversationId?: string;
  stateId?: string;
  onCompose?: (draft: LifecycleDraft) => void;
  onChanged?: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const user = useCurrentUser(),
    isManager = ['admin', 'recruiting_lead'].includes(user.role),
    isInterviewer = user.role === 'interviewer';
  const [detail, setDetail] = useState<LifecycleDetail | null>(null),
    [options, setOptions] = useState<{
      positions: LifecycleWorkspace['positions'];
      users: LifecycleWorkspace['users'];
      applications?: LifecycleCase[];
      candidateName?: string;
      positionId?: string | null;
    }>({ positions: [], users: [] });
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [success, setSuccess] = useState('');
  const [tab, setTab] = useState(isInterviewer ? 'interviews' : 'overview'),
    [preview, setPreview] = useState<LifecycleDraft | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const context = await lifecycleRequest<
          LifecycleWorkspace & {
            candidateName?: string;
            positionId?: string | null;
          }
        >(
          caseId
            ? ''
            : `/context?${conversationId ? `conversationId=${conversationId}` : `stateId=${stateId}`}`,
        );
        if (!alive) return;
        setOptions(context);
        const id = caseId ?? context.applications[0]?.id;
        if (id) {
          const value = await lifecycleRequest<LifecycleDetail>(`/${id}`);
          if (alive) setDetail(value);
        }
      } catch (e) {
        if (alive) setError(userFacingRequestError(e));
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, [caseId, conversationId, stateId]);
  async function perform(path: string, input: unknown, method = 'POST') {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSuccess('');
    try {
      setDetail(await lifecycleRequest<LifecycleDetail>(path, input, method));
      setSuccess('已保存');
      onChanged?.();
      return true;
    } catch (e) {
      setError(userFacingRequestError(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function prepare(delivery: RecruitmentDelivery) {
    if (!detail || busy) return;
    setBusy(true);
    setError(null);
    try {
      const value = await lifecycleRequest<{
        conversationId: string;
        body: string;
        caseId: string;
        delivery: RecruitmentDelivery;
      }>(`/${detail.application.id}/delivery`, delivery);
      setPreview({
        ...value,
        delivery: { ...value.delivery, caseId: value.caseId },
      });
    } catch (e) {
      setError(userFacingRequestError(e));
    } finally {
      setBusy(false);
    }
  }
  function compose() {
    if (!preview) return;
    if (onCompose) {
      onCompose(preview);
      onOpenChange(false);
    } else {
      sessionStorage.setItem(
        lifecycleDraftKey(user.departmentId, user.userId),
        JSON.stringify(preview),
      );
      window.location.assign(
        `/communication?conversation=${preview.conversationId}`,
      );
    }
  }
  const application = detail?.application,
    id = application?.id,
    closed = Boolean(
      application &&
      ['hired', 'rejected', 'withdrawn', 'no_show'].includes(application.stage),
    ),
    approved = application?.reviewStatus === 'approved';
  if (loading)
    return (
      <output className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" />
        正在读取招聘档案…
      </output>
    );
  return (
    <div className="space-y-4">
      {error ? (
        <p
          role="alert"
          className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      {success ? (
        <output className="text-sm text-muted-foreground">{success}</output>
      ) : null}
      {!detail ? (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void perform('', {
              ...(conversationId ? { conversationId } : { stateId }),
              positionId: f.get('position'),
              ownerId: f.get('owner'),
            });
          }}
        >
          <p className="font-medium">
            为 {options.candidateName || '此候选人'} 建立招聘档案
          </p>
          <p className="text-sm leading-6 text-muted-foreground">
            已有档案会直接打开。来自 BOSS
            沟通的新候选人先进入待审核，不会自动生成筛选成绩。
          </p>
          <Field label="关联岗位">
            <select
              className={fieldClass}
              name="position"
              required
              defaultValue={options.positionId ?? ''}
            >
              <option value="">选择岗位</option>
              {options.positions
                .filter(
                  (p) => !options.positionId || p.id === options.positionId,
                )
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="跟进负责人">
            <select
              className={fieldClass}
              name="owner"
              required
              defaultValue={user.userId}
            >
              {options.users
                .filter((u) => u.role !== 'interviewer')
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
            </select>
          </Field>
          <Button
            type="submit"
            className="min-h-11"
            disabled={busy || isInterviewer}
          >
            <Plus className="size-4" aria-hidden="true" />
            {busy ? '正在建档…' : '建档并开始跟进'}
          </Button>
        </form>
      ) : (
        <>
          <div className="rounded-lg border bg-muted/25 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold">
                {application!.candidateName} · {application!.positionName}
              </p>
              <span className="rounded-full bg-secondary px-3 py-1 text-xs">
                {lifecycleStageLabels[application!.stage] ?? application!.stage}
              </span>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              负责人：{application!.ownerName}
              {application!.nextFollowupAt
                ? ` · 下次跟进 ${format(application!.nextFollowupAt)}`
                : ''}
            </p>
            {application!.closeReason ? (
              <p className="mt-2 text-sm">
                结束原因：{application!.closeReason}
              </p>
            ) : null}
          </div>
          {!closed &&
          conversationId &&
          !application!.conversationId &&
          !isInterviewer ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={busy}
              onClick={() =>
                void perform('', {
                  conversationId,
                  positionId: application!.positionId,
                  ownerId: application!.ownerId,
                })
              }
            >
              关联当前会话到此招聘档案
            </Button>
          ) : null}
          <div className="flex flex-wrap gap-2" aria-label="招聘档案分区">
            {(isInterviewer
              ? [['interviews', '面试']]
              : [
                  ['overview', '概况'],
                  ['interviews', '面试'],
                  ['offers', 'Offer'],
                  ['onboarding', '入职'],
                  ['events', '记录'],
                ]
            ).map(([key, label]) => (
              <Button
                key={key}
                type="button"
                variant={tab === key ? 'secondary' : 'ghost'}
                className="min-h-11"
                aria-pressed={tab === key}
                onClick={() => {
                  setTab(key!);
                  setPreview(null);
                }}
              >
                {label}
              </Button>
            ))}
          </div>
          {preview ? (
            <div className="space-y-3 rounded-lg border border-primary/30 p-4">
              <p className="font-medium">
                发送前预览 · {application!.candidateName}
              </p>
              <p className="whitespace-pre-wrap text-sm leading-6">
                {preview.body}
              </p>
              <p className="text-xs text-muted-foreground">
                下一步填入聊天，点击发送后才会通过 BOSS 发出。原聊天草稿会保留。
              </p>
              <div className="flex flex-wrap gap-2">
                <Button className="min-h-11" type="button" onClick={compose}>
                  填入聊天发送
                </Button>
                <Button
                  className="min-h-11"
                  type="button"
                  variant="ghost"
                  onClick={() => setPreview(null)}
                >
                  取消预览
                </Button>
              </div>
            </div>
          ) : null}
          {tab === 'overview' && !isInterviewer ? (
            <div className="space-y-4">
              {!closed ? (
                <form
                  className="grid gap-3 sm:grid-cols-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    void perform(
                      `/${id}`,
                      {
                        version: application!.version,
                        ownerId: f.get('owner'),
                        nextFollowupAt: f.get('due')
                          ? new Date(formText(f, 'due')).toISOString()
                          : null,
                        followupNote: f.get('note'),
                      },
                      'PATCH',
                    );
                  }}
                >
                  <Field label="跟进负责人">
                    <select
                      className={fieldClass}
                      name="owner"
                      defaultValue={application!.ownerId}
                    >
                      {options.users
                        .filter((u) => u.role !== 'interviewer')
                        .map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field label="下次跟进时间">
                    <input
                      className={fieldClass}
                      type="datetime-local"
                      name="due"
                      defaultValue={
                        application!.nextFollowupAt
                          ? localDateTime(application!.nextFollowupAt)
                          : ''
                      }
                    />
                  </Field>
                  <div className="sm:col-span-2">
                    <Field label="跟进事项">
                      <Textarea
                        name="note"
                        maxLength={1000}
                        defaultValue={application!.followupNote}
                      />
                    </Field>
                  </div>
                  <Button
                    type="submit"
                    className="min-h-11 sm:col-span-2"
                    disabled={busy}
                  >
                    保存跟进安排
                  </Button>
                </form>
              ) : null}
              {!closed && application!.reviewStatus === 'pending' ? (
                <form
                  className="space-y-3 rounded-lg border p-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    void perform(
                      `/${id}`,
                      {
                        version: application!.version,
                        review: f.get('review'),
                        note: f.get('note'),
                      },
                      'PATCH',
                    );
                  }}
                >
                  <p className="font-medium">人工审核</p>
                  <Field label="审核结论">
                    <select className={fieldClass} name="review">
                      <option value="approved">通过，继续沟通</option>
                      <option value="rejected">不通过</option>
                    </select>
                  </Field>
                  <Field label="判断依据">
                    <Textarea name="note" required maxLength={1000} />
                  </Field>
                  <Button type="submit" className="min-h-11" disabled={busy}>
                    保存人工审核结论
                  </Button>
                </form>
              ) : null}
              {!closed ? (
                <details className="rounded-lg border p-4">
                  <summary className="cursor-pointer text-sm font-medium">
                    结束本次招聘
                  </summary>
                  <form
                    className="mt-3 space-y-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      void perform(
                        `/${id}`,
                        {
                          version: application!.version,
                          close: f.get('close'),
                          note: f.get('note'),
                        },
                        'PATCH',
                      );
                    }}
                  >
                    <Field label="结束类型">
                      <select className={fieldClass} name="close">
                        <option value="rejected">招聘方淘汰</option>
                        <option value="withdrawn">候选人退出</option>
                        {approved ? (
                          <option value="no_show">未入职</option>
                        ) : null}
                      </select>
                    </Field>
                    <Field label="具体原因">
                      <Textarea name="note" required maxLength={1000} />
                    </Field>
                    <Button
                      type="submit"
                      className="min-h-11"
                      variant="destructive"
                      disabled={busy}
                    >
                      记录原因并结束招聘
                    </Button>
                  </form>
                </details>
              ) : null}
            </div>
          ) : null}
          {tab === 'interviews' || isInterviewer ? (
            <div className="space-y-4">
              {!closed && approved && !isInterviewer ? (
                <details
                  className="rounded-lg border p-4"
                  open={!detail.interviews.length}
                >
                  <summary className="cursor-pointer text-sm font-medium">
                    安排面试
                  </summary>
                  <form
                    className="mt-3 grid gap-3 sm:grid-cols-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      void perform(`/${id}/interviews`, {
                        startsAt: new Date(formText(f, 'starts')).toISOString(),
                        endsAt: new Date(formText(f, 'ends')).toISOString(),
                        location: f.get('location'),
                        interviewerIds: f.getAll('interviewer'),
                      });
                    }}
                  >
                    <Field label="开始时间">
                      <input
                        className={fieldClass}
                        type="datetime-local"
                        name="starts"
                        required
                      />
                    </Field>
                    <Field label="结束时间">
                      <input
                        className={fieldClass}
                        type="datetime-local"
                        name="ends"
                        required
                      />
                    </Field>
                    <div className="sm:col-span-2">
                      <Field label="地点或线上会议链接">
                        <Input name="location" required maxLength={160} />
                      </Field>
                    </div>
                    <fieldset className="space-y-2 sm:col-span-2">
                      <legend className="text-sm font-medium">
                        面试官（可多选）
                      </legend>
                      <div className="flex flex-wrap gap-2">
                        {options.users.map((u) => (
                          <label
                            key={u.id}
                            className="flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm"
                          >
                            <input
                              name="interviewer"
                              type="checkbox"
                              value={u.id}
                            />
                            {u.name}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    <Button
                      type="submit"
                      className="min-h-11 sm:col-span-2"
                      disabled={busy}
                    >
                      <CalendarDays className="size-4" aria-hidden="true" />
                      保存面试安排
                    </Button>
                  </form>
                </details>
              ) : null}
              {!approved ? (
                <p className="text-sm text-muted-foreground">
                  通过人工审核后，可以安排面试。
                </p>
              ) : null}
              {detail.interviews.map((i) => (
                <div key={i.id} className="space-y-3 rounded-lg border p-4">
                  <div className="flex flex-wrap justify-between gap-2">
                    <b className="text-sm">
                      {format(i.startsAt)} — {format(i.endsAt)}
                    </b>
                    <span className="text-xs text-muted-foreground">
                      {interviews[i.status]}
                    </span>
                  </div>
                  <p className="break-words text-sm">{i.location}</p>
                  <p className="text-xs text-muted-foreground">
                    面试官：
                    {i.interviewerIds
                      .map(
                        (uid) =>
                          options.users.find((u) => u.id === uid)?.name ??
                          '已离职成员',
                      )
                      .join('、')}{' '}
                    · 邀请：{deliveryLabel(i.invitationStatus)}
                  </p>
                  {!closed &&
                  !isInterviewer &&
                  ['scheduled', 'confirmed'].includes(i.status) ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        disabled={
                          busy ||
                          Boolean(
                            i.invitationStatus &&
                            i.invitationStatus !== 'failed',
                          )
                        }
                        onClick={() =>
                          void prepare({
                            kind: 'interview',
                            recordId: i.id,
                            version: i.version,
                          })
                        }
                      >
                        预览面试邀请
                      </Button>
                      <form
                        className="space-y-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const f = new FormData(e.currentTarget);
                          void perform(`/${id}/interviews/${i.id}`, {
                            version: i.version,
                            action: f.get('action'),
                            note: f.get('note'),
                          });
                        }}
                      >
                        <Field label="候选人确认与面试进度">
                          <select className={fieldClass} name="action">
                            <option value="confirm">记录候选人已确认</option>
                            <option value="complete">面试已完成</option>
                            <option value="cancel">取消本场面试</option>
                            <option value="no_show">候选人未到场</option>
                          </select>
                        </Field>
                        <Field label="确认依据或变更说明">
                          <Textarea name="note" required maxLength={1000} />
                        </Field>
                        <Button
                          type="submit"
                          className="min-h-11"
                          variant="outline"
                          disabled={busy}
                        >
                          保存面试进度
                        </Button>
                      </form>
                    </>
                  ) : null}
                  {i.feedback.map((f) => (
                    <p
                      key={f.reviewerId}
                      className="rounded-md bg-muted/30 p-3 text-sm leading-6"
                    >
                      {f.reviewerName} · {f.score}/5 ·{' '}
                      {
                        (
                          {
                            yes: '建议通过',
                            mixed: '保留',
                            no: '不建议',
                          } as Record<string, string>
                        )[f.recommendation]
                      }
                      <br />
                      {f.body}
                    </p>
                  ))}
                  {!closed &&
                  (isManager || i.interviewerIds.includes(user.userId)) &&
                  !['cancelled', 'no_show'].includes(i.status) ? (
                    <details>
                      <summary className="cursor-pointer text-sm">
                        填写面试反馈
                      </summary>
                      <form
                        className="mt-3 space-y-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const f = new FormData(e.currentTarget);
                          void perform(`/${id}/interviews/${i.id}`, {
                            action: 'feedback',
                            recommendation: f.get('recommendation'),
                            score: Number(f.get('score')),
                            body: f.get('body'),
                          });
                        }}
                      >
                        <Field label="面试建议">
                          <select className={fieldClass} name="recommendation">
                            <option value="yes">建议通过</option>
                            <option value="mixed">保留</option>
                            <option value="no">不建议</option>
                          </select>
                        </Field>
                        <Field label="评分（1–5）">
                          <Input
                            name="score"
                            type="number"
                            min={1}
                            max={5}
                            required
                            defaultValue={4}
                          />
                        </Field>
                        <Field label="面试证据与反馈">
                          <Textarea name="body" required maxLength={1000} />
                        </Field>
                        <Button
                          type="submit"
                          className="min-h-11"
                          disabled={busy}
                        >
                          提交面试反馈
                        </Button>
                      </form>
                    </details>
                  ) : null}
                </div>
              ))}
              {!detail.interviews.length ? (
                <p className="text-sm text-muted-foreground">
                  还没有安排面试。
                </p>
              ) : null}
            </div>
          ) : null}
          {tab === 'offers' && !isInterviewer ? (
            <div className="space-y-4">
              {!closed &&
              approved &&
              !detail.offers.some(
                (o) => !['declined', 'withdrawn'].includes(o.status),
              ) ? (
                <form
                  className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    void perform(`/${id}/offers`, {
                      salaryMonthly: Number(f.get('salary')),
                      salaryMonths: Number(f.get('months')),
                      startDate: f.get('start'),
                      expiresAt: new Date(formText(f, 'expires')).toISOString(),
                      terms: f.get('terms'),
                    });
                  }}
                >
                  <Field label="税前月薪（人民币元）">
                    <Input
                      type="number"
                      min="0.01"
                      step="0.01"
                      name="salary"
                      required
                    />
                  </Field>
                  <Field label="年薪月数">
                    <Input
                      type="number"
                      min={1}
                      max={24}
                      name="months"
                      defaultValue={12}
                      required
                    />
                  </Field>
                  <Field label="预计入职日期">
                    <input
                      className={fieldClass}
                      type="date"
                      name="start"
                      required
                    />
                  </Field>
                  <Field label="答复截止时间">
                    <input
                      className={fieldClass}
                      type="datetime-local"
                      name="expires"
                      required
                    />
                  </Field>
                  <div className="sm:col-span-2">
                    <Field label="补充约定（如试用期、工作地点）">
                      <Textarea name="terms" maxLength={250} />
                    </Field>
                  </div>
                  <Button
                    type="submit"
                    className="min-h-11 sm:col-span-2"
                    disabled={busy}
                  >
                    保存 Offer 草稿
                  </Button>
                </form>
              ) : null}
              {detail.offers.map((o) => (
                <div key={o.id} className="space-y-3 rounded-lg border p-4">
                  <div className="flex flex-wrap justify-between gap-2">
                    <b className="text-sm">
                      税前月薪 ¥{o.salaryMonthly.toLocaleString()} ×{' '}
                      {o.salaryMonths} 薪
                    </b>
                    <span className="text-xs text-muted-foreground">
                      {offers[o.status]}
                    </span>
                  </div>
                  <p className="text-sm">
                    预计入职：{o.startDate} · 截止：{format(o.expiresAt)}
                  </p>
                  {o.terms ? (
                    <p className="whitespace-pre-wrap text-sm">{o.terms}</p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    发送：{deliveryLabel(o.deliveryStatus)}
                  </p>
                  {o.responseNote ? (
                    <p className="text-sm">记录：{o.responseNote}</p>
                  ) : null}
                  {!closed && o.status === 'draft' ? (
                    <details key={o.version}>
                      <summary className="cursor-pointer text-sm">
                        修改 Offer 草稿
                      </summary>
                      <form
                        className="mt-3 grid gap-3 sm:grid-cols-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const f = new FormData(e.currentTarget);
                          void perform(`/${id}/offers/${o.id}`, {
                            version: o.version,
                            action: 'revise',
                            note: f.get('note'),
                            changes: {
                              salaryMonthly: Number(f.get('salary')),
                              salaryMonths: Number(f.get('months')),
                              startDate: f.get('start'),
                              expiresAt: new Date(
                                formText(f, 'expires'),
                              ).toISOString(),
                              terms: f.get('terms'),
                            },
                          });
                        }}
                      >
                        <Field label="税前月薪（人民币元）">
                          <Input
                            name="salary"
                            type="number"
                            min="0.01"
                            step="0.01"
                            defaultValue={o.salaryMonthly}
                            required
                          />
                        </Field>
                        <Field label="年薪月数">
                          <Input
                            name="months"
                            type="number"
                            min={1}
                            max={24}
                            defaultValue={o.salaryMonths}
                            required
                          />
                        </Field>
                        <Field label="预计入职日期">
                          <input
                            className={fieldClass}
                            name="start"
                            type="date"
                            defaultValue={o.startDate}
                            required
                          />
                        </Field>
                        <Field label="答复截止时间">
                          <input
                            className={fieldClass}
                            name="expires"
                            type="datetime-local"
                            defaultValue={localDateTime(o.expiresAt)}
                            required
                          />
                        </Field>
                        <Field label="补充约定">
                          <Textarea
                            name="terms"
                            maxLength={250}
                            defaultValue={o.terms}
                          />
                        </Field>
                        <Field label="修改说明">
                          <Textarea name="note" maxLength={1000} required />
                        </Field>
                        <Button
                          type="submit"
                          className="min-h-11 sm:col-span-2"
                          disabled={busy}
                        >
                          保存草稿修改
                        </Button>
                      </form>
                    </details>
                  ) : null}
                  {!closed && o.status === 'draft' ? (
                    <Button
                      type="submit"
                      className="min-h-11"
                      disabled={busy}
                      onClick={() =>
                        void perform(`/${id}/offers/${o.id}`, {
                          version: o.version,
                          action: 'submit',
                        })
                      }
                    >
                      提交 Offer 审批
                    </Button>
                  ) : null}
                  {!closed && o.status === 'approved' ? (
                    <Button
                      type="submit"
                      className="min-h-11"
                      disabled={
                        busy ||
                        Boolean(
                          o.deliveryStatus && o.deliveryStatus !== 'failed',
                        )
                      }
                      onClick={() =>
                        void prepare({
                          kind: 'offer',
                          recordId: o.id,
                          version: o.version,
                        })
                      }
                    >
                      预览录用邀请
                    </Button>
                  ) : null}
                  {!closed &&
                  !['accepted', 'declined', 'withdrawn'].includes(o.status) ? (
                    <form
                      className="space-y-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const f = new FormData(e.currentTarget);
                        void perform(`/${id}/offers/${o.id}`, {
                          version: o.version,
                          action: f.get('action'),
                          note: f.get('note'),
                        });
                      }}
                    >
                      <Field label="Offer 操作">
                        <select
                          key={o.status}
                          className={fieldClass}
                          name="action"
                          defaultValue=""
                          required
                        >
                          <option value="" disabled>
                            选择操作
                          </option>
                          {o.status === 'pending_approval' && isManager ? (
                            <>
                              <option value="approve">批准 Offer</option>
                              <option value="return">退回草稿</option>
                            </>
                          ) : null}
                          {o.status === 'sent' ? (
                            <>
                              <option value="accept">记录候选人接受</option>
                              <option value="decline">记录候选人拒绝</option>
                            </>
                          ) : null}
                          <option value="withdraw">撤回 Offer</option>
                        </select>
                      </Field>
                      <Field label="审批意见或候选人答复依据">
                        <Textarea name="note" required maxLength={1000} />
                      </Field>
                      <p className="text-xs text-muted-foreground">
                        接受 / 拒绝由 HR
                        根据实际答复登记，系统不会代替候选人作决定。
                      </p>
                      <Button
                        type="submit"
                        className="min-h-11"
                        variant="outline"
                        disabled={busy}
                      >
                        保存 Offer 操作
                      </Button>
                    </form>
                  ) : null}
                </div>
              ))}
              {!detail.offers.length && !approved ? (
                <p className="text-sm text-muted-foreground">
                  通过人工审核后，可以拟定 Offer。
                </p>
              ) : null}
            </div>
          ) : null}
          {tab === 'onboarding' && !isInterviewer ? (
            <div className="space-y-4">
              {!detail.onboarding ? (
                <p className="text-sm text-muted-foreground">
                  候选人接受 Offer 后，会生成入职清单。
                </p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    逐项核对必要材料和安排，完成必需项目后记录实际入职。
                  </p>
                  {detail.onboardingItems.map((item) => (
                    <form
                      key={`${item.id}:${item.completedAt ?? 'pending'}`}
                      className="space-y-2 rounded-lg border p-3"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const f = new FormData(e.currentTarget);
                        void perform(`/${id}/onboarding`, {
                          action: 'item',
                          itemId: item.id,
                          completed: !item.completedAt,
                          note: f.get('note'),
                        });
                      }}
                    >
                      <p className="text-sm font-medium">
                        {item.completedAt ? '已完成 · ' : '待完成 · '}
                        {item.title}
                        {item.required ? '（必需）' : ''}
                      </p>
                      {closed ? (
                        <p className="text-sm">{item.note}</p>
                      ) : (
                        <>
                          <Field label="核对说明或材料存放位置">
                            <Input
                              name="note"
                              required
                              maxLength={1000}
                              defaultValue={item.note}
                            />
                          </Field>
                          <Button
                            type="submit"
                            className="min-h-11"
                            variant="outline"
                            disabled={busy}
                          >
                            {item.completedAt
                              ? '重新标记待完成'
                              : '确认此项完成'}
                          </Button>
                        </>
                      )}
                    </form>
                  ))}
                  {!closed ? (
                    <>
                      <form
                        className="flex flex-col gap-2 rounded-lg border p-3"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const f = new FormData(e.currentTarget);
                          void perform(`/${id}/onboarding`, {
                            action: 'add',
                            title: f.get('title'),
                            required: f.get('required') === 'on',
                          });
                        }}
                      >
                        <Field label="新增清单项目">
                          <Input name="title" maxLength={200} required />
                        </Field>
                        <label className="flex min-h-11 items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            name="required"
                            defaultChecked
                          />
                          必需完成
                        </label>
                        <Button
                          type="submit"
                          variant="outline"
                          className="min-h-11"
                          disabled={busy}
                        >
                          添加入职事项
                        </Button>
                      </form>
                      <form
                        className="space-y-3 rounded-lg border border-primary/25 p-4"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const f = new FormData(e.currentTarget);
                          void perform(`/${id}/onboarding`, {
                            action: 'confirm',
                            actualStartDate: f.get('date'),
                            note: f.get('note'),
                          });
                        }}
                      >
                        <Field label="实际入职日期">
                          <input
                            className={fieldClass}
                            type="date"
                            name="date"
                            required
                          />
                        </Field>
                        <Field label="入职确认说明">
                          <Textarea name="note" required maxLength={1000} />
                        </Field>
                        <Button
                          type="submit"
                          className="min-h-11"
                          disabled={
                            busy ||
                            detail.onboardingItems.some(
                              (i) => i.required && !i.completedAt,
                            )
                          }
                        >
                          确认已入职
                        </Button>
                      </form>
                    </>
                  ) : (
                    <p className="rounded-lg bg-secondary p-4 text-sm">
                      实际入职：{detail.onboarding.actualStartDate} ·{' '}
                      {detail.onboarding.note}
                    </p>
                  )}
                </>
              )}
            </div>
          ) : null}
          {tab === 'events' && !isInterviewer ? (
            <div className="space-y-3">
              {detail.events.map((e) => (
                <div className="border-l-2 pl-3" key={e.id}>
                  <p className="whitespace-pre-wrap text-sm leading-6">
                    {e.body}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {e.actorName} · {format(e.createdAt)}
                  </p>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
      {busy ? (
        <output className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          正在保存…
        </output>
      ) : null}
    </div>
  );
}
function localDateTime(value: string) {
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}
function deliveryLabel(status: string | null) {
  return status
    ? ((
        {
          queued: '等待发送',
          sending: '发送中',
          sent: 'BOSS 已确认发送',
          failed: '发送失败，可重试',
          uncertain: '结果待核对',
        } as Record<string, string>
      )[status] ?? status)
    : '尚未发送';
}
