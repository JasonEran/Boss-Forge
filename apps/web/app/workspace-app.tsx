'use client';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AuthGate, useCurrentUser } from './auth-gate';
import { DashboardProvider } from './dashboard-state';
import { GuideProvider } from './onboarding/guide-state';
import { WorkspaceRouterContext } from './workspace-router-context';
import { workspaceDestination } from './workspace-route-model';
import {
  isWorkspaceChunkError,
  isRecoverableWorkspaceLoad,
  WorkspacePageLoadTimeout,
  reserveWorkspaceReload,
} from './workspace-load-recovery';
import { apiJson, cachedApiJson } from './workspace-utils';
import type { DashboardPage } from './workspace-navigation';
import { navigationForRole } from './workspace-navigation';

const pageLoads = new Map<string, Promise<() => ReactNode>>();
function loadPage(path: string): Promise<() => ReactNode> {
  const cached = pageLoads.get(path);
  if (cached) return cached;
  const dashboardPages: Record<string, DashboardPage> = {
    '/': 'overview',
    '/positions': 'positions',
    '/tasks': 'tasks',
    '/candidates': 'candidates',
    '/contacts': 'contacts',
    '/audit': 'audit',
  };
  const load = async (): Promise<() => ReactNode> => {
    const page = dashboardPages[path];
    if (page) {
      const { DashboardClient } = await import('./dashboard-client');
      return () => <DashboardClient page={page} />;
    }
    switch (path) {
      case '/communication': {
        const { CommunicationPage } =
          await import('./communication/communication-client');
        return () => <CommunicationPage />;
      }
      case '/pipeline': {
        const { PipelineClient } = await import('./pipeline/pipeline-client');
        return () => <PipelineClient />;
      }
      case '/operations': {
        const { OperationsClient } =
          await import('./operations/operations-client');
        return () => <OperationsClient />;
      }
      case '/analytics': {
        const { AnalyticsClient } =
          await import('./analytics/analytics-client');
        return () => <AnalyticsClient />;
      }
      case '/team': {
        const { TeamClient } = await import('./team/team-client');
        return () => <TeamClient />;
      }
      case '/boss-login': {
        const { BossLoginClient } =
          await import('./boss-login/boss-login-client');
        return () => <BossLoginClient />;
      }
      case '/automation': {
        const { AutomationClient } =
          await import('./automation/automation-client');
        return () => <AutomationClient />;
      }
      case '/guide': {
        const { GuideClient } = await import('./guide/guide-client');
        return () => <GuideClient />;
      }
      default:
        throw new Error('页面不可用。');
    }
  };
  const promise = load().catch((error: unknown) => {
    pageLoads.delete(path);
    throw error;
  });
  pageLoads.set(path, promise);
  return promise;
}

const warmPaths: Record<string, string[]> = {
  '/operations': [
    '/api/operations/workspace',
    '/api/pipeline?limit=100',
    '/api/department/workspace',
  ],
  '/pipeline': [
    '/api/pipeline?limit=50',
    '/api/department/workspace',
    '/api/collaboration',
  ],
  '/team': ['/api/department/workspace', '/api/system/resume-view-policy'],
  '/analytics': ['/api/analytics'],
  '/automation': ['/api/automation/workspace', '/api/department/workspace'],
  '/boss-login': ['/api/boss-login/status'],
};

