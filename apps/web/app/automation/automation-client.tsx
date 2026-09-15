'use client';

import { cachedApiJson } from '../workspace-utils';

import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AuthGate, useCurrentUser } from '../auth-gate';
import {
  contactBlockReasonLabel,
  contactRuntimePresentation,
  hrStatusLabel,
} from '../hr-display';
import { WorkspaceShell } from '../workspace-shell';
import {
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

const defaultPolicy = {
  dailyLimit: 50,
  hourlyLimit: 10,
  cooldownMinutes: 30,
  startMinute: 540,
  endMinute: 1260,
};

function Content() {
  const authUser = useCurrentUser();
  const [data, setData] = useState<Row | null>(() =>
    cachedApiJson<Row>('/api/automation/workspace'),
  );
  const [department, setDepartment] = useState<Row | null>(() =>
    cachedApiJson<Row>('/api/department/workspace'),
  );
  const [dashboard, setDashboard] = useState<Row | null>(() =>
    cachedApiJson<Row>('/api/dashboard'),
  );
  const [readiness, setReadiness] = useState<Row | null>(null);
  const [readinessChecking, setReadinessChecking] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [loading, setLoading] = useState(!data || !department || !dashboard);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [automation, departmentWorkspace, dashboardData] =
        await Promise.all([
          apiJson<Row>('/api/automation/workspace'),
          apiJson<Row>('/api/department/workspace'),
          apiJson<Row>('/api/dashboard'),
        ]);
      setData(automation);
      setDepartment(departmentWorkspace);
      setDashboard(dashboardData);
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

  const controls = rows(data?.controls);
  const positions = rows(department?.positions);
  const tasks = rows(dashboard?.tasks);
  const departmentUser = (department?.currentUser ?? {}) as Row;
  const mode = contactRuntimePresentation({
    loaded: data !== null && dashboard !== null,
    requestFailed: !loading && (data === null || dashboard === null),
    realGreetingEnabled: dashboard?.realGreetingEnabled,
    contactDispatchMode: dashboard?.contactDispatchMode,
    sideEffectsMode: dashboard?.sideEffectsMode,
  });
  const automationMode = contactRuntimePresentation({
    loaded: data !== null,
    requestFailed: !loading && data === null,
    realGreetingEnabled: dashboard?.realGreetingEnabled,
    contactDispatchMode: data?.contactDispatchMode,
    sideEffectsMode: data?.sideEffectsMode,
  });
  const effectiveMode =
    mode.state === automationMode.state
      ? mode
      : contactRuntimePresentation({
          loaded: true,
          realGreetingEnabled: dashboard?.realGreetingEnabled,
          contactDispatchMode: '配置来源不一致',
          sideEffectsMode: '配置来源不一致',
        });
  const readinessMode = readiness
    ? contactRuntimePresentation({
        loaded: true,
        realGreetingEnabled: dashboard?.realGreetingEnabled,
        contactDispatchMode: readiness.contactDispatchMode,
        sideEffectsMode: readiness.sideEffectsMode,
      })
    : null;
  const readinessModeMatches =
    readinessMode !== null &&
    readinessMode.state !== 'blocked' &&
    readinessMode.state === effectiveMode.state;
  const readinessPassed = readiness?.ready === true && readinessModeMatches;
  const realContactAvailable =
    data?.realContactTransportAvailable === true &&
    dashboard?.realContactTransportAvailable === true;

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

  function policyFor(scopeType: string, scopeId: string): unknown {
    return (
      controls.find(
        (control) =>
          control.scopeType === scopeType && control.scopeId === scopeId,
      )?.policy ?? defaultPolicy
    );
  }

  function setControl(
    scopeType: string,
    scopeId: string,
    enabled: boolean,
    emergencyStop = false,
  ) {
    if (
      enabled &&
      !window.confirm(
        `确认开启${objectLabel(scopeType, scopeId)}联系？开启后，只有逐候选人完成消息预览、勾选最终确认且发送前安全检查全部通过，系统才会执行对应动作。`,
      )
    )
      return;
    return act(
      () =>
        postJson('/api/automation/controls', {
          scopeType,
          scopeId,
          enabled,
          approvalRequired: false,
          policy: policyFor(scopeType, scopeId),
          emergencyStop,
        }),
      emergencyStop
        ? '紧急停止已启用'
        : enabled
          ? '联系安全开关已开启'
          : '联系安全开关已关闭',
    );
  }

  function objectLabel(scopeType: unknown, scopeId: unknown): string {
    const type = stringValue(scopeType);
    const id = stringValue(scopeId);
    if (type === 'global') return '全系统';
    if (type === 'department') return '当前部门';
    if (type === 'position') {
      return `岗位：${stringValue(positions.find((item) => item.id === id)?.name) || '已删除岗位'}`;
    }
    if (type === 'task') {
      const task = tasks.find((item) => item.id === id);
      return `任务：${stringValue(task?.positionName) || '已结束任务'}${task?.createdAt ? ` · ${formatDate(task.createdAt)}` : ''}`;
    }
    return '未知控制范围';
  }

  return (
    <WorkspaceShell
      current="/automation"
      title="联系安全设置"
      description="管理真实联系安全开关和只读就绪检查；打招呼或发消息仍须回到联系名单逐人预览确认。"
    >
      <Notice error={error} message={message} />
      {loading ? <LoadingState label="正在核对联系开关和安全状态…" /> : null}
      {actionBusy ? (
        <LoadingState compact label="正在保存联系安全设置…" />
      ) : null}
      {!loading && (!data || !department || !dashboard) ? (
        <div
          role="alert"
          className="rounded-xl border border-destructive/35 bg-destructive/8 p-4 text-sm"
        >
          <p className="font-semibold">联系状态无法确认，已阻止真实联系</p>
          <p className="mt-1 text-muted-foreground">
            请先恢复控制面连接，不要在状态未知时调整联系开关。
          </p>
        </div>
      ) : null}
      {!loading && data && department && dashboard ? (
        <>
          <div
            role={effectiveMode.state === 'blocked' ? 'alert' : 'status'}
            className={`flex gap-3 rounded-xl border p-4 text-sm ${effectiveMode.state === 'blocked' ? 'border-destructive/35 bg-destructive/8' : effectiveMode.state === 'real' ? 'border-warning/35 bg-warning/8' : 'bg-muted/35'}`}
          >
            {effectiveMode.state === 'blocked' ? (
              <ShieldAlert
                className="mt-0.5 size-5 shrink-0 text-destructive"
                aria-hidden="true"
              />
            ) : (
              <ShieldCheck
                className="mt-0.5 size-5 shrink-0"
                aria-hidden="true"
              />
            )}
            <div>
              <p className="font-semibold">{effectiveMode.label}</p>
              <p className="mt-1 leading-6 text-muted-foreground">
                {effectiveMode.detail}
              </p>
            </div>
          </div>

          {!realContactAvailable ? (
            <output className="rounded-xl border border-primary/25 bg-primary/5 p-4 text-sm">
              <p className="font-semibold">
                真实联系尚未交付，所有开启入口已禁用
              </p>
              <p className="mt-1 leading-6 text-muted-foreground">
                你仍可维护模板、预览消息和执行只读安全检查；环境变量或页面开关都不能绕过此限制。
              </p>
            </output>
          ) : null}

          <div className="grid gap-5 lg:grid-cols-2">
            <Panel
              title="全局与部门安全开关"
              description="关闭任一层后，该范围内的联系任务均不应执行。"
            >
              <div className="flex flex-wrap gap-2">
                {authUser.role === 'admin' ? (
                  <Button
                    variant="outline"
                    disabled={actionBusy || !realContactAvailable}
                    onClick={() => void setControl('global', 'global', true)}
                  >
                    {realContactAvailable ? '开启全局联系' : '全局联系不可开启'}
                  </Button>
                ) : null}
                {authUser.role === 'admin' ? (
                  <Button
                    variant="destructive"
                    disabled={actionBusy}
                    onClick={() =>
                      void setControl('global', 'global', false, true)
                    }
                  >
                    紧急停止全系统联系
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  disabled={actionBusy || !realContactAvailable}
                  onClick={() =>
                    void setControl(
                      'department',
                      stringValue(departmentUser.departmentId),
                      true,
                    )
                  }
                >
                  {realContactAvailable
                    ? '开启本部门联系'
                    : '本部门联系不可开启'}
                </Button>
                <Button
                  variant="destructive"
                  disabled={actionBusy}
                  onClick={() =>
                    void setControl(
                      'department',
                      stringValue(departmentUser.departmentId),
                      false,
                      true,
                    )
                  }
                >
                  紧急停止本部门联系
                </Button>
              </div>
              {controls.length ? (
                controls.map((control) => (
                  <div
                    key={stringValue(control.id)}
                    className="flex flex-wrap items-center gap-2 rounded-lg border p-3"
                  >
                    <b className="min-w-0 flex-1">
                      {objectLabel(control.scopeType, control.scopeId)}
                    </b>
                    <Badge variant={control.enabled ? 'secondary' : 'outline'}>
                      {control.enabled ? '已开启' : '已关闭'}
                    </Badge>
                    {control.emergencyStop ? (
                      <Badge variant="destructive">紧急停止中</Badge>
                    ) : null}
                    {control.approvalRequired ? (
                      <Badge variant="destructive">
                        旧审批配置未生效，请重新开启
                      </Badge>
                    ) : null}
                    <span className="text-xs text-muted-foreground">
                      配置版本 {String(control.version)}
                    </span>
                  </div>
                ))
              ) : (
                <Empty>尚未配置联系开关</Empty>
              )}
            </Panel>

            <Panel
              title="岗位与任务范围"
              description="只开启明确需要联系的岗位或筛选任务。"
            >
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  void setControl(
                    'position',
                    stringValue(form.get('positionId')),
                    form.get('enabled') === 'true',
                  );
                }}
              >
                <Field label="岗位">
                  <select className={inputClass} name="positionId" required>
                    <option value="">选择岗位</option>
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
                <Field label="岗位联系开关">
                  <select className={inputClass} name="enabled">
                    {realContactAvailable ? (
                      <option value="true">开启</option>
                    ) : null}
                    <option value="false">关闭</option>
                  </select>
                </Field>
                <Button type="submit" disabled={actionBusy}>
                  保存岗位开关
                </Button>
              </form>
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  void setControl(
                    'task',
                    stringValue(form.get('taskId')),
                    form.get('enabled') === 'true',
                  );
                }}
              >
                <Field label="筛选任务">
                  <select className={inputClass} name="taskId" required>
                    <option value="">选择筛选任务</option>
                    {tasks.map((task) => (
                      <option
                        key={stringValue(task.id)}
                        value={stringValue(task.id)}
                      >
                        {formatDate(task.createdAt)} ·{' '}
                        {stringValue(task.positionName)} ·{' '}
                        {hrStatusLabel(task.status)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="任务联系开关">
                  <select className={inputClass} name="enabled">
                    {realContactAvailable ? (
                      <option value="true">开启</option>
                    ) : null}
                    <option value="false">关闭</option>
                  </select>
                </Field>
                <Button type="submit" variant="outline" disabled={actionBusy}>
                  保存任务开关
                </Button>
              </form>
              <p className="text-xs leading-5 text-muted-foreground">
                实际联系时段、额度与冷却时间以后台处理程序和发送前检查返回的最新策略为准。
              </p>
            </Panel>
          </div>

          <div>
            <Panel
              title="联系前安全检查"
              description="只读检查所有门禁，不创建联系任务，也不发送消息。"
            >
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  const positionId = stringValue(form.get('positionId'));
                  setReadiness(null);
                  setReadinessChecking(true);
                  void apiJson<Row>(
                    `/api/automation/readiness?positionId=${encodeURIComponent(positionId)}`,
                  )
                    .then((result) => {
                      setReadiness(result);
                      setError(null);
                    })
                    .catch((readinessError) =>
                      setError(
                        readinessError instanceof Error
                          ? readinessError.message
                          : String(readinessError),
                      ),
                    )
                    .finally(() => setReadinessChecking(false));
                }}
              >
                <Field label="检查岗位">
                  <select className={inputClass} name="positionId" required>
                    <option value="">选择岗位</option>
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
                <Button type="submit" disabled={readinessChecking}>
                  {readinessChecking ? '正在检查…' : '检查是否就绪'}
                </Button>
              </form>
              {readiness ? (
                <div className="rounded-lg border p-4">
                  <Badge variant={readinessPassed ? 'default' : 'destructive'}>
                    {readinessPassed ? '安全检查通过' : '当前不可执行'}
                  </Badge>
                  {Array.isArray(readiness.reasons) &&
                  readiness.reasons.length ? (
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                      {readiness.reasons.map((reason, index) => (
                        <li key={index}>{contactBlockReasonLabel(reason)}</li>
                      ))}
                    </ul>
                  ) : null}
                  <p className="mt-2 text-xs text-muted-foreground">
                    当前检查模式：
                    {readinessModeMatches
                      ? readinessMode?.label
                      : '运行模式来源不一致，已阻止'}
                    。检查结果不会自动发送。
                  </p>
                </div>
              ) : (
                <Empty>选择岗位后可执行一次只读安全检查</Empty>
              )}
            </Panel>
          </div>
        </>
      ) : null}
    </WorkspaceShell>
  );
}

export function AutomationClient() {
  return (
    <AuthGate allowedRoles={['admin', 'recruiting_lead']}>
      <Content />
    </AuthGate>
  );
}
