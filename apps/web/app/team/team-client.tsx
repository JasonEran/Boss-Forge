'use client';

import { cachedApiJson } from '../workspace-utils';

import { useCallback, useEffect, useState } from 'react';
import { Clock3, Eye, RotateCcw, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AuthGate } from '../auth-gate';
import { hrStatusLabel, safeIdentifierLabel } from '../hr-display';
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
import { apiJson, postJson, Row, rows, stringValue } from '../workspace-utils';

function TeamContent() {
  const [data, setData] = useState<Row | null>(() =>
    cachedApiJson<Row>('/api/department/workspace'),
  );
  const [policyData, setPolicyData] = useState<Row | null>(() =>
    cachedApiJson<Row>('/api/system/resume-view-policy'),
  );
  const [loading, setLoading] = useState(!data || !policyData);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [workspace, resumePolicy] = await Promise.all([
        apiJson<Row>('/api/department/workspace'),
        apiJson<Row>('/api/system/resume-view-policy'),
      ]);
      setData(workspace);
      setPolicyData(resumePolicy);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  const users = rows(data?.users);
  const positions = rows(data?.positions);
  const members = rows(data?.members);
  const stages = rows(data?.stages);
  const policy = (policyData?.policy ?? {}) as Row;
  const usage = (policyData?.usage ?? {}) as Row;
  const quotasEnabled = policy.quotasEnabled === true;
  const policyState = stringValue(policyData?.state);
  const policyStateLabel: Record<string, string> = {
    ready: quotasEnabled ? '时段与额度允许' : '无限制（额度已关闭）',
    outside_working_hours: '工作时段外暂停',
    daily_quota_reached: '今日额度已用完',
    daily_limit_reached: '今日额度已用完',
    daily_hard_limit_reached: '今日绝对上限已用完',
    hourly_quota_reached: '小时额度已用完',
    hourly_limit_reached: '小时额度已用完',
  };
  const policyStateKnown = Object.hasOwn(policyStateLabel, policyState);
  const numberOrDash = (value: unknown) =>
    typeof value === 'number' ? String(value) : '—';
  async function action(work: () => Promise<unknown>, success: string) {
    if (actionBusy) return;
    setActionBusy(true);
    try {
      await work();
      setMessage(success);
      setError(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(false);
    }
  }
  return (
    <WorkspaceShell
      current="/team"
      title="系统设置"
      description="查看当前生效的自动化策略，并管理团队、岗位权限与招聘阶段。"
    >
      <Notice error={error} message={message} />
      {loading ? (
        <LoadingState label="正在读取简历查看策略和团队设置…" />
      ) : null}
      {actionBusy ? <LoadingState compact label="正在保存系统设置…" /> : null}
      {!loading && data && policyData ? (
        <>
          <Panel
            title="简历查看策略"
            description={
              quotasEnabled
                ? '这里展示系统当前实际生效的限制；查看简历与发送联系消息分别计数。'
                : '当前已关闭查看额度与节奏限制（无限制）。下方仅展示实际查看统计与停留时长，不会按日/小时上限停筛。'
            }
          >
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/30 p-4">
              <div>
                <p className="text-sm font-medium">
                  BOSS 账号：
                  {policyData.accountId
                    ? safeIdentifierLabel(policyData.accountId)
                    : '未配置'}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {quotasEnabled
                    ? '统计时区：上海；额度在每日 00:00 重新计算。任务页会另行显示批次休息或 Worker 暂停。'
                    : '统计时区：上海。额度与批次暂停均已关闭；风控/验证码仍会立即停筛。'}
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Badge
                  variant={
                    policyState === 'ready'
                      ? 'default'
                      : policyStateKnown
                        ? 'secondary'
                        : 'destructive'
                  }
                >
                  {policyStateLabel[policyState] ?? '状态未知，已暂停继续查看'}
                </Badge>
                {quotasEnabled ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={actionBusy}
                    onClick={() => {
                      if (
                        !window.confirm(
                          '这只会重置本轮软额度，不会清除今日实际查看数，也不会突破安全上限。是否继续？',
                        )
                      )
                        return;
                      void action(
                        () =>
                          postJson('/api/system/resume-view-policy/reset', {}),
                        '本轮简历查看软额度已重置',
                      );
                    }}
                  >
                    <RotateCcw aria-hidden="true" />
                    重置本轮软额度
                  </Button>
                ) : null}
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl border bg-card p-4">
                <Eye aria-hidden="true" className="size-5 text-primary" />
                <p className="mt-3 text-sm text-muted-foreground">单份简历</p>
                <p className="mt-1 text-xl font-semibold">
                  约 {numberOrDash(policy.dwellTargetSeconds)} 秒
                </p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  简历完整加载后开始计时；加载和识别较慢时会等待完成。
                </p>
              </div>
              <div className="rounded-xl border bg-card p-4">
                <ShieldCheck
                  aria-hidden="true"
                  className="size-5 text-primary"
                />
                <p className="mt-3 text-sm text-muted-foreground">今日已查看</p>
                {quotasEnabled ? (
                  <>
                    <p className="mt-1 text-xl font-semibold">
                      {numberOrDash(usage.viewsToday)} /{' '}
                      {numberOrDash(policy.dailyLimit)} 份
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      本轮软额度可重置；今日实际共查看{' '}
                      {numberOrDash(usage.absoluteViewsToday)} 份，仍受{' '}
                      {numberOrDash(policy.dailyHardLimit)} 份系统硬上限保护。
                    </p>
                  </>
                ) : (
                  <>
                    <p className="mt-1 text-xl font-semibold">无限制</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      今日已实际查看{' '}
                      {numberOrDash(usage.absoluteViewsToday)}{' '}
                      份（仅统计，不设上限、不停筛）。
                    </p>
                  </>
                )}
              </div>
              <div className="rounded-xl border bg-card p-4">
                <Clock3 aria-hidden="true" className="size-5 text-primary" />
                <p className="mt-3 text-sm text-muted-foreground">最近一小时</p>
                {quotasEnabled ? (
                  <>
                    <p className="mt-1 text-xl font-semibold">
                      {numberOrDash(usage.viewsLastHour)} /{' '}
                      {numberOrDash(policy.hourlyLimit)} 份
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      达到小时额度后自动等待，不再打开新简历。
                    </p>
                  </>
                ) : (
                  <>
                    <p className="mt-1 text-xl font-semibold">无限制</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      近一小时已查看{' '}
                      {numberOrDash(usage.viewsLastHour)}{' '}
                      份（仅统计，不设小时上限）。
                    </p>
                  </>
                )}
              </div>
              <div className="rounded-xl border bg-card p-4">
                <Clock3 aria-hidden="true" className="size-5 text-primary" />
                <p className="mt-3 text-sm text-muted-foreground">运行节奏</p>
                {quotasEnabled ? (
                  <>
                    <p className="mt-1 text-xl font-semibold">
                      {numberOrDash(policy.workdayStartHour)}:00–
                      {numberOrDash(policy.workdayEndHour)}:00
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      连续 {numberOrDash(policy.continuousBatchSize)} 份后暂停{' '}
                      {numberOrDash(policy.breakMinutes)} 分钟。
                    </p>
                  </>
                ) : (
                  <>
                    <p className="mt-1 text-xl font-semibold">无限制</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      全天可跑，不分批暂停；打招呼人数按任务设定，直到成功发出或列表耗尽。账号每天最多 200 个打招呼。
                    </p>
                  </>
                )}
              </div>
            </div>
            <p className="rounded-lg border bg-muted/30 p-3 text-sm leading-6 text-muted-foreground">
              {quotasEnabled
                ? '每次打开都先计入查看额度；可恢复异常会在 5、10 分钟退避后最多再试 2 次，不会在同一次处理中连续重开。检测到验证码、访问受限或平台风控时，系统会立即停止查看，并在登录页显示风控状态。'
                : '额度关闭后不再按日/小时/批次限制停筛。可恢复异常仍会在 5、10 分钟退避后最多再试 2 次。检测到验证码、访问受限或平台风控时，系统会立即停止查看，并在登录页显示风控状态。'}
            </p>
          </Panel>
          <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
            <Panel
              title="部门成员"
              description="管理员与招聘负责人可创建和停用账号。"
            >
              <div className="space-y-2">
                {users.length ? (
                  users.map((user) => (
                    <div
                      key={stringValue(user.id)}
                      className="flex flex-wrap items-center gap-3 rounded-lg border p-3"
                    >
                      <div className="min-w-52 flex-1">
                        <p className="font-medium">
                          {stringValue(user.displayName)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {stringValue(user.email)}
                        </p>
                      </div>
                      <Badge variant="outline">
                        {hrStatusLabel(user.role)}
                      </Badge>
                      <Badge
                        variant={
                          user.status === 'active' ? 'default' : 'secondary'
                        }
                      >
                        {hrStatusLabel(user.status)}
                      </Badge>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={actionBusy}
                        onClick={() =>
                          void action(
                            () =>
                              postJson(
                                `/api/team/users/${stringValue(user.id)}/status`,
                                {
                                  status:
                                    user.status === 'active'
                                      ? 'disabled'
                                      : 'active',
                                },
                              ),
                            '账号状态已更新',
                          )
                        }
                      >
                        {user.status === 'active' ? '停用' : '启用'}
                      </Button>
                    </div>
                  ))
                ) : (
                  <Empty />
                )}
              </div>
              <form
                className="grid gap-3 rounded-xl bg-muted/40 p-4 md:grid-cols-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const f = new FormData(event.currentTarget);
                  void action(
                    () =>
                      postJson('/api/team/users', {
                        email: f.get('email'),
                        displayName: f.get('displayName'),
                        role: f.get('role'),
                        password: f.get('password'),
                      }),
                    '成员已创建',
                  );
                }}
              >
                <Field label="姓名">
                  <input
                    className={inputClass}
                    name="displayName"
                    autoComplete="name"
                    required
                  />
                </Field>
                <Field label="内部邮箱">
                  <input
                    className={inputClass}
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                  />
                </Field>
                <Field label="角色">
                  <select
                    className={inputClass}
                    name="role"
                    defaultValue="recruiter"
                  >
                    <option value="recruiter">HR</option>
                    <option value="recruiting_lead">招聘负责人</option>
                    <option value="interviewer">面试官</option>
                    <option value="admin">管理员</option>
                  </select>
                </Field>
                <Field label="初始密码" hint="至少 12 位">
                  <input
                    className={inputClass}
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    required
                  />
                </Field>
                <Button
                  type="submit"
                  className="md:col-span-2"
                  disabled={actionBusy}
                >
                  创建成员
                </Button>
              </form>
            </Panel>
            <Panel
              title="岗位协作者"
              description="成员只能看到被分配岗位；负责人可看到部门全部岗位。"
            >
              {members.length ? (
                members.map((item) => (
                  <div
                    key={
                      stringValue(item.positionId) +
                      '-' +
                      stringValue(item.userId)
                    }
                    className="flex justify-between rounded-lg border p-3 text-sm"
                  >
                    <span>{stringValue(item.displayName)}</span>
                    <Badge variant="outline">
                      {hrStatusLabel(item.memberRole)}
                    </Badge>
                  </div>
                ))
              ) : (
                <Empty />
              )}
              <form
                className="space-y-3 rounded-xl bg-muted/40 p-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  const f = new FormData(event.currentTarget);
                  const positionId = stringValue(f.get('positionId'));
                  void action(
                    () =>
                      postJson(`/api/positions/${positionId}/members`, {
                        userId: f.get('userId'),
                        memberRole: f.get('memberRole'),
                      }),
                    '岗位成员已分配',
                  );
                }}
              >
                <Field label="岗位">
                  <select className={inputClass} name="positionId" required>
                    <option value="">选择岗位</option>
                    {positions.map((p) => (
                      <option key={stringValue(p.id)} value={stringValue(p.id)}>
                        {stringValue(p.name)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="成员">
                  <select className={inputClass} name="userId" required>
                    <option value="">选择成员</option>
                    {users.map((u) => (
                      <option key={stringValue(u.id)} value={stringValue(u.id)}>
                        {stringValue(u.displayName)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="岗位权限">
                  <select
                    className={inputClass}
                    name="memberRole"
                    defaultValue="recruiter"
                  >
                    <option value="owner">负责人</option>
                    <option value="recruiter">HR</option>
                    <option value="interviewer">面试官</option>
                    <option value="viewer">只读</option>
                  </select>
                </Field>
                <Button type="submit" disabled={actionBusy}>
                  保存分配
                </Button>
              </form>
            </Panel>
          </div>
          <AdvancedSection
            title="高级：招聘阶段配置"
            description="阶段结构是低频管理项，普通 HR 无需为日常筛选修改。"
          >
            <Panel
              title="招聘阶段配置"
              description="各岗位申请独立保存阶段，同一自然人可处于不同岗位的不同阶段。"
            >
              <div className="flex flex-wrap gap-2">
                {stages.map((stage) => (
                  <Badge key={stringValue(stage.id)} variant="outline">
                    {String(stage.order)} · {stringValue(stage.label)}
                    {stage.terminal ? '（终态）' : ''}
                  </Badge>
                ))}
              </div>
              <form
                className="grid gap-3 md:grid-cols-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  const f = new FormData(event.currentTarget);
                  void action(
                    () =>
                      postJson('/api/pipeline/stages', {
                        key: f.get('key'),
                        label: f.get('label'),
                        order: Number(f.get('order')),
                        terminal: f.get('terminal') === 'on',
                      }),
                    '招聘阶段已保存',
                  );
                }}
              >
                <Field label="阶段标识" hint="例如 interview">
                  <input className={inputClass} name="key" required />
                </Field>
                <Field label="显示名称">
                  <input className={inputClass} name="label" required />
                </Field>
                <Field label="顺序">
                  <input
                    className={inputClass}
                    name="order"
                    type="number"
                    inputMode="numeric"
                    min="1"
                    required
                  />
                </Field>
                <label className="flex min-h-11 items-center gap-2 self-end text-sm font-medium">
                  <input className="size-5" type="checkbox" name="terminal" />
                  终态
                </label>
                <Button
                  type="submit"
                  className="self-end"
                  disabled={actionBusy}
                >
                  保存阶段
                </Button>
              </form>
            </Panel>
          </AdvancedSection>
        </>
      ) : null}
    </WorkspaceShell>
  );
}
export function TeamClient() {
  return (
    <AuthGate allowedRoles={['admin', 'recruiting_lead']}>
      <TeamContent />
    </AuthGate>
  );
}