function WorkspaceSession({ children }: { children: ReactNode }) {
  const user = useCurrentUser();
  const [content, setContent] = useState<ReactNode | null>(null);
  const [href, setHref] = useState('/');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<{ href: string; message: string } | null>(
    null,
  );
  const sequence = useRef(0);
  const invalidateNavigation = useCallback(() => {
    sequence.current++;
  }, []);
  const cancel = useCallback(() => {
    sequence.current++;
    setPending(null);
  }, []);
  const navigate = useCallback(
    async (
      destination: string,
      mode: 'push' | 'pop' = 'push',
    ): Promise<boolean> => {
      const url = workspaceDestination(destination, window.location.href);
      if (!url) return false;
      const request = ++sequence.current;
      setPending(url.pathname);
      setError(null);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const render = await Promise.race([
          loadPage(url.pathname),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new WorkspacePageLoadTimeout()),
              10000,
            );
          }),
        ]);
        if (request !== sequence.current) return false;
        if (mode === 'push' && url.href !== window.location.href)
          window.history.pushState(
            { ...window.history.state, bossForgeWorkspace: true },
            '',
            `${url.pathname}${url.search}${url.hash}`,
          );
        setHref(`${url.pathname}${url.search}${url.hash}`);
        setContent(render());
        window.dispatchEvent(new Event('boss-forge:workspace-navigated'));
        if (!url.searchParams.has('tour'))
          window.requestAnimationFrame(() =>
            window.scrollTo({ top: 0, behavior: 'instant' }),
          );
        return true;
      } catch (reason) {
        if (request === sequence.current) {
          if (
            isRecoverableWorkspaceLoad(reason) &&
            reserveWorkspaceReload(window.sessionStorage)
          ) {
            // Recover explicit navigation after a stale chunk or stalled module.
            // Drafts remain in session storage and pagehide releases the chat lease.
            if (mode === 'pop') window.location.replace(url.href);
            else window.location.assign(url.href);
            return true;
          }
          setError({
            href: url.href,
            message: isWorkspaceChunkError(reason)
              ? '页面版本已更新或资源暂时不可用，请刷新打开。'
              : reason instanceof Error
                ? reason.message
                : '页面暂时无法打开。',
          });
        }
        return false;
      } finally {
        clearTimeout(timeout);
        if (request === sequence.current) setPending(null);
      }
    },
    [],
  );

  const prefetch = useCallback(
    (destination: string) => {
      const url = workspaceDestination(destination, window.location.href);
      if (!url) return;
      void loadPage(url.pathname).catch(() => {});
      const allowed = navigationForRole(user.role).some(
        (item) =>
          item.href === url.pathname ||
          item.relatedHrefs?.includes(url.pathname),
      );
      if (allowed)
        for (const path of warmPaths[url.pathname] ?? [])
          if (!cachedApiJson(path)) void apiJson(path).catch(() => {});
    },
    [user.role],
  );

  useEffect(() => {
    const initial = window.setTimeout(
      () =>
        setHref(
          `${window.location.pathname}${window.location.search}${window.location.hash}`,
        ),
      0,
    );
    const pop = (event: PopStateEvent) => {
      if (!workspaceDestination(window.location.href, window.location.href))
        return;
      event.stopImmediatePropagation();
      void navigate(window.location.href, 'pop');
    };
    window.addEventListener('popstate', pop, true);
    return () => {
      window.clearTimeout(initial);
      window.removeEventListener('popstate', pop, true);
      invalidateNavigation();
    };
  }, [navigate, invalidateNavigation]);

  return (
    <WorkspaceRouterContext.Provider
      value={{ href, pending, navigate, prefetch, cancel }}
    >
      <DashboardProvider>
        <GuideProvider
          key={`${user.departmentId}:${user.userId}:${user.role}`}
          user={user}
        >
          {pending ? (
            <div className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-1 overflow-hidden bg-blue-100">
              <span className="workspace-indeterminate block h-full w-1/3 rounded-full bg-primary" />
              <output className="sr-only">
                正在准备下一页，当前页面保持可见…
              </output>
            </div>
          ) : null}
          {error ? (
            <div
              role="alert"
              className="fixed left-1/2 top-4 z-[110] flex w-[min(92vw,560px)] -translate-x-1/2 flex-wrap items-center gap-3 rounded-xl border bg-card p-4 text-sm shadow-lg"
            >
              <p className="flex-1">{error.message}</p>
              <button
                type="button"
                className="min-h-11 px-3 text-primary"
                onClick={() => void navigate(error.href)}
              >
                重试
              </button>
              <a
                className="inline-flex min-h-11 items-center text-primary underline"
                href={error.href}
              >
                刷新打开
              </a>
              <button
                type="button"
                className="min-h-11 px-2"
                onClick={() => setError(null)}
              >
                关闭
              </button>
            </div>
          ) : null}
          {content ?? children}
        </GuideProvider>
      </DashboardProvider>
    </WorkspaceRouterContext.Provider>
  );
}

export function WorkspaceApp({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <WorkspaceSession>{children}</WorkspaceSession>
    </AuthGate>
  );
}
