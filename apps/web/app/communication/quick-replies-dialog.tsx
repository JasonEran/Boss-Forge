'use client';
import { useEffect, useState } from 'react';
import { LoaderCircle, Pencil, Plus, Trash2 } from 'lucide-react';
import type { CommunicationQuickReply } from '../../../../packages/contracts/src/communication';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { userFacingRequestError } from '../api-client';

export function QuickRepliesDialog({
  open,
  onOpenChange,
  onInsert,
  request,
  canInsert,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsert: (body: string) => void;
  canInsert: boolean;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
}) {
  const [items, setItems] = useState<CommunicationQuickReply[]>([]);
  const [body, setBody] = useState(''),
    [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    queueMicrotask(() => {
      if (active) {
        setLoading(true);
        setError(null);
      }
    });
    void request<{ quickReplies: CommunicationQuickReply[] }>('/quick-replies')
      .then((r) => {
        if (active) setItems(r.quickReplies);
      })
      .catch((e) => {
        if (active) setError(userFacingRequestError(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, request]);
  async function save() {
    if (busy || !body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { quickReply } = await request<{
        quickReply: CommunicationQuickReply;
      }>(`/quick-replies${editing ? `/${editing}` : ''}`, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: body.trim() }),
      });
      setItems((current) => [
        quickReply,
        ...current.filter((i) => i.id !== quickReply.id),
      ]);
      setBody('');
      setEditing(null);
    } catch (e) {
      setError(userFacingRequestError(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await request(`/quick-replies/${id}`, { method: 'DELETE' });
      setItems((current) => current.filter((i) => i.id !== id));
      if (editing === id) {
        setEditing(null);
        setBody('');
      }
    } catch (e) {
      setError(userFacingRequestError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>我的常用语</DialogTitle>
          <DialogDescription>
            仅保存在本平台。点击常用语填入草稿，编辑后再发送。
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div
          className="max-h-72 space-y-2 overflow-y-auto"
          aria-label="已保存的常用语"
        >
          {loading ? (
            <output className="block py-4 text-sm text-muted-foreground">
              正在读取常用语…
            </output>
          ) : !items.length ? (
            <p className="rounded-lg bg-muted/30 p-4 text-sm text-muted-foreground">
              还没有常用语，在下面保存第一条。
            </p>
          ) : (
            items.map((item) => (
              <div
                key={item.id}
                className="flex items-start gap-1 rounded-lg border p-2"
              >
                <button
                  type="button"
                  className="min-h-11 min-w-0 flex-1 rounded-md px-2 py-2 text-left text-sm whitespace-pre-wrap break-words hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
                  disabled={!canInsert || busy}
                  onClick={() => onInsert(item.body)}
                >
                  {item.body}
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11 min-w-11 shrink-0"
                  aria-label="编辑这条常用语"
                  disabled={busy}
                  onClick={() => {
                    setEditing(item.id);
                    setBody(item.body);
                  }}
                >
                  <Pencil className="size-4" aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11 min-w-11 shrink-0"
                  aria-label="删除这条常用语"
                  disabled={busy}
                  onClick={() => void remove(item.id)}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </div>
            ))
          )}
        </div>
        <form
          className="space-y-3 border-t pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label htmlFor="quick-reply-body" className="text-sm font-medium">
            {editing ? '编辑常用语' : '新增常用语'}
          </label>
          <Textarea
            id="quick-reply-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={500}
            rows={3}
            disabled={busy}
            placeholder="输入经常使用的回复…"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {body.length}/500 · 已保存 {items.length}/50 条
            </span>
            <div className="flex gap-2">
              {editing ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11"
                  disabled={busy}
                  onClick={() => {
                    setEditing(null);
                    setBody('');
                  }}
                >
                  取消编辑
                </Button>
              ) : null}
              <Button
                type="submit"
                className="min-h-11"
                disabled={
                  busy || !body.trim() || (!editing && items.length >= 50)
                }
              >
                {busy ? (
                  <LoaderCircle
                    className="size-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Plus className="size-4" aria-hidden="true" />
                )}
                {editing ? '保存修改' : '保存常用语'}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
