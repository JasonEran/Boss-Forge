'use client';

import { useState, type ReactNode } from 'react';
import { ArrowUpRight, Layers3, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiFetch, clearSessionToken, controlApi } from './api-client';
import { useCurrentUser } from './auth-gate';
import { ModuleTabs } from './module-tabs';
import { NativeLink as Link } from './native-link';
import { isNavigationActive, navigationForRole } from './workspace-navigation';
import { GuideProvider, useOptionalGuide } from './onboarding/guide-state';
import { GuideEntry } from './onboarding/guide-entry';
import { GuideCompanion } from './onboarding/guide-companion';
import { SpotlightTour } from './onboarding/spotlight-tour';
import { BackgroundActivity } from './background-activity';
import { WorkspaceActivityStatus } from './workspace-activity-status';

const roleLabels = {
  admin: '管理员',
  recruiting_lead: '招聘负责人',
  recruiter: '招聘专员',
  interviewer: '面试官',
};

/** One shell for every workspace route, so navigation and page actions stay in place. */
type WorkspaceShellProps = {
  current: string;
  title: string;
  description: string;
  actions?: ReactNode;
  status?: ReactNode;
  children: ReactNode;
  conversationLayout?: boolean;
};

export function WorkspaceShell(props: WorkspaceShellProps) {
  const user = useCurrentUser();
  const guide = useOptionalGuide();
  if (guide) return <WorkspaceShellContent {...props} />;
  return (
    <GuideProvider
      key={`${user.departmentId}:${user.userId}:${user.role}`}
      user={user}
    >
      <WorkspaceShellContent {...props} />
    </GuideProvider>
  );
}

