'use client';

import { useState } from 'react';
import { CalendarClock, LoaderCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  ScreeningCountField,
  validScreeningCount,
} from './screening-count-field';
import { DEFAULT_SCREENING_LIMIT } from '../../../packages/contracts/src/screening-limit';
import { apiFetch } from './api-client';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  controlApi: string;
  positionId: string | null;
  onCreated: () => Promise<void> | void;
};

const frequencyLabels: Record<string, string> = {
  once: '一次',
  daily: '每日',
  weekdays: '工作日',
  weekly: '每周',
};

const sourceLabels: Record<string, string> = {
  recommend: 'BOSS 推荐',
  search: '关键词搜索',
};

const initialScheduleDate = (() => {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setSeconds(0, 0);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
})();

async function readResponse(response: Response) {
  const payload = (await response.json()) as { message?: string };
  if (!response.ok)
    throw new Error(payload.message ?? `HTTP ${response.status}`);
}

export function ScheduleDialog({
  open,
  onOpenChange,
  controlApi,
  positionId,
  onCreated,
}: Props) {
  const [frequency, setFrequency] = useState('once');
  const [screeningCount, setScreeningCount] = useState(
    String(DEFAULT_SCREENING_LIMIT),
  );
  const [source, setSource] = useState('recommend');
  const [nextRunAt, setNextRunAt] = useState(initialScheduleDate);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [autoGreet, setAutoGreet] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (!positionId || submitting || !validScreeningCount(screeningCount))
      return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await apiFetch(`${controlApi}/api/schedules`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          positionId,
          candidateLimit: Number(screeningCount),
          autoGreet,
          source,
          searchKeyword: source === 'search' ? searchKeyword : null,
          frequency,
          nextRunAt: new Date(nextRunAt).toISOString(),
          createdBy: 'hr:dashboard',
        }),
      });
      await readResponse(response);
      await onCreated();
      onOpenChange(false);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : String(submitError),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="size-4 text-primary" aria-hidden="true" />
            新建定时筛选
          </DialogTitle>
          <DialogDescription>
            按上海时区生成筛选任务；打开自动打招呼后，本批次通过精筛的候选人会在分块筛选后自动打招呼。
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <ScreeningCountField
            id="schedule-screening-count"
            value={screeningCount}
            onChange={setScreeningCount}
            disabled={submitting}
            scheduled
          />
          <div className="flex items-center justify-between gap-4 rounded-lg border px-3 py-3">
            <div className="min-w-0">
              <label
                id="schedule-auto-greet-label"
                htmlFor="schedule-auto-greet"
                className="text-sm font-medium"
              >
                自动打招呼
              </label>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                仅对本定时计划生成的任务生效；关闭则只筛选、不打招呼。
              </p>
            </div>
            <Switch
              id="schedule-auto-greet"
              aria-labelledby="schedule-auto-greet-label"
              checked={autoGreet}
              disabled={submitting}
              onCheckedChange={setAutoGreet}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label
              htmlFor="schedule-frequency"
              className="space-y-1.5 text-sm font-medium"
            >
              <span>执行频率</span>
              <Select
                value={frequency}
                onValueChange={(value) => setFrequency(value ?? 'once')}
              >
                <SelectTrigger id="schedule-frequency">
                  <SelectValue>{frequencyLabels[frequency]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="once">一次</SelectItem>
                  <SelectItem value="daily">每日</SelectItem>
                  <SelectItem value="weekdays">工作日</SelectItem>
                  <SelectItem value="weekly">每周</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label
              htmlFor="schedule-next-run"
              className="space-y-1.5 text-sm font-medium"
            >
              <span>首次执行时间</span>
              <Input
                id="schedule-next-run"
                required
                type="datetime-local"
                value={nextRunAt}
                onChange={(event) => setNextRunAt(event.target.value)}
              />
            </label>
            <label
              htmlFor="schedule-source"
              className="space-y-1.5 text-sm font-medium"
            >
              <span>候选人来源</span>
              <Select
                value={source}
                onValueChange={(value) => setSource(value ?? 'recommend')}
              >
                <SelectTrigger id="schedule-source">
                  <SelectValue>{sourceLabels[source]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="recommend">BOSS 推荐</SelectItem>
                  <SelectItem value="search">关键词搜索</SelectItem>
                </SelectContent>
              </Select>
            </label>
            {source === 'search' ? (
              <label
                htmlFor="schedule-search-keyword"
                className="space-y-1.5 text-sm font-medium"
              >
                <span>搜索关键词</span>
                <Input
                  id="schedule-search-keyword"
                  required
                  value={searchKeyword}
                  onChange={(event) => setSearchKeyword(event.target.value)}
                />
              </label>
            ) : null}
          </div>
          <p className="rounded-lg border bg-muted/35 p-3 text-xs leading-5 text-muted-foreground">
            如果首次执行时间落在允许工作时段外，任务会保留，并在下一个可运行时段自动继续；无需重复创建。
          </p>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button
              type="submit"
              disabled={
                !positionId ||
                submitting ||
                !validScreeningCount(screeningCount)
              }
            >
              {submitting ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : null}
              {submitting ? '正在保存' : '保存定时任务'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
