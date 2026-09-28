'use client';

import { useEffect, useState } from 'react';
import { LoaderCircle, Play } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { validScreeningCount } from './screening-count-field';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  screeningCount: string;
  submitting: boolean;
  onConfirm: (autoGreet: boolean) => Promise<void>;
};

export function ImmediateStartDialog({
  open,
  onOpenChange,
  screeningCount,
  submitting,
  onConfirm,
}: Props) {
  const [autoGreet, setAutoGreet] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const countOk = validScreeningCount(screeningCount);

  useEffect(() => {
    if (!open) return;
    setAutoGreet(false);
    setError(null);
  }, [open]);

  async function submit(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (!countOk || submitting) return;
    setError(null);
    try {
      await onConfirm(autoGreet);
      onOpenChange(false);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : String(submitError),
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Play className="size-4 text-primary" aria-hidden="true" />
            开始筛选
          </DialogTitle>
          <DialogDescription>
            立即创建筛选任务；打开自动打招呼后，本批次通过精筛的候选人会在分块筛选后自动打招呼。
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <p className="rounded-lg border bg-muted/35 px-3 py-3 text-sm leading-5 text-muted-foreground">
            本次目标人数：
            <span className="ml-1 font-medium text-foreground">
              {countOk ? `${Number(screeningCount)} 人` : '请先填写有效人数'}
            </span>
          </p>
          <div className="flex items-center justify-between gap-4 rounded-lg border px-3 py-3">
            <div className="min-w-0">
              <label
                id="immediate-auto-greet-label"
                htmlFor="immediate-auto-greet"
                className="text-sm font-medium"
              >
                自动打招呼
              </label>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                仅对本立即任务生效；关闭则只筛选、不打招呼。
              </p>
            </div>
            <Switch
              id="immediate-auto-greet"
              aria-labelledby="immediate-auto-greet-label"
              checked={autoGreet}
              disabled={submitting}
              onCheckedChange={setAutoGreet}
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={!countOk || submitting}>
              {submitting ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <Play aria-hidden="true" />
              )}
              {submitting
                ? '正在创建'
                : autoGreet
                  ? `开始筛选 · 打招呼 ${countOk ? Number(screeningCount) : ''} 人`
                  : `开始筛选 · ${countOk ? Number(screeningCount) : ''} 人`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
