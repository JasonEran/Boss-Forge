'use client';

import { useState } from 'react';
import { BookOpen, ChevronDown, ChevronUp, Pause } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NativeLink as Link } from '../native-link';
import { useCurrentUser } from '../auth-gate';
import { guidePracticeHref, updateGuideProgress } from './guide-progress';
import { useGuide } from './guide-state';

export function GuideCompanion({ current }: { current: string }) {
  const { progress, steps, ready, saved, dispatch, spotlight } = useGuide();
  const user = useCurrentUser();
  const [expanded, setExpanded] = useState(true);
  if (
    !ready ||
    spotlight.progress.active ||
    current === '/guide' ||
    progress.mode !== 'practicing'
  )
    return null;
  const step = steps.find((item) => item.id === progress.current)!;
  const inContext =
    step.target.href === current ||
    step.related?.some((item) => item.href === current);
  const next = updateGuideProgress(
    progress,
    { type: 'complete', id: step.id },
    user.role,
  );
  return (
    <section
      aria-label="新手导览操作提示"
      className="overflow-hidden rounded-xl border border-primary/20 bg-card"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-secondary/60 px-4 py-2">
        <BookOpen className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="text-xs font-medium text-primary">
          新手导览 · {steps.indexOf(step) + 1}/{steps.length}
        </span>
        <p className="min-w-0 flex-1 text-sm font-semibold">{step.title}</p>
        {inContext ? (
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            aria-expanded={expanded}
            aria-controls="guide-page-instructions"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <ChevronUp /> : <ChevronDown />}
            {expanded ? '收起提示' : '展开提示'}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 text-muted-foreground"
          onClick={() => dispatch({ type: 'pause' })}
        >
          <Pause />
          暂停导览
        </Button>
      </div>
      {inContext && expanded ? (
        <div id="guide-page-instructions" className="space-y-4 p-4 sm:p-5">
          <ol className="grid gap-4 xl:grid-cols-3">
            {step.steps.map((item, index) => (
              <li key={item.title} className="flex gap-3">
                <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-secondary text-xs font-semibold text-primary">
                  {index + 1}
                </span>
                <div>
                  <p className="text-sm font-semibold">{item.title}</p>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {item.detail}
                  </p>
                </div>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
            <p className="max-w-xl text-sm leading-6 text-muted-foreground">
              <span className="font-medium text-foreground">本步目标：</span>
              {step.outcome}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                nativeButton={false}
                variant="outline"
                className="min-h-11"
                render={<Link href={guidePracticeHref('/guide', step.id)} />}
              >
                查看完整讲解
              </Button>
              <Button
                nativeButton={false}
                className="min-h-11"
                render={
                  <Link
                    href={guidePracticeHref('/guide', next.current)}
                    onClick={() => dispatch({ type: 'complete', id: step.id })}
                  />
                }
              >
                本步已了解，继续
              </Button>
            </div>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            只记录学习进度；实际业务操作请在下方页面完成。
            {!saved
              ? ' 此浏览器无法保存进度，刷新后可能需要重新选择章节。'
              : ''}
          </p>
        </div>
      ) : !inContext ? (
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
          <p className="text-sm text-muted-foreground">
            当前已离开本章的操作页面，可随时回来继续。
          </p>
          <Button
            nativeButton={false}
            variant="outline"
            className="min-h-11"
            render={
              <Link href={guidePracticeHref(step.target.href, step.id)} />
            }
          >
            返回本步操作
          </Button>
        </div>
      ) : null}
    </section>
  );
}
