'use client';

import { cachedApiJson } from '../workspace-utils';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AuthGate, useCurrentUser } from '../auth-gate';
import { hrStatusLabel } from '../hr-display';
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

function Content() {
  const user = useCurrentUser();
  const canManage = user.role === 'admin' || user.role === 'recruiting_lead';
  const [data, setData] = useState<Row | null>(() =>
    cachedApiJson<Row>('/api/operations/workspace'),
  );
  const [pipeline, setPipeline] = useState<Row | null>(() =>
    cachedApiJson<Row>('/api/pipeline?limit=100'),
  );
  const [department, setDepartment] = useState<Row | null>(() =>
    cachedApiJson<Row>('/api/department/workspace'),
  );
  const [loading, setLoading] = useState(!data || !pipeline || !department);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [operations, pipelineData, departmentData] = await Promise.all([
        apiJson<Row>('/api/operations/workspace'),
        apiJson<Row>('/api/pipeline?limit=100'),
        apiJson<Row>('/api/department/workspace'),
      ]);
      setData(operations);
      setPipeline(pipelineData);
      setDepartment(departmentData);
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function act(job: () => Promise<unknown>, ok: string) {
    if (actionBusy) return;
    setActionBusy(true);
    try {
      await job();
      setMessage(ok);
      setError(null);
      await load();
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

  const messages = rows(data?.messages);
  const tags = rows(data?.tags);
  const people = rows(data?.taggedCandidates);
  const health = rows(data?.health);
  const alerts = rows(data?.alerts);
  const candidates = rows(pipeline?.items);
  const positions = rows(department?.positions);
  const quality = (data?.quality ?? {}) as Row;

  const positionForAccount = (accountId: unknown) =>
    positions.find((position) => position.bossAccountId === accountId);

  return (
    <WorkspaceShell
      current="/operations"
      title="招聘运营"
      description="查看 BOSS 回复、重复联系、OCR/规则质量和运行告警；低频维护工具已收进高级区域。"
    >
      <Notice error={error} message={message} />
      {loading ? <LoadingState label="正在读取运营指标和告警…" /> : null}
      {actionBusy ? <LoadingState compact label="正在保存运营设置…" /> : null}
      {!loading && data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ['候选人', quality.candidateCount],
              ['OCR 失败', quality.ocrFailures],
              ['待人工确认', quality.unknowns],
              ['逾期待办', data.overdue],
            ].map(([label, value]) => (
              <div
                key={String(label)}
                className="rounded-xl border bg-card p-5"
              >
                <p className="text-sm text-muted-foreground">{String(label)}</p>
                <p className="mt-1 text-3xl font-semibold tabular-nums">
                  {typeof value === 'number' ? value : '—'}
                </p>
              </div>
            ))}
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Panel
              title="BOSS 回复记录"
              description="由系统自动去重同步；普通 HR 只需在这里查看。"
            >
              {messages.length ? (
                messages.map((item) => (
                  <div
                    key={stringValue(item.id)}
                    className="rounded-lg border p-3 text-sm"
                  >
                    <b>{stringValue(item.candidateName)}</b> ·{' '}
                    {stringValue(item.positionName)}
                    <p className="mt-1 leading-6">{stringValue(item.body)}</p>
                    <small className="text-muted-foreground">
                      {formatDate(item.sentAt)}
                    </small>
                  </div>
                ))
              ) : (
                <Empty>暂无已同步的候选人回复</Empty>
              )}
            </Panel>

            <Panel
              title="人才库标签与重复提醒"
              description="标签与自然人绑定，便于识别跨岗位申请。"
            >
              <form
                className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-end"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  void act(
                    () =>
                      postJson('/api/operations/tags', {
                        name: form.get('name'),
                        color: 'blue',
                      }),
                    '人才标签已创建',
                  );
                }}
              >
                <Field label="新标签名称" className="flex-1">
                  <input className={inputClass} name="name" required />
                </Field>
                <Button type="submit" disabled={actionBusy}>
                  创建标签
                </Button>
              </form>
              {people.length ? (
                people.map((person) => (
                  <div
                    key={stringValue(person.candidateId)}
                    className="rounded-lg border p-3 text-sm"
                  >
                    <div className="flex flex-wrap gap-2">
                      <b className="min-w-0 flex-1">
                        {stringValue(person.candidateName)}
                      </b>
                      {Number(person.applications) > 1 ? (
                        <Badge>跨岗位候选人</Badge>
                      ) : null}
                      {Number(person.contactCount) > 0 ? (
                        <Badge variant="destructive">
                          历史联系 {String(person.contactCount)} 次
                        </Badge>
                      ) : null}
                    </div>
                    <form
                      className="mt-2 flex flex-col items-stretch gap-2 sm:flex-row sm:items-end"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const form = new FormData(event.currentTarget);
                        void act(
                          () =>
                            postJson('/api/operations/tag-candidate', {
                              candidateId: person.candidateId,
                              tagId: form.get('tagId'),
                            }),
                          '标签已添加',
                        );
                      }}
                    >
                      <Field
                        label={`为 ${stringValue(person.candidateName)} 添加标签`}
                        className="flex-1"
                      >
                        <select className={inputClass} name="tagId" required>
                          <option value="">选择标签</option>
                          {tags.map((tag) => (
                            <option
                              key={stringValue(tag.id)}
                              value={stringValue(tag.id)}
                            >
                              {stringValue(tag.name)}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Button type="submit" size="sm" disabled={actionBusy}>
                        添加
                      </Button>
                    </form>
                  </div>
                ))
              ) : (
                <Empty>暂无人才库记录</Empty>
              )}
            </Panel>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Panel
              title="BOSS 账号状态"
              spotlight="account-health"
              description="真实联系只会信任系统自动探测且未过期的结果。"
            >
              {health.length ? (
                health.map((item) => (
                  <div
                    key={stringValue(item.bossAccountId)}
                    className="rounded-lg border p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <b className="min-w-0 flex-1">
                        {stringValue(
                          positionForAccount(item.bossAccountId)?.name,
                        ) || 'BOSS 招聘账号'}
                      </b>
                      <Badge
                        variant={
                          item.status === 'healthy' && item.authoritative
                            ? 'secondary'
                            : 'outline'
                        }
                      >
                        {hrStatusLabel(item.status)}
                      </Badge>
                      <Badge variant="outline">
                        {item.authoritative ? '自动探测' : '人工观察'}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      最后检查：{formatDate(item.checkedAt)}
                    </p>
                  </div>
                ))
              ) : (
                <Empty>尚未收到系统自动账号检查结果</Empty>
              )}
            </Panel>

            <Panel
              title="运行告警"
              description="优先处理风控、登录失效、OCR 失败和任务停滞。"
            >
              {alerts.length ? (
                alerts.map((alert) => (
                  <div
                    key={stringValue(alert.id)}
                    className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm"
                  >
                    <Badge
                      variant={
                        alert.severity === 'critical'
                          ? 'destructive'
                          : 'outline'
                      }
                    >
                      {alert.severity === 'critical'
                        ? '紧急'
                        : alert.severity === 'warning'
                          ? '需关注'
                          : '提醒'}
                    </Badge>
                    <span className="min-w-0 flex-1">
                      {stringValue(alert.message)}
                    </span>
                    {alert.status === 'open' ? (
                      <Button
                        size="sm"
                        disabled={actionBusy}
                        onClick={() =>
                          void act(
                            () =>
                              postJson(
                                `/api/operations/alerts/${stringValue(alert.id)}/acknowledge`,
                                {},
                              ),
                            '告警已确认',
                          )
                        }
                      >
                        标记已知
                      </Button>
                    ) : (
                      <Badge variant="outline">已处理</Badge>
                    )}
                  </div>
                ))
              ) : (
                <Empty>当前没有未处理告警</Empty>
              )}
            </Panel>
          </div>

          <AdvancedSection
            title="高级联调与数据维护"
            description="仅供内网联调和管理员排障。以下操作会改变数据，不应作为日常 HR 流程。"
          >
            <div className="grid gap-5 lg:grid-cols-2">
              <Panel
                title="写入联调回复"
                description="该记录会被当作候选人回复并影响报表，仅在明确的测试数据上使用。"
              >
                <form
                  className="grid gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (
                      !window.confirm(
                        '这会写入一条会影响回复统计的联调数据。确认继续？',
                      )
                    )
                      return;
                    const form = new FormData(event.currentTarget);
                    void act(
                      () =>
                        postJson('/api/operations/messages/sync', {
                          stateId: form.get('stateId'),
                          externalMessageId: `manual-${Date.now()}`,
                          direction: 'inbound',
                          body: form.get('body'),
                          sentAt: new Date().toISOString(),
                        }),
                      '联调回复已写入，将计入统计',
                    );
                  }}
                >
                  <Field label="测试候选人岗位申请">
                    <select className={inputClass} name="stateId" required>
                      <option value="">选择测试数据</option>
                      {candidates.map((candidate) => (
                        <option
                          key={stringValue(candidate.stateId)}
                          value={stringValue(candidate.stateId)}
                        >
                          {stringValue(candidate.name)} ·{' '}
                          {stringValue(candidate.positionName)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="联调回复内容">
                    <input className={inputClass} name="body" required />
                  </Field>
                  <Button type="submit" variant="outline" disabled={actionBusy}>
                    写入联调回复（会影响统计）
                  </Button>
                </form>
              </Panel>

              <Panel
                title="记录人工账号观察"
                description="人工观察不是权威健康探测，写入后将阻止真实联系，直到系统自动重新确认。"
              >
                {canManage ? (
                  <form
                    className="grid gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (
                        !window.confirm(
                          '人工观察不能代替系统自动探测，会暂时阻止真实联系。确认继续？',
                        )
                      )
                        return;
                      const form = new FormData(event.currentTarget);
                      const position = positions.find(
                        (item) => item.id === form.get('positionId'),
                      );
                      void act(
                        () =>
                          postJson('/api/operations/account-health', {
                            bossAccountId: position?.bossAccountId,
                            status: form.get('status'),
                            authoritative: false,
                            reason: '管理员人工观察',
                            checkedAt: new Date().toISOString(),
                          }),
                        '人工观察已记录，等待系统自动复核',
                      );
                    }}
                  >
                    <Field label="岗位账号">
                      <select className={inputClass} name="positionId" required>
                        <option value="">选择岗位账号</option>
                        {positions.map((position) => (
                          <option
                            key={stringValue(position.id)}
                            value={stringValue(position.id)}
                          >
                            {stringValue(position.name)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="观察到的状态">
                      <select className={inputClass} name="status">
                        <option value="degraded">不稳定</option>
                        <option value="blocked">已受限</option>
                        <option value="unknown">无法确认</option>
                      </select>
                    </Field>
                    <Button
                      type="submit"
                      variant="outline"
                      disabled={actionBusy}
                    >
                      记录人工观察
                    </Button>
                  </form>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    仅招聘负责人或管理员可记录。
                  </p>
                )}
              </Panel>
            </div>
            {canManage ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={actionBusy}
                  onClick={() =>
                    void act(
                      () =>
                        postJson('/api/operations/export', { format: 'json' }),
                      '部门数据导出已生成',
                    )
                  }
                >
                  导出 JSON
                </Button>
                <Button
                  variant="outline"
                  disabled={actionBusy}
                  onClick={() =>
                    void act(
                      () =>
                        postJson('/api/operations/retention', {
                          retentionDays: 730,
                        }),
                      '数据保留期已设为 730 天',
                    )
                  }
                >
                  数据保留 730 天
                </Button>
              </div>
            ) : null}
          </AdvancedSection>
        </>
      ) : null}
    </WorkspaceShell>
  );
}

export function OperationsClient() {
  return (
    <AuthGate allowedRoles={['admin', 'recruiting_lead', 'recruiter']}>
      <Content />
    </AuthGate>
  );
}
