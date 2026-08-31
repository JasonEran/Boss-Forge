'use client';

import { useState } from 'react';
import { LoaderCircle, SlidersHorizontal } from 'lucide-react';

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

type PositionRuleDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  controlApi: string;
  onCreated: (positionId: string) => Promise<void> | void;
};

async function responseJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { message?: string };
  if (!response.ok)
    throw new Error(payload.message ?? `HTTP ${response.status}`);
  return payload;
}

export function PositionRuleDialog({
  open,
  onOpenChange,
  controlApi,
  onCreated,
}: PositionRuleDialogProps) {
  const [name, setName] = useState('');
  const [bossJobKeyword, setBossJobKeyword] = useState('');
  const [ownerName, setOwnerName] = useState('HR 管理员');
  const [minimumConfidence, setMinimumConfidence] = useState('0.86');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (submitting) return;
    const confidence = Number(minimumConfidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      setError('最低置信度必须在 0 到 1 之间。');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const positionResponse = await fetch(`${controlApi}/api/positions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          bossAccountId: 'boss-account-01',
          name,
          bossJobKeyword,
          ownerName,
        }),
      });
      const positionPayload = await responseJson<{ position: { id: string } }>(
        positionResponse,
      );
      const ruleResponse = await fetch(
        `${controlApi}/api/positions/${positionPayload.position.id}/rules`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: `${name} · TEM8 硬性条件`,
            config: {
              requiredCapabilities: [
                { capability: 'tem8', minimumConfidence: confidence },
              ],
            },
            dictionaryVersion: '2026.08.1',
            createdBy: 'hr:dashboard',
          }),
        },
      );
      await responseJson(ruleResponse);
      await onCreated(positionPayload.position.id);
      setName('');
      setBossJobKeyword('');
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
            <SlidersHorizontal
              className="size-4 text-primary"
              aria-hidden="true"
            />
            新建岗位与筛选规则
          </DialogTitle>
          <DialogDescription>
            岗位保存后会生成不可变的 TEM8 规则版本，历史任务仍引用原版本。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label
              htmlFor="position-name"
              className="space-y-1.5 text-sm font-medium"
            >
              <span>内部岗位名称</span>
              <Input
                id="position-name"
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例：海外运营专员"
              />
            </label>
            <label
              htmlFor="boss-job-keyword"
              className="space-y-1.5 text-sm font-medium"
            >
              <span>BOSS 岗位关键词</span>
              <Input
                id="boss-job-keyword"
                value={bossJobKeyword}
                onChange={(event) => setBossJobKeyword(event.target.value)}
                placeholder="留空则使用当前岗位"
              />
            </label>
            <label
              htmlFor="position-owner"
              className="space-y-1.5 text-sm font-medium"
            >
              <span>负责人</span>
              <Input
                id="position-owner"
                required
                value={ownerName}
                onChange={(event) => setOwnerName(event.target.value)}
              />
            </label>
            <label
              htmlFor="minimum-confidence"
              className="space-y-1.5 text-sm font-medium"
            >
              <span>TEM8 最低置信度</span>
              <Input
                id="minimum-confidence"
                required
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={minimumConfidence}
                onChange={(event) => setMinimumConfidence(event.target.value)}
              />
            </label>
          </div>
          <div className="rounded-lg border bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">
            已自动包含：英语专业八级、TEM8、TEM-8、英语8级、专八等表达，并检查否定、备考和
            CET/IELTS 混淆。
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
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : null}
              {submitting ? '正在保存' : '保存岗位与规则'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
