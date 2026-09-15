'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { apiFetch } from './api-client';

type DispatchControl = {
  positionId: string;
  paused: boolean;
  queued: number;
  processing: number;
  internalQuotasEnabled: boolean;
  canControl: boolean;
};

export function ContactDispatchControl({
  positionId,
  controlApi,
}: {
  positionId: string;
  controlApi: string;
}) {
  const labelId = useId();
  const [state, setState] = useState<DispatchControl | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);
  const changing = useRef(false);
  const read = useCallback(async () => {
    const version = ++revision.current;
    try {
      const response = await apiFetch(
        `${controlApi}/api/positions/${positionId}/contact-dispatch`,
      );
      const result = (await response.json()) as DispatchControl & {
        message?: string;
      };
      if (!response.ok || result.positionId !== positionId)
        throw new Error(result.message ?? '无法读取联系开关，请重试。');
      if (version === revision.current) {
        setState(result);
        setError(null);
      }
    } catch (failure) {
      if (version === revision.current)
        setError(
          failure instanceof Error ? failure.message : '无法读取联系开关。',
        );
    }
  }, [controlApi, positionId]);
  useEffect(() => {
    const initial = window.setTimeout(() => void read(), 0);
    const timer = window.setInterval(() => {
      if (!changing.current) void read();
    }, 5000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [read]);
  async function change(running: boolean) {
    if (changing.current) return;
    changing.current = true;
    setBusy(true);
    setError(null);
    ++revision.current;
    try {
      const response = await apiFetch(
        `${controlApi}/api/positions/${positionId}/contact-dispatch`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ paused: !running }),
        },
      );
      const result = (await response.json()) as DispatchControl & {
        message?: string;
      };
      if (!response.ok || result.positionId !== positionId)
        throw new Error(result.message ?? '联系开关保存失败。');
      setState(result);
    } catch (failure) {
      setState(null);
      setError(
        failure instanceof Error
          ? failure.message
          : '联系开关保存失败，请刷新确认状态。',
      );
    } finally {
      changing.current = false;
      setBusy(false);
    }
  }
  const current = state?.positionId === positionId ? state : null;
  return (
    <div className="rounded-xl border bg-card p-3 text-sm">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <label
            id={labelId}
            htmlFor={`${labelId}-switch`}
            className="font-medium"
          >
            本岗位联系执行
          </label>
          <output className="mt-1 block text-xs leading-5 text-muted-foreground">
            {!current
              ? '正在确认状态'
              : `${current.paused ? (current.processing ? '暂停中，当前这一人处理完后停止' : '已暂停') : '运行中'} · 待发送 ${current.queued} 人${current.processing ? ` · 正在处理 ${current.processing} 人` : ''}`}
          </output>
        </div>
        <div className="flex min-h-11 shrink-0 items-center gap-3 px-2">
          {busy ? (
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          ) : null}
          <Switch
            id={`${labelId}-switch`}
            aria-labelledby={labelId}
            checked={!!current && !current.paused}
            disabled={busy || !current?.canControl || !!error}
            onCheckedChange={(value) => void change(value)}
          />
        </div>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        {current?.internalQuotasEnabled === false ? '内部数量不限。' : ''}
        关闭后保留待发送队列，重新开启即可继续；BOSS 自身的额度和限制仍然有效。
      </p>
      {error ? (
        <div className="mt-2 flex items-center gap-2">
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void read()}
          >
            重试
          </Button>
        </div>
      ) : null}
    </div>
  );
}
