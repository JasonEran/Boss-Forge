'use client';

import { useEffect, useRef, useState } from 'react';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { ArrowLeft, ArrowRight, Compass, X } from 'lucide-react';
import {
  Dialog,
  DialogDescription,
  DialogPortal,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { NativeLink as Link } from '../native-link';
import { useGuide } from './guide-state';
import { spotlightPlacement, type SpotlightRect } from './spotlight-model';

function visibleTarget(name: string) {
  return [
    ...document.querySelectorAll<HTMLElement>(`[data-spotlight="${name}"]`),
  ].find((node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}

export function SpotlightTour({ current }: { current: string }) {
  const { spotlight } = useGuide();
  const { progress, ready, steps, go, close } = spotlight;
  const step = steps.find((item) => item.id === progress.stepId)!;
  const index = steps.indexOf(step);
  const open =
    ready && progress.active && (!step.page || step.page === current);
  const [geometry, setGeometry] = useState<{
    stepId: string;
    target: SpotlightRect | null;
    width: number;
    height: number;
    popupHeight: number;
    fallback: boolean;
  } | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!open) return;
    let frame = 0;
    let target: HTMLElement | undefined;
    let scrolledTarget: HTMLElement | undefined;
    const update = () => {
      const found = visibleTarget(step.target);
      target = found ?? visibleTarget('page-heading');
      if (target && target !== scrolledTarget) {
        target.scrollIntoView({
          block: 'center',
          inline: 'center',
          behavior: 'instant',
        });
        scrolledTarget = target;
      }
      const rect = target?.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      const height = window.innerHeight;
      const left = rect ? Math.max(4, rect.left - 6) : 0;
      const top = rect ? Math.max(4, rect.top - 6) : 0;
      const right = rect ? Math.min(width - 4, rect.right + 6) : 0;
      const bottom = rect ? Math.min(height - 4, rect.bottom + 6) : 0;
      const next = {
        stepId: step.id,
        target:
          rect && right > left && bottom > top
            ? { left, top, width: right - left, height: bottom - top }
            : null,
        width,
        height,
        popupHeight: popup.current?.offsetHeight ?? 330,
        fallback: !found,
      };
      setGeometry((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    };
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(update);
    };
    const timer = window.setTimeout(() => {
      update();
    }, 0);
    // Targets can appear after dashboard data arrives; observe only workspace content, not the portal.
    const observer = new MutationObserver(schedule);
    const content = document.getElementById('workspace-content');
    if (content) observer.observe(content, { childList: true, subtree: true });
    const resize = new ResizeObserver(schedule);
    if (popup.current) resize.observe(popup.current);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    return () => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      resize.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [open, step.id, step.target]);

  useEffect(() => {
    if (!open || geometry?.stepId !== step.id) return;
    const frame = window.requestAnimationFrame(() =>
      heading.current?.focus({ preventScroll: true }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [open, geometry?.stepId, step.id]);

  const measured = geometry?.stepId === step.id ? geometry : null;
  const view = measured ?? {
    target: null,
    width: 390,
    height: 700,
    popupHeight: 330,
    fallback: false,
  };
  const placement = spotlightPlacement(view.target, view, view.popupHeight);
  const arrow =
    view.target && placement.side !== 'center'
      ? {
          left:
            placement.side === 'right'
              ? -6
              : placement.side === 'left'
                ? placement.width - 6
                : Math.max(
                    20,
                    Math.min(
                      placement.width - 28,
                      view.target.left +
                        view.target.width / 2 -
                        placement.left -
                        6,
                    ),
                  ),
          top:
            placement.side === 'bottom'
              ? -6
              : placement.side === 'top'
                ? view.popupHeight - 6
                : Math.max(
                    24,
                    Math.min(
                      view.popupHeight - 32,
                      view.target.top +
                        view.target.height / 2 -
                        placement.top -
                        6,
                    ),
                  ),
        }
      : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogPortal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[80] bg-transparent" />
        {view.target ? (
          <div
            aria-hidden="true"
            className="pointer-events-none fixed z-[81] rounded-lg border-2 border-white ring-4 ring-primary/60"
            style={{
              ...view.target,
              boxShadow: '0 0 0 9999px rgb(9 18 37 / 66%)',
            }}
          />
        ) : (
          <div
            aria-hidden="true"
            className="pointer-events-none fixed inset-0 z-[81] bg-slate-950/65"
          />
        )}
        <DialogPrimitive.Popup
          ref={popup}
          initialFocus={heading}
          finalFocus={() => visibleTarget('guide-entry') ?? false}
          className="fixed z-[82] rounded-xl bg-primary text-white shadow-2xl outline-none"
          style={{
            left: placement.left,
            top: placement.top,
            width: placement.width,
            maxHeight: placement.maxHeight,
            visibility: measured ? 'visible' : 'hidden',
          }}
        >
          {arrow ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute size-3 rotate-45 bg-primary"
              style={arrow}
            />
          ) : null}
          <div
            className="relative overflow-y-auto overscroll-contain rounded-xl p-5"
            style={{ maxHeight: placement.maxHeight }}
          >
            <div className="mb-3 flex items-center gap-2">
              <Compass className="size-4" aria-hidden="true" />
              <span className="flex-1 text-xs font-medium text-blue-100">
                新手导览 · {index + 1} / {steps.length}
              </span>
              <button
                type="button"
                onClick={() => close()}
                aria-label="退出导览并保存当前位置"
                className="-mr-2 -mt-2 grid size-11 place-items-center rounded-lg text-blue-100 hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-white"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
            <DialogTitle
              ref={heading}
              tabIndex={-1}
              className="text-lg font-semibold leading-7 text-white outline-none"
            >
              {step.title}
            </DialogTitle>
            <DialogDescription className="mt-3 text-sm leading-7 text-blue-50">
              {step.body}
            </DialogDescription>
            <p className="mt-3 border-l-2 border-blue-200/50 pl-3 text-xs leading-6 text-blue-100">
              {step.tip}
            </p>
            {geometry?.fallback ? (
              <p className="mt-2 text-xs leading-5 text-blue-100">
                该操作区暂未显示，先认识所在页面；数据就绪后会自动定位。
              </p>
            ) : null}
            <div className="mt-5 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => close()}
                className="min-h-11 rounded-lg px-1 text-xs text-blue-100 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
              >
                稍后继续
              </button>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  aria-label="上一步"
                  className="min-h-11 min-w-11 text-white hover:bg-white/15 hover:text-white"
                  disabled={index === 0 || spotlight.pending}
                  onClick={() => go(steps[index - 1]!.id)}
                >
                  <ArrowLeft />
                </Button>
                <Button
                  type="button"
                  className="min-h-11 bg-white px-4 text-primary hover:bg-blue-50"
                  disabled={spotlight.pending}
                  onClick={() =>
                    index === steps.length - 1
                      ? close(true)
                      : go(steps[index + 1]!.id)
                  }
                >
                  {spotlight.pending
                    ? '准备下一页…'
                    : index === steps.length - 1
                      ? '完成导览'
                      : '下一步'}
                  <ArrowRight />
                </Button>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between border-t border-white/20 pt-2">
              <Link
                href={`/guide?guide=${step.chapter}`}
                onClick={() => close()}
                className="inline-flex min-h-11 items-center text-xs text-blue-100 underline underline-offset-4 hover:text-white"
              >
                查看详细手册
              </Link>
              {index > 0 ? (
                <button
                  type="button"
                  onClick={() => go('welcome')}
                  className="min-h-11 text-xs text-blue-100 hover:text-white"
                >
                  从头开始
                </button>
              ) : null}
            </div>
          </div>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
