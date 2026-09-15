'use client';

import { useState } from 'react';
import { BriefcaseBusiness, LoaderCircle } from 'lucide-react';

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
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { apiFetch } from './api-client';

type EditablePosition = {
  id: string;
  name: string;
  bossJobKeyword?: string | null;
  bossJobId?: string | null;
  bossJobStatus?: string | null;
  ownerName?: string;
};

type Props = {
  open: boolean;
  position: EditablePosition | null | undefined;
  controlApi: string;
  bossPositions: EditablePosition[];
  onOpenChange: (open: boolean) => void;
  onUpdated: (positionId: string) => Promise<void> | void;
};

async function responseJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(payload.message ?? `HTTP ${response.status}`);
  return payload;
}

export function PositionEditDialog({ open, position, controlApi, bossPositions, onOpenChange, onUpdated }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && position ? (
        <PositionEditContent
          key={position.id}
          position={position}
          controlApi={controlApi}
          bossPositions={bossPositions}
          onOpenChange={onOpenChange}
          onUpdated={onUpdated}
        />
      ) : null}
    </Dialog>
  );
}

function PositionEditContent({
  position,
  controlApi,
  bossPositions,
  onOpenChange,
  onUpdated,
}: Omit<Props, 'open' | 'position'> & { position: EditablePosition }) {
  const [importedPositionId, setImportedPositionId] = useState('');
  const [bindingSaved, setBindingSaved] = useState(false);
  const [ownerName, setOwnerName] = useState(position.ownerName ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      if (!position.bossJobId) {
        if (!importedPositionId) throw new Error('请选择要关联的 BOSS 岗位。');
        if (!bindingSaved) {
          const result = await apiFetch(`${controlApi}/api/positions/${position.id}/boss-binding`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ importedPositionId }),
          });
          await responseJson(result);
          setBindingSaved(true);
        }
        await onUpdated(position.id);
        onOpenChange(false);
        return;
      }
      const response = await apiFetch(`${controlApi}/api/positions/${position.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: position.name, bossJobKeyword: position.bossJobKeyword, ownerName }),
      });
      await responseJson(response);
      await onUpdated(position.id);
      onOpenChange(false);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BriefcaseBusiness className="size-4 text-primary" aria-hidden="true" />
            {position.bossJobId ? '负责人设置' : '关联 BOSS 岗位'}
          </DialogTitle>
          <DialogDescription>
            {position.bossJobId ? '岗位名称和招聘状态从 BOSS 同步。在“团队与权限”分配协作 HR。' : '为这个旧岗位选择对应的 BOSS 岗位，原来的规则、候选人和历史任务会保留。'}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <div className="rounded-xl border bg-muted/30 p-3 text-sm">
            <p className="font-medium">{position.name}</p>
            <p className="mt-1 text-xs text-muted-foreground">{position.bossJobId ? `BOSS 岗位 · ${position.bossJobStatus || '已同步'}` : '旧岗位 · 尚未关联 BOSS'}</p>
          </div>
          {!position.bossJobId ? <label htmlFor="bind-boss-position" className="grid gap-1.5 text-sm font-medium">
            对应的 BOSS 岗位
            <NativeSelect id="bind-boss-position" value={importedPositionId} onChange={(event) => setImportedPositionId(event.target.value)} required disabled={submitting || bindingSaved}>
              <NativeSelectOption value="">请选择已同步的岗位</NativeSelectOption>
              {bossPositions.map((item) => <NativeSelectOption key={item.id} value={item.id}>{item.name} · {item.bossJobId?.slice(-8)}</NativeSelectOption>)}
            </NativeSelect>
            <span className="text-xs font-normal leading-5 text-muted-foreground">{bossPositions.length ? '只列出尚未配置规则或开始筛选的 BOSS 岗位，避免合并两份招聘历史。' : '暂无可关联的岗位。请先同步 BOSS 岗位；已有规则或任务的岗位请直接使用。'}</span>
          </label> : null}
          {position.bossJobId ? <>
          <label htmlFor="edit-position-owner" className="grid gap-1.5 text-sm font-medium">
            负责人
            <Input
              id="edit-position-owner"
              value={ownerName}
              onChange={(event) => setOwnerName(event.target.value)}
              maxLength={100}
              required
            />
          </label>
          </> : null}
          {error ? <p role="alert" className="rounded-lg bg-destructive/8 p-3 text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              取消
            </Button>
            <Button type="submit" disabled={submitting || (!position.bossJobId && !importedPositionId)}>
              {submitting ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
              {submitting ? '保存中' : position.bossJobId ? '保存负责人' : '关联并保留原有规则'}
            </Button>
          </DialogFooter>
        </form>
    </DialogContent>
  );
}
