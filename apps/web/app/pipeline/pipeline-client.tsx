'use client';

import { cachedApiJson } from '../workspace-utils';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AuthGate } from '../auth-gate';
import { hrStatusLabel } from '../hr-display';
import { candidateScreeningPresentation } from '../candidate-screening-presentation';
import { WorkspaceShell } from '../workspace-shell';
import {
  AdvancedSection,
  Empty,
  Field,
  inputClass,
  LoadingState,
  Notice,
  Panel,
} from '../workspace-ui';
import {
  apiJson,
  formatDate,
  postJson,
  type Row,
  rows,
  stringValue,
} from '../workspace-utils';
import { CandidateTools } from './candidate-tools';
import { LifecycleWorkspace } from '../lifecycle/lifecycle-workspace';
import { LifecycleDialog } from '../lifecycle/lifecycle-dialog';

function Content() {
  const [view, setView] = useState('followup');
  const [lifecycleState, setLifecycleState] = useState<string | null>(null);
  const [pipeline, setPipeline] = useState<Row | null>(() =>
    cachedApiJson<Row>('/api/pipeline?limit=50'),
  );
  const [department, setDepartment] = useState<Row | null>(() =>
    cachedApiJson<Row>('/api/department/workspace'),
  );
  const [collaboration, setCollaboration] = useState<Row>({});
  const [selected, setSelected] = useState<Row | null>(null);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(!pipeline || !department);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const query =
        filter === 'all' ? '' : `&stage=${encodeURIComponent(filter)}`;
      const [pipelineData, departmentData] = await Promise.all([
        apiJson<Row>(`/api/pipeline?limit=50${query}`),
        apiJson<Row>('/api/department/workspace'),
      ]);
      setPipeline(pipelineData);
      setDepartment(departmentData);
      setSelected((current) =>
        current
          ? (rows(pipelineData.items).find(
              (item) => item.stateId === current.stateId,
            ) ?? null)
          : null,
      );
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
    } finally {
      setLoading(false);
    }
  }, [filter]);

  const loadDetail = useCallback(async (stateId?: string) => {
    setDetailLoading(Boolean(stateId));
    try {
      setCollaboration(
        await apiJson<Row>(
          `/api/collaboration${stateId ? `?stateId=${encodeURIComponent(stateId)}` : ''}`,
        ),
      );
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
      void loadDetail();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load, loadDetail]);

  async function act(job: () => Promise<unknown>, ok: string) {
    if (actionBusy) return;
    setActionBusy(true);
    try {
      await job();
      setMessage(ok);
      setError(null);
      await load();
      await loadDetail(selected ? stringValue(selected.stateId) : undefined);
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : String(actionError),
      );
    } finally {
      setActionBusy(false);
    }
  }

  const items = rows(pipeline?.items);
  const stages = rows(department?.stages);
  const users = rows(department?.users);
  const workItems = rows(collaboration.workItems);
  const interviews = rows(collaboration.interviews);
  const timeline = [
    ...rows(collaboration.activities),
    ...rows(collaboration.notes),
  ];
  const stateId = selected ? stringValue(selected.stateId) : '';
  const stageLabel = (value: unknown) =>
    stringValue(stages.find((stage) => stage.key === value)?.label) ||
    hrStatusLabel(value, '其他阶段');
  const userLabel = (value: unknown) =>
    stringValue(users.find((user) => user.id === value)?.displayName) ||
    '未分配成员';
  const canMoveToStage = (stage: unknown) => {
    const review = stringValue(selected?.reviewStatus);
    const target = stringValue(stage);
    if (review === 'rejected') return target === 'rejected';
    if (review === 'pending' || review === 'not_required') {
      return target === 'screening' || target === 'review';
    }
    return true;
  };

  return (
    <WorkspaceShell
      current="/pipeline"
      title="招聘流程"
      description="从候选人跟进到面试、录用与入职，查看每一步进度。"
    >
      <div className="flex flex-wrap gap-2">
        <Button
          variant={view === 'followup' ? 'secondary' : 'ghost'}
          className="min-h-11"
          aria-pressed={view === 'followup'}
          onClick={() => setView('followup')}
        >
          跟进与录用
        </Button>
        <Button
          variant={view === 'screening' ? 'secondary' : 'ghost'}
          className="min-h-11"
          aria-pressed={view === 'screening'}
          onClick={() => setView('screening')}
        >
          筛选候选人
        </Button>
      </div>
      {view === 'followup' ? (
        <LifecycleWorkspace />
      ) : (
        <>
          <Notice error={error} message={message} />
          {loading ? <LoadingState label="正在读取候选人流程…" /> : null}
          {actionBusy ? (
            <LoadingState compact label="正在保存候选人流程…" />
          ) : null}
          {!loading && pipeline && department ? (
            <>
              <div className="grid gap-5 xl:grid-cols-[1.3fr_1fr]">
                <Panel
                  title="候选人流程"
                  description={`共 ${typeof pipeline.total === 'number' ? pipeline.total : items.length} 条岗位申请`}
                >
                  <Field label="招聘阶段筛选">
                    <select
                      className={inputClass}
                      value={filter}
                      onChange={(event) => setFilter(event.target.value)}
                    >
                      <option value="all">全部阶段</option>
                      {stages.map((stage) => (
                        <option
                          key={stringValue(stage.key)}
                          value={stringValue(stage.key)}
                        >
                          {stringValue(stage.label)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {items.length ? (
                    items.map((item) => (
                      <button
                        key={stringValue(item.stateId)}
                        type="button"
                        className={`min-h-11 w-full rounded-lg border p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected?.stateId === item.stateId ? 'border-primary bg-primary/5' : ''}`}
                        onClick={() => {
                          setSelected(item);
                          void loadDetail(stringValue(item.stateId));
                        }}
                      >
                        <span className="flex flex-wrap items-center gap-2">
                          <b>{stringValue(item.name)}</b>
                          <Badge variant="outline">
                            {stringValue(item.positionName)}
                          </Badge>
                          <Badge>{stageLabel(item.stage)}</Badge>
                          {item.doNotContact ? (
                            <Badge variant="destructive">禁止联系</Badge>
                          ) : null}
                        </span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          机器判定：
                          {
                            candidateScreeningPresentation({
                              ruleDecision: stringValue(item.ruleDecision),
                              resumeScreeningStatus: stringValue(
                                item.resumeScreeningStatus,
                              ),
                            }).label
                          }{' '}
                          · 人工审核：
                          {hrStatusLabel(item.reviewStatus)}
                        </span>
                      </button>
                    ))
                  ) : (
                    <Empty>当前筛选条件下没有候选人</Empty>
                  )}
                </Panel>

                <Panel
                  title={
                    selected ? stringValue(selected.name) : '候选人后续处理'
                  }
                >
                  {!selected ? (
                    <Empty>请先从左侧选择候选人</Empty>
                  ) : detailLoading ? (
                    <LoadingState label="正在读取候选人跟进记录…" />
                  ) : (
                    <>
                      <div>
                        <p className="mb-2 text-sm font-medium">招聘阶段</p>
                        <div className="flex flex-wrap gap-2">
                          {stages.map((stage) => (
                            <Button
                              size="sm"
                              disabled={
                                actionBusy || !canMoveToStage(stage.key)
                              }
                              variant={
                                selected.stage === stage.key
                                  ? 'default'
                                  : 'outline'
                              }
                              key={stringValue(stage.key)}
                              onClick={() =>
                                void act(
                                  () =>
                                    postJson(`/api/pipeline/${stateId}/stage`, {
                                      stage: stage.key,
                                      rejectionReason:
                                        stage.key === 'rejected'
                                          ? '不符合当前岗位要求'
                                          : null,
                                    }),
                                  '招聘阶段已更新',
                                )
                              }
                            >
                              {stringValue(stage.label)}
                            </Button>
                          ))}
                        </div>
                      </div>
                      {selected.reviewStatus === 'pending' ||
                      selected.reviewStatus === 'not_required' ? (
                        <p className="rounded-lg border bg-muted/35 p-3 text-xs leading-5 text-muted-foreground">
                          请先在“候选人审核”完成人工结论，再推进到后续阶段。机器判定不符合时也可由
                          HR 记录原因后改判。
                        </p>
                      ) : null}
                      <form
                        className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-end"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const form = new FormData(event.currentTarget);
                          void act(
                            () =>
                              postJson(`/api/pipeline/${stateId}/notes`, {
                                body: form.get('body'),
                                mentionedUserIds: [],
                              }),
                            '跟进备注已添加',
                          );
                        }}
                      >
                        <Field label="跟进备注" className="flex-1">
                          <input className={inputClass} name="body" required />
                        </Field>
                        <Button type="submit" disabled={actionBusy}>
                          添加备注
                        </Button>
                      </form>
                      <Button
                        variant={
                          selected.doNotContact ? 'outline' : 'destructive'
                        }
                        disabled={actionBusy}
                        onClick={() => {
                          const enabling = !selected.doNotContact;
                          if (
                            enabling &&
                            !window.confirm(
                              '设为禁止联系后，所有岗位都不应再向该候选人发送消息。是否继续？',
                            )
                          )
                            return;
                          void act(
                            () =>
                              postJson('/api/talent/do-not-contact', {
                                candidateId: selected.candidateId,
                                active: enabling,
                                reason: 'HR 人工控制',
                              }),
                            enabling ? '已设为禁止联系' : '已解除禁止联系',
                          );
                        }}
                      >
                        {selected.doNotContact
                          ? '解除禁止联系'
                          : '设为禁止联系'}
                      </Button>
                      <form
                        className="grid gap-2 rounded-lg bg-muted/40 p-3"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const form = new FormData(event.currentTarget);
                          void act(
                            () =>
                              postJson('/api/collaboration/work-items', {
                                stateId,
                                assignedTo: form.get('user'),
                                title: form.get('title'),
                                dueAt: form.get('due') || null,
                              }),
                            '跟进待办已创建',
                          );
                        }}
                      >
                        <Field label="跟进事项">
                          <input className={inputClass} name="title" required />
                        </Field>
                        <Field label="负责人">
                          <select className={inputClass} name="user" required>
                            <option value="">选择负责人</option>
                            {users.map((member) => (
                              <option
                                key={stringValue(member.id)}
                                value={stringValue(member.id)}
                              >
                                {stringValue(member.displayName)}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label="截止时间">
                          <input
                            className={inputClass}
                            name="due"
                            type="datetime-local"
                          />
                        </Field>
                        <Button type="submit" disabled={actionBusy}>
                          创建跟进待办
                        </Button>
                      </form>
                      {selected.reviewStatus === 'approved' ? (
                        <Button
                          className="mb-4 min-h-11"
                          onClick={() => setLifecycleState(stateId)}
                        >
                          进入招聘跟进与录用
                        </Button>
                      ) : null}
                      <AdvancedSection
                        title="面试、附件与反馈"
                        description="进入面试阶段后再使用，不影响前面的筛选与审核流程。"
                      >
                        <CandidateTools
                          stateId={stateId}
                          users={users}
                          interviews={interviews}
                          act={act}
                          disabled={actionBusy}
                        />
                      </AdvancedSection>
                    </>
                  )}
                </Panel>
              </div>

              <div className="grid gap-5 md:grid-cols-2">
                <Panel title="跟进待办">
                  {workItems.length ? (
                    workItems.map((item) => (
                      <div
                        key={stringValue(item.id)}
                        className="rounded-lg border p-3 text-sm"
                      >
                        <b>{stringValue(item.title)}</b>
                        <p className="mt-1 text-muted-foreground">
                          {userLabel(item.assignedTo)} ·{' '}
                          {formatDate(item.dueAt)}
                        </p>
                        {item.status === 'open' ? (
                          <Button
                            className="mt-2"
                            size="sm"
                            disabled={actionBusy}
                            onClick={() =>
                              void act(
                                () =>
                                  postJson(
                                    `/api/collaboration/work-items/${stringValue(item.id)}/complete`,
                                    {},
                                  ),
                                '待办已完成',
                              )
                            }
                          >
                            标记完成
                          </Button>
                        ) : (
                          <Badge className="mt-2" variant="outline">
                            已完成
                          </Badge>
                        )}
                      </div>
                    ))
                  ) : (
                    <Empty>当前没有跟进待办</Empty>
                  )}
                </Panel>
                <Panel title="候选人时间线">
                  {timeline.length ? (
                    timeline.map((item, index) => (
                      <div
                        key={stringValue(item.id) || index}
                        className="border-l-2 pl-3 text-sm"
                      >
                        <p>
                          {stringValue(item.summary) || stringValue(item.body)}
                        </p>
                        <small className="text-muted-foreground">
                          {formatDate(item.createdAt)}
                        </small>
                      </div>
                    ))
                  ) : (
                    <Empty>选择候选人后查看时间线</Empty>
                  )}
                </Panel>
              </div>
            </>
          ) : null}
        </>
      )}
      <LifecycleDialog
        open={Boolean(lifecycleState)}
        onOpenChange={(open) => {
          if (!open) setLifecycleState(null);
        }}
        {...(lifecycleState ? { stateId: lifecycleState } : {})}
      />
    </WorkspaceShell>
  );
}

export function PipelineClient() {
  return (
    <AuthGate>
      <Content />
    </AuthGate>
  );
}
