'use client';

import { useEffect, useState } from 'react';
import { apiFetch, controlApi } from './api-client';

export function WorkspaceActivityStatus({ current }: { current: string }) {
  const [paused, setPaused] = useState<boolean | null>(null);
  useEffect(() => {
    if (current === '/communication') return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      try {
        if (!document.hidden) {
          const response = await apiFetch(
            `${controlApi}/api/workspace/activity`,
          );
          if (response.ok) {
            const data = (await response.json()) as {
              screeningPaused: boolean;
            };
            if (!stopped) setPaused(data.screeningPaused);
          }
        }
      } catch {
        /* This is informational; the worker enforces the mode. */
      }
      if (!stopped) timer = setTimeout(() => void tick(), 5000);
    }
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [current]);
  if (current === '/communication' || paused === null) return null;
  return (
    <output className="block text-xs leading-5 text-muted-foreground">
      {paused
        ? '实时沟通页面正在使用 BOSS，简历筛选已暂停；离开沟通页面后自动继续。'
        : '筛选模式 · 已有筛选任务按原进度继续，实时沟通同步已暂停。'}
    </output>
  );
}
