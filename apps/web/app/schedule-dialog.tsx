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

const initialScheduleDate = (() => {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setSeconds(0, 0);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
})();

async function readResponse(response: Response) {
  const payload = (await response.json()) as { message?: string };
  if (!response.ok) throw new Error(payload.message ?? `HTTP ${response.status}`);
}

export function ScheduleDialog({
  open,
  onOpenChange,
  controlApi,
  positionId,
  onCreated,
}: Props) {
  const [frequency, setFrequency] = useState('once');
  const [source, setSource] = useState('recommend');
  const [nextRunAt, setNextRunAt] = useState(initialScheduleDate);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (!positionId || submitting) return;
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
      setError(submitError instanceof Error ? submitError.message : String(submitError));
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
            按上海时区生成筛选任务；启用精筛开关后会读取完整简历，但不会打招呼。
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <div className="grid gap-4 sm:grid-cols-2">
            <label htmlFor="schedule-frequency" className="space-y-1.5 text-sm font-medium">
              <span>执行频率</span>
              <Select value={frequency} onValueChange={(value) => setFrequency(value ?? 'once')}>
                <SelectTrigger id="schedule-frequency"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="once">仅执行一次</SelectItem>
                  <SelectItem value="daily">每天</SelectItem>
                  <SelectItem value="weekdays">工作日</SelectItem>
                  <SelectItem value="weekly">每周</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label htmlFor="schedule-next-run" className="space-y-1.5 text-sm font-medium">
              <span>首次执行时间</span>
              <Input id="schedule-next-run" required type="datetime-local" value={nextRunAt} onChange={(event) => setNextRunAt(event.target.value)} />
            </label>
            <label htmlFor="schedule-source" className="space-y-1.5 text-sm font-medium">
              <span>候选人来源</span>
              <Select value={source} onValueChange={(value) => setSource(value ?? 'recommend')}>
                <SelectTrigger id="schedule-source"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="recommend">推荐候选人</SelectItem>
                  <SelectItem value="search">搜索候选人</SelectItem>
                </SelectContent>
              </Select>
            </label>
            {source === 'search' ? (
              <label htmlFor="schedule-search-keyword" className="space-y-1.5 text-sm font-medium">
                <span>搜索关键词</span>
                <Input id="schedule-search-keyword" required value={searchKeyword} onChange={(event) => setSearchKeyword(event.target.value)} />
              </label>
            ) : null}
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" disabled={!positionId || submitting}>
              {submitting ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
              {submitting ? '正在保存' : '保存定时任务'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
