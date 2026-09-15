'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AuthenticatedUser } from '../auth-gate';
import { useSpotlightState } from './use-spotlight';
import { useWorkspaceRouter } from '../workspace-router-context';
import { guideStepsForRole } from './guide-content';
import {
  guideActionFromUrl,
  guideStorageKey,
  readGuideProgress,
  updateGuideProgress,
  type GuideAction,
  type GuideProgress,
} from './guide-progress';

type GuideState = {
  spotlight: ReturnType<typeof useSpotlightState>;
  progress: GuideProgress;
  ready: boolean;
  saved: boolean;
  steps: ReturnType<typeof guideStepsForRole>;
  dispatch: (action: GuideAction) => void;
};
const GuideContext = createContext<GuideState | null>(null);

export function GuideProvider({
  user,
  children,
}: {
  user: AuthenticatedUser;
  children: ReactNode;
}) {
  const spotlight = useSpotlightState(user);
  const router = useWorkspaceRouter();
  const storageKey = guideStorageKey(user.userId, user.departmentId);
  const [progress, setProgress] = useState(() =>
    readGuideProgress(null, user.role),
  );
  const latest = useRef(progress);
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState(true);
  const persist = useCallback(
    (next: GuideProgress) => {
      latest.current = next;
      setProgress(next);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
        setSaved(true);
      } catch {
        setSaved(false);
      }
    },
    [storageKey],
  );

  useEffect(() => {
    function readStoredProgress() {
      try {
        return readGuideProgress(
          window.localStorage.getItem(storageKey),
          user.role,
        );
      } catch {
        setSaved(false);
        return readGuideProgress(null, user.role);
      }
    }
    const timer = window.setTimeout(() => {
      const stored = readStoredProgress();
      const url = new URL(window.location.href);
      const action = guideActionFromUrl(url, user.role);
      if (action) {
        persist(updateGuideProgress(stored, action, user.role));
        // Consume the launch hint so pausing stays paused after a refresh.
        url.searchParams.delete('guide');
        window.history.replaceState(
          window.history.state,
          '',
          `${url.pathname}${url.search}${url.hash}`,
        );
      } else if (
        (url.pathname === '/guide' || url.pathname === '/guide/') &&
        stored.mode !== 'reading'
      ) {
        // Returning to the lessons ends page coaching until the HR opens an operation again.
        persist(
          updateGuideProgress(
            stored,
            { type: 'select', id: stored.current },
            user.role,
          ),
        );
      } else {
        latest.current = stored;
        setProgress(stored);
      }
      setReady(true);
    }, 0);
    function sync(event: StorageEvent) {
      if (event.key !== storageKey && event.key !== null) return;
      const next = readStoredProgress();
      latest.current = next;
      setProgress(next);
    }
    window.addEventListener('storage', sync);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('storage', sync);
    };
  }, [persist, storageKey, user.role, router?.href]);

  const dispatch = useCallback(
    (action: GuideAction) => {
      persist(updateGuideProgress(latest.current, action, user.role));
    },
    [persist, user.role],
  );

  return (
    <GuideContext.Provider
      value={{
        spotlight,
        progress,
        ready,
        saved,
        steps: guideStepsForRole(user.role),
        dispatch,
      }}
    >
      {children}
    </GuideContext.Provider>
  );
}

export function useGuide() {
  const guide = useContext(GuideContext);
  if (!guide) throw new Error('useGuide must be used inside GuideProvider.');
  return guide;
}

export function useOptionalGuide() {
  return useContext(GuideContext);
}
