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
import type { DashboardData } from './dashboard-client';
import { apiJson, cachedApiJson } from './workspace-utils';

type DashboardState = {
  data: DashboardData | null;
  error: string | null;
  refreshing: boolean;
  updatedAt: number | null;
  refresh: () => Promise<void>;
};
const DashboardContext = createContext<DashboardState | null>(null);

export function DashboardProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState(() =>
    cachedApiJson<DashboardData>('/api/dashboard'),
  );
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const alive = useRef(true);
  const refresh = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    setRefreshing(true);
    const request = apiJson<DashboardData>('/api/dashboard', {
      cache: 'no-store',
    })
      .then((next) => {
        if (!alive.current) return;
        setData(next);
        setError(null);
        setUpdatedAt(Date.now());
      })
      .catch((reason: unknown) => {
        if (alive.current)
          setError(
            reason instanceof Error ? reason.message : '暂时无法同步后台状态。',
          );
      })
      .finally(() => {
        inFlight.current = null;
        if (alive.current) setRefreshing(false);
      });
    inFlight.current = request;
    return request;
  }, []);
  useEffect(() => {
    alive.current = true;
    const update = () => {
      if (!document.hidden) void refresh();
    };
    const first = window.setTimeout(update, 0);
    const timer = window.setInterval(update, 5000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      alive.current = false;
      window.clearTimeout(first);
      window.clearInterval(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [refresh]);
  return (
    <DashboardContext.Provider
      value={{ data, error, refreshing, updatedAt, refresh }}
    >
      {children}
    </DashboardContext.Provider>
  );
}
export function useDashboardState() {
  const value = useContext(DashboardContext);
  if (!value) throw new Error('DashboardProvider is required.');
  return value;
}
