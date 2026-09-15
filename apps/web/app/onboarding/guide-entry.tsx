'use client';

import { BookOpen, ChevronRight } from 'lucide-react';
import { useGuide } from './guide-state';

export function GuideEntry({
  current,
  compact = false,
}: {
  current: string;
  compact?: boolean;
}) {
  const { spotlight, dispatch } = useGuide();
  const index = spotlight.steps.findIndex(
    (step) => step.id === spotlight.progress.stepId,
  );
  function launch() {
    dispatch({ type: 'pause' });
    spotlight.launch();
  }
  if (compact)
    return (
      <button
        type="button"
        data-spotlight="guide-entry"
        onClick={launch}
        disabled={!spotlight.ready}
        className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-primary hover:bg-secondary lg:hidden"
      >
        <BookOpen className="size-4" aria-hidden="true" />
        新手导览
      </button>
    );
  return (
    <button
      type="button"
      data-spotlight="guide-entry"
      onClick={launch}
      disabled={!spotlight.ready}
      className={`mx-4 mb-3 flex min-h-14 shrink-0 items-center gap-3 rounded-xl border px-3 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-blue-300 ${current === '/guide' ? 'border-blue-300/40 bg-sidebar-accent text-white' : 'border-white/15 bg-white/5 text-slate-200 hover:bg-white/10'}`}
    >
      <BookOpen
        className="size-[18px] shrink-0 text-blue-300"
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">新手导览</span>
        <span className="mt-0.5 block text-[11px] text-slate-400">
          {spotlight.progress.finished
            ? '已完成 · 再走一遍'
            : index > 0
              ? `继续第 ${index + 1} 步 · 约 3 分钟`
              : '高亮讲解 · 约 3 分钟上手'}
        </span>
      </span>
      <ChevronRight
        className="size-4 shrink-0 text-slate-400"
        aria-hidden="true"
      />
    </button>
  );
}