function WorkspaceShellContent({
  current,
  title,
  description,
  actions,
  status,
  children,
  conversationLayout = false,
}: WorkspaceShellProps) {
  const user = useCurrentUser();
  const navigation = navigationForRole(user.role);
  const [loggingOut, setLoggingOut] = useState(false);
  const activeModule = navigation.find((item) =>
    isNavigationActive(item, current),
  );

  async function logout() {
    setLoggingOut(true);
    try {
      await apiFetch(`${controlApi}/api/auth/logout`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      /* Local logout still works when the API is unavailable. */
    } finally {
      clearSessionToken();
      window.location.assign('/');
    }
  }

  function links(group: 'core' | 'management') {
    return navigation
      .filter((item) => item.group === group)
      .map((item) => {
        const Icon = item.icon;
        const active = isNavigationActive(item, current);
        return (
          <Link
            key={item.href}
            href={item.href}
            data-spotlight={item.href === '/' ? 'nav-home' : undefined}
            aria-current={active ? 'page' : undefined}
            className={`flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm transition-colors ${active ? 'bg-sidebar-accent font-semibold text-white' : 'text-slate-300 hover:bg-white/6 hover:text-white'}`}
          >
            <Icon
              className={`size-[18px] ${active ? 'text-blue-300' : 'text-slate-400'}`}
              aria-hidden="true"
            />
            {item.label}
            {active ? (
              <span className="ml-auto size-1.5 rounded-full bg-blue-300" />
            ) : null}
          </Link>
        );
      });
  }

  return (
    <div
      className={`${conversationLayout ? 'flex h-dvh min-h-0 flex-col overflow-hidden' : 'min-h-screen'} bg-background text-foreground lg:pl-[216px]`}
    >
      <a
        href="#workspace-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-card focus:p-3"
      >
        跳到页面内容
      </a>
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[216px] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:flex">
        <Link
          href="/"
          aria-label="返回工作台总览"
          className="flex h-20 shrink-0 items-center gap-3 px-6"
        >
          <span className="grid size-9 place-items-center rounded-xl bg-primary text-white">
            <Layers3 className="size-5" aria-hidden="true" />
          </span>
          <span>
            <span className="block text-base font-semibold tracking-tight text-white">
              Boss Forge
            </span>
            <span className="block text-[11px] tracking-[.12em] text-slate-400">
              招聘工作空间
            </span>
          </span>
        </Link>
        <nav
          aria-label="主导航"
          className="flex-1 space-y-1 overflow-y-auto px-3 py-4"
        >
          <p className="px-3 pb-3 text-[11px] font-medium tracking-wider text-slate-400">
            招聘工作
          </p>
          {links('core')}
          {navigation.some((item) => item.group === 'management') ? (
            <p className="px-3 pb-2 pt-8 text-[11px] font-medium tracking-wider text-slate-400">
              管理与分析
            </p>
          ) : null}
          {links('management')}
        </nav>
        <GuideEntry current={current} />
        <div className="mx-4 mb-4 shrink-0 rounded-xl border border-white/10 p-3">
          <p className="text-xs font-medium text-slate-200">
            让每一次筛选更有把握
          </p>
          <p className="mt-1 text-[11px] leading-5 text-slate-400">
            岗位规则 · 简历证据 · 团队协作
          </p>
        </div>
      </aside>
      <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b bg-card px-4 sm:px-6 lg:px-8">
        <Link
          href="/"
          className="flex min-h-11 items-center gap-2 font-semibold lg:hidden"
          aria-label="返回工作台总览"
        >
          <Layers3 className="size-5 text-primary" />
          <span className="hidden min-[400px]:inline">Boss Forge</span>
        </Link>
        <div className="hidden items-center gap-2 text-sm lg:flex">
          <span className="text-muted-foreground">招聘工作空间</span>
          <span className="text-border">/</span>
          <span className="font-medium">{activeModule?.label ?? title}</span>
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-3">
          <GuideEntry current={current} compact />
          <BackgroundActivity />
          {status ? (
            <div className="hidden text-xs text-muted-foreground xl:block">
              {status}
            </div>
          ) : null}
          <span className="hidden h-6 w-px bg-border sm:block" />
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-xs font-semibold text-primary">
            {user.displayName.slice(0, 1)}
          </span>
          <span className="hidden sm:block">
            <span className="block text-xs font-medium">
              {user.displayName}
            </span>
            <span className="block text-[11px] text-muted-foreground">
              {roleLabels[user.role]}
            </span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={loggingOut}
            onClick={() => void logout()}
            aria-label="退出登录"
            className="min-h-11 min-w-11"
          >
            <LogOut className="size-4" />
            <span className="sr-only">退出</span>
          </Button>
        </div>
      </header>
      <nav
        aria-label="移动端主导航"
        className="sticky top-16 z-20 flex shrink-0 gap-1 overflow-x-auto border-b bg-card px-3 py-2 lg:hidden"
      >
        {navigation.map((item) => {
          const Icon = item.icon;
          const active = isNavigationActive(item, current);
          return (
            <Link
              key={item.href}
              href={item.href}
              data-spotlight={item.href === '/' ? 'nav-home' : undefined}
              aria-current={active ? 'page' : undefined}
              className={`flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-3 text-sm ${active ? 'bg-secondary font-semibold text-primary' : 'text-muted-foreground hover:bg-muted'}`}
            >
              <Icon className="size-4" />
              {item.shortLabel}
            </Link>
          );
        })}
      </nav>
      <main
        id="workspace-content"
        className={
          conversationLayout
            ? 'flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-2 sm:p-3'
            : 'mx-auto w-full max-w-[1600px] min-w-0 space-y-5 px-4 py-6 sm:px-6 lg:px-8 lg:py-7'
        }
      >
        <div
          className={
            conversationLayout
              ? 'flex shrink-0 items-center justify-between gap-2 px-2'
              : 'flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between'
          }
        >
          <div className="min-w-0" data-spotlight="page-heading">
            <h1
              className={`${conversationLayout ? 'text-lg' : 'text-2xl'} font-semibold tracking-tight`}
            >
              {title}
            </h1>
            <p
              className={
                conversationLayout
                  ? 'sr-only'
                  : 'mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground'
              }
            >
              {description}
            </p>
          </div>
          {actions ? (
            <div
              className="w-full min-w-0 xl:max-w-3xl"
              data-spotlight="page-actions"
            >
              {actions}
            </div>
          ) : null}
        </div>
        <ModuleTabs current={current} />
        {!conversationLayout && user.role !== 'interviewer' ? (
          <WorkspaceActivityStatus current={current} />
        ) : null}
        {!conversationLayout ? <GuideCompanion current={current} /> : null}
        {children}
        {!conversationLayout ? (
          <div className="flex items-center gap-1 border-t pt-4 text-[11px] text-muted-foreground">
            Boss Forge<span className="mx-1">·</span>团队招聘工作台
            <ArrowUpRight className="size-3" aria-hidden="true" />
          </div>
        ) : null}
      </main>
      <SpotlightTour current={current} />
    </div>
  );
}
