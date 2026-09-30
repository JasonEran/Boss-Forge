'use client';
import { useState } from 'react';
import { Activity, ArrowUpRight, CircleCheck, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useDashboardState } from './dashboard-state';
import { useCurrentUser } from './auth-gate';
import { NativeLink as Link } from './native-link';
import { taskWorkspaceHref } from './workspace-scope';
import { taskProgress } from './task-progress-model';
import { ProgressRing, TaskProgress } from './task-progress';

export function BackgroundActivity() {
  const user = useCurrentUser();
  const { data, error, refreshing, updatedAt, refresh } = useDashboardState();
  const [open, setOpen] = useState(false);
  const tasks = (data?.tasks ?? []).map((task) => ({
    task,
    progress: taskProgress(task, data?.candidates ?? []),
  }));
  const active = tasks.filter((item) => item.progress.active);
  const contacts =
    user.role === 'interviewer' ? [] : (data?.contactIntents ?? []);
  const contactActive = contacts.filter(
    (item) => item.status === 'ready' || item.status === 'processing',
  ).length;
  const contactUncertain = contacts.filter(
    (item) => item.status === 'uncertain',
  ).length;
  const running = active.length + contactActive;
  const runtime = data?.runtime;
  const runtimeReady =
    runtime?.workerHeartbeatFresh &&
    runtime.browserAuthenticated &&
    runtime.consistent;
  const awaitingScan = runtime?.state === 'awaiting_scan';
  const processed = active.reduce(
    (sum, item) => sum + item.progress.processed,
    0,
  );
  const total = active.reduce((sum, item) => sum + item.progress.total, 0);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            className="min-h-11 gap-2 px-2"
            aria-label={
              error
                ? '后台状态同步失败，查看详情'
                : running
                  ? `${running} 项后台工作进行中，查看进度`
                  : '查看后台进度'
            }
          />
        }
      >
        {!data && !error ? (
          <ProgressRing size={22} active value={null} />
        ) : running ? (
          <ProgressRing
            size={22}
            active
            value={total ? Math.round((processed / total) * 100) : null}
          />
        ) : error || (runtime && !runtimeReady) ? (
          <Activity className="size-4 text-warning" />
        ) : (
          <CircleCheck className="size-4 text-success" />
        )}
        <span className="hidden text-xs sm:inline">
          {!data
            ? '读取后台状态'
            : error
              ? '同步中断'
              : running
                ? `后台运行 ${running}`
                : awaitingScan
                  ? '等待扫码'
                  : '后台进度'}
        </span>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[min(80vh,640px)] w-[min(92vw,400px)] gap-4 overflow-y-auto p-4"
      >
        <div className="flex items-center justify-between">
          <PopoverTitle>后台运行进度</PopoverTitle>
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            <RefreshCw
              className={refreshing ? 'motion-safe:animate-spin' : ''}
            />
            同步
          </Button>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          {error
            ? `暂时无法更新：${error}`
            : running
              ? `${active.length} 个筛选任务 · ${contactActive} 项联系正在处理`
              : data
                ? '当前没有待执行的后台任务，历史结果保存在任务与联系记录中。'
                : '正在读取后台任务…'}
        </p>
        <div className="flex flex-wrap gap-2 rounded-lg bg-muted px-3 py-2 text-xs leading-6">
          <span
            className={
              runtime?.workerHeartbeatFresh ? 'text-success' : 'text-warning'
            }
          >
            后台
            {runtime?.workerHeartbeatFresh
              ? '在线'
              : awaitingScan
                ? '待命'
                : '待确认'}
          </span>
          <span className="text-border">·</span>
          <span
            className={
              runtime?.browserAuthenticated ? 'text-success' : 'text-warning'
            }
          >
            BOSS{' '}
            {runtime?.browserAuthenticated
              ? '已连接'
              : awaitingScan
                ? '等待扫码'
                : '待连接'}
          </span>
          {runtime && !runtimeReady ? (
            <p className="w-full text-muted-foreground">
              {awaitingScan
                ? running
                  ? '请完成扫码登录，当前排队任务会在登录后继续。'
                  : '完成扫码登录后，可按需启动新任务。'
                : '请先处理登录或服务状态，再继续执行任务。'}
              {awaitingScan ? (
                <Link
                  href="/boss-login"
                  onClick={() => setOpen(false)}
                  className="flex min-h-11 items-center gap-1 text-primary"
                >
                  前往扫码登录
                  <ArrowUpRight className="size-3.5" />
                </Link>
              ) : null}
            </p>
          ) : null}
        </div>
        {active.slice(0, 4).map(({ task }) => (
          <div key={task.id} className="space-y-2 border-t pt-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">{task.positionName}</p>
              <Link
                href={taskWorkspaceHref(
                  user.role === 'interviewer' ? '/candidates' : '/tasks',
                  task,
                )}
                onClick={() => setOpen(false)}
                className="inline-flex min-h-11 items-center text-xs text-primary"
              >
                {user.role === 'interviewer' ? '查看候选人' : '查看任务'}
                <ArrowUpRight className="size-3.5" />
              </Link>
            </div>
            <TaskProgress
              task={task}
              candidates={data?.candidates ?? []}
              compact
            />
          </div>
        ))}
        {contactActive ? (
          <section className="space-y-2 border-t pt-3">
            <p className="text-sm font-medium">联系执行</p>
            <p className="text-xs text-muted-foreground">
              {contactActive} 项等待或执行中
            </p>
            <Link
              href="/contacts"
              onClick={() => setOpen(false)}
              className="inline-flex min-h-11 items-center text-xs text-primary"
            >
              查看发送队列
              <ArrowUpRight className="size-3.5" />
            </Link>
          </section>
        ) : null}
        {contactUncertain ? (
          <p className="border-t pt-3 text-xs leading-5 text-warning">
            {contactUncertain} 条历史联系回执待核验，自动发送暂缓。
            <Link
              href="/contacts"
              onClick={() => setOpen(false)}
              className="flex min-h-11 items-center gap-1 text-primary"
            >
              查看待核验记录
              <ArrowUpRight className="size-3.5" />
            </Link>
          </p>
        ) : null}
        {data ? (
          <div className="flex gap-4 border-t pt-2 text-xs text-primary">
            <Link
              href={user.role === 'interviewer' ? '/candidates' : '/tasks'}
              onClick={() => setOpen(false)}
              className="inline-flex min-h-11 items-center"
            >
              查看历史{user.role === 'interviewer' ? '候选人' : '任务'}
            </Link>
            {user.role !== 'interviewer' ? (
              <Link
                href="/contacts"
                onClick={() => setOpen(false)}
                className="inline-flex min-h-11 items-center"
              >
                查看联系记录
              </Link>
            ) : null}
          </div>
        ) : null}
        <p className="border-t pt-3 text-[11px] text-muted-foreground">
          页面打开时每 5 秒同步 ·{' '}
          {updatedAt
            ? `最近同步 ${new Date(updatedAt).toLocaleTimeString('zh-CN')}`
            : '尚未完成同步'}
        </p>
      </PopoverContent>
    </Popover>
  );
}
