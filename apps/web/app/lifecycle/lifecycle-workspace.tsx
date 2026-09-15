'use client';
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  lifecycleStageLabels,
  type LifecycleWorkspace as Workspace,
} from '../../../../packages/contracts/src/recruitment-lifecycle';
import { LifecycleDialog, lifecycleRequest } from './lifecycle-dialog';
import { userFacingRequestError } from '../api-client';
export function LifecycleWorkspace() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [search, setSearch] = useState(''),
    [stage, setStage] = useState(''),
    [offset, setOffset] = useState(0),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [checkedAt, setCheckedAt] = useState(0);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const value = await lifecycleRequest<Workspace>(
          `?search=${encodeURIComponent(search)}&offset=${offset}${stage ? `&stage=${stage}` : ''}`,
        );
        if (!signal?.aborted) {
          setWorkspace(value);
          setCheckedAt(Date.now());
          setError(null);
        }
      } catch (e) {
        if (!signal?.aborted) setError(userFacingRequestError(e));
      }
    },
    [search, stage, offset],
  );
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => void load(controller.signal), 200);
    const interval = setInterval(() => {
      if (!document.hidden) void load(controller.signal);
    }, 30_000);
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [load]);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">招聘跟进与录用</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            在实时沟通里建档，或从已审核候选人进入跟进。到面试、Offer
            和入职始终保留同一份档案。
          </p>
        </div>
        <Button
          variant="outline"
          className="min-h-11"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void load().finally(() => setBusy(false));
          }}
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          刷新跟进
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {workspace?.reminders.length ? (
        <div className="space-y-2 rounded-lg border bg-muted/30 p-4">
          <h3 className="text-sm font-semibold">今天需要关注</h3>
          {workspace.reminders.map((r) => (
            <button
              className="flex min-h-11 w-full flex-wrap items-center justify-between gap-2 rounded-md px-2 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
              key={r.id}
              onClick={() => setSelected(r.caseId)}
            >
              <span>
                {r.candidateName} · {r.title}
              </span>
              <span className="text-xs text-muted-foreground">
                {new Date(r.dueAt).toLocaleString('zh-CN')}
                {Date.parse(r.dueAt) < checkedAt ? ' · 已到期' : ''}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row">
        <Input
          className="min-h-11 sm:max-w-sm"
          aria-label="搜索招聘档案"
          placeholder="搜索姓名或岗位"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
        />
        <label className="flex items-center gap-2 text-sm">
          招聘阶段
          <select
            className="min-h-11 rounded-md border bg-background px-3"
            value={stage}
            onChange={(e) => {
              setStage(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">全部阶段</option>
            {Object.entries(lifecycleStageLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!workspace ? (
        <output className="block py-10 text-sm text-muted-foreground">
          正在读取招聘档案…
        </output>
      ) : !workspace.applications.length ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          暂无匹配的招聘档案。打开实时沟通中的“招聘跟进”，即可建档。
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {workspace.applications.map((c) => (
            <button
              type="button"
              key={c.id}
              onClick={() => setSelected(c.id)}
              className="space-y-2 rounded-lg border bg-card p-4 text-left hover:border-primary/40 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <div className="flex flex-wrap justify-between gap-2">
                <b>{c.candidateName}</b>
                <span className="text-xs text-muted-foreground">
                  {lifecycleStageLabels[c.stage]}
                </span>
              </div>
              <p className="text-sm">{c.positionName}</p>
              <p className="text-xs text-muted-foreground">
                负责人：{c.ownerName}
                {c.nextFollowupAt
                  ? ` · 跟进 ${new Date(c.nextFollowupAt).toLocaleString('zh-CN')}`
                  : ''}
              </p>
            </button>
          ))}
        </div>
      )}
      {workspace ? (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span>共 {workspace.total} 份档案</span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="min-h-11"
              disabled={!offset}
              onClick={() => setOffset((n) => Math.max(0, n - 50))}
            >
              上一页
            </Button>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={offset + 50 >= workspace.total}
              onClick={() => setOffset((n) => n + 50)}
            >
              下一页
            </Button>
          </div>
        </div>
      ) : null}
      <LifecycleDialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        {...(selected ? { caseId: selected } : {})}
        onChanged={() => void load()}
      />
    </div>
  );
}
