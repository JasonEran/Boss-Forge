'use client';

import { useEffect, useState } from 'react';
import { LoaderCircle, MessageSquareText, ShieldCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';

type Preview = {
  templateVersionId: string;
  templateVersion: number;
  renderedMessage: string;
};

type Props = {
  open: boolean;
  stateId: string | null;
  controlApi: string;
  onOpenChange: (open: boolean) => void;
  onCreated: () => Promise<void> | void;
};

async function responseJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(payload.message ?? `HTTP ${response.status}`);
  return payload;
}

export function ContactPreviewDialog({ open, stateId, controlApi, onOpenChange, onCreated }: Props) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !stateId) return;
    void Promise.resolve().then(() => {
      setLoading(true);
      setCreated(false);
      setError(null);
      return fetch(`${controlApi}/api/candidate-position-states/${stateId}/message-preview`, { cache: 'no-store' });
    })
      .then((response) => responseJson<{ preview: Preview }>(response))
      .then((payload) => setPreview(payload.preview))
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : String(loadError)))
      .finally(() => setLoading(false));
  }, [controlApi, open, stateId]);

  async function confirm() {
    if (!stateId || !preview || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`${controlApi}/api/candidate-position-states/${stateId}/contact-intents`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify({ templateVersionId: preview.templateVersionId, createdBy: 'hr:dashboard' }),
      });
      await responseJson(response);
      setCreated(true);
      await onCreated();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquareText className="size-4 text-primary" aria-hidden="true" />消息预览与人工确认
          </DialogTitle>
          <DialogDescription>服务端按当前模板重新渲染，避免使用过期或被篡改的消息。</DialogDescription>
        </DialogHeader>
        {loading ? <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><LoaderCircle className="animate-spin" />正在生成预览</div> : null}
        {preview && !loading ? (
          <div className="space-y-3">
            <Textarea readOnly value={preview.renderedMessage} className="min-h-28 resize-none" />
            <p className="text-xs text-muted-foreground">模板版本 v{preview.templateVersion} · {preview.renderedMessage.length}/500 字</p>
            <div className="flex gap-2 rounded-lg border border-warning/30 bg-warning/8 p-3 text-xs leading-5">
              <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>确认只会创建待执行联系任务。真实打招呼需要命令行批准参数与环境总开关同时开启；当前均未开启。</span>
            </div>
          </div>
        ) : null}
        {created ? <p className="text-sm text-success">联系任务已创建，真实发送保持关闭。</p> : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{created ? '完成' : '取消'}</Button>
          {!created ? (
            <Button onClick={() => void confirm()} disabled={!preview || submitting}>
              {submitting ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
              {submitting ? '正在创建' : '确认创建联系任务'}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
