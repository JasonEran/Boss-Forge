'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthenticatedUser } from '../auth-gate';
import { useWorkspaceRouter } from '../workspace-router-context';
import { guideStorageKey } from './guide-progress';
import {
  readSpotlightProgress,
  spotlightFromUrl,
  spotlightHref,
  spotlightSteps,
  type SpotlightProgress,
} from './spotlight-model';

export function useSpotlightState(user: AuthenticatedUser) {
  const router = useWorkspaceRouter();
  const prefetch = router?.prefetch;
  const key = `${guideStorageKey(user.userId, user.departmentId)}:spotlight-v1`;
  const [progress, setProgress] = useState<SpotlightProgress>(() =>
    readSpotlightProgress(null, user.role),
  );
  const latest = useRef(progress);
  const [ready, setReady] = useState(false);
  const steps = spotlightSteps(user.role);
  const save = useCallback(
    (next: SpotlightProgress) => {
      latest.current = next;
      setProgress(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* Tour links preserve the next step when storage is unavailable. */
      }
    },
    [key],
  );
  useEffect(() => {
    const timer = window.setTimeout(() => {
      let raw: string | null = null;
      try {
        raw = window.localStorage.getItem(key);
      } catch {
        /* Reading the tour remains available. */
      }
      const stored = readSpotlightProgress(raw, user.role);
      const url = new URL(window.location.href);
      const launch = spotlightFromUrl(url, user.role);
      const current = spotlightSteps(user.role).find(
        (step) => step.id === stored.stepId,
      )!;
      save(
        launch
          ? { stepId: launch.id, active: true, finished: false }
          : {
              ...stored,
              active:
                stored.active &&
                (!current.page || current.page === url.pathname),
            },
      );
      if (url.searchParams.has('tour')) {
        url.searchParams.delete('tour');
        window.history.replaceState(
          window.history.state,
          '',
          `${url.pathname}${url.search}${url.hash}`,
        );
      }
      setReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [key, save, user.role, router?.href]);

  useEffect(() => {
    if (!progress.active) return;
    const path = spotlightSteps(user.role);
    const next =
      path[path.findIndex((item) => item.id === progress.stepId) + 1];
    if (next) prefetch?.(spotlightHref(next, window.location.href));
  }, [progress.active, progress.stepId, user.role, prefetch]);

  async function go(id: string) {
    const step = steps.find((item) => item.id === id);
    if (!step) return;
    if (step.page && step.page !== window.location.pathname && router) {
      const navigated = await router.navigate(
        spotlightHref(step, window.location.href),
      );
      if (!navigated) {
        save({ ...latest.current, active: false });
        return;
      }
    }
    save({ stepId: id, active: true, finished: false });
    if (!router && step.page && step.page !== window.location.pathname)
      window.location.assign(spotlightHref(step, window.location.href));
  }
  function launch() {
    void go(latest.current.finished ? 'welcome' : latest.current.stepId);
  }
  function close(finished = false) {
    router?.cancel();
    save({ ...latest.current, active: false, finished });
  }
  return {
    progress,
    ready,
    steps,
    go,
    launch,
    close,
    pending: router?.pending !== null && Boolean(router?.pending),
  };
}
