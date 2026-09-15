'use client';
import { useEffect, useRef, useState } from 'react';
import { Download, Image as ImageIcon, Copy, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { apiFetch, controlApi, userFacingRequestError } from '../api-client';
import type {
  CommunicationMessage,
  BossSharedContact,
} from '../../../../packages/contracts/src/communication';

export function MessageAssets({
  conversationId,
  message,
}: {
  conversationId: string;
  message: CommunicationMessage;
}) {
  const [busy, setBusy] = useState<number | null>(null),
    [error, setError] = useState(''),
    [preview, setPreview] = useState<{ url: string; name: string } | null>(
      null,
    );
  const active = useRef(true),
    urls = useRef(new Set<string>()),
    controller = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    const objectUrls = urls.current;
    return () => {
      active.current = false;
      controller.current?.abort();
      for (const url of objectUrls) URL.revokeObjectURL(url);
      objectUrls.clear();
    };
  }, []);
  async function open(
    asset: NonNullable<CommunicationMessage['assets']>[number],
  ) {
    if (busy !== null) return;
    setBusy(asset.index);
    setError('');
    controller.current = new AbortController();
    try {
      const response = await apiFetch(
        `${controlApi}/api/communication/conversations/${conversationId}/messages/${message.id}/assets/${asset.index}`,
        { signal: controller.current.signal },
      );
      if (!response.ok) {
        const value: unknown = await response.json();
        throw new Error(
          value &&
            typeof value === 'object' &&
            'message' in value &&
            typeof value.message === 'string'
            ? value.message
            : '附件读取失败。',
        );
      }
      const blob = await response.blob();
      if (!active.current) return;
      const url = URL.createObjectURL(blob);
      urls.current.add(url);
      if (asset.kind === 'image') setPreview({ url, name: asset.name });
      else {
        const a = document.createElement('a');
        a.href = url;
        const encoded = response.headers
          .get('content-disposition')
          ?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
        try {
          a.download = encoded ? decodeURIComponent(encoded) : asset.name;
        } catch {
          a.download = asset.name;
        }
        a.click();
        setTimeout(() => {
          URL.revokeObjectURL(url);
          urls.current.delete(url);
        }, 30_000);
      }
    } catch (e) {
      if (active.current) setError(userFacingRequestError(e));
    } finally {
      if (active.current) setBusy(null);
    }
  }
  return (
    <div className="mt-2 space-y-2">
      {message.assets?.map((asset) => (
        <Button
          key={asset.index}
          variant="secondary"
          className="min-h-11 max-w-full whitespace-normal text-left"
          disabled={busy !== null}
          onClick={() => void open(asset)}
        >
          {busy === asset.index ? (
            <LoaderCircle
              className="size-4 shrink-0 animate-spin"
              aria-hidden="true"
            />
          ) : asset.kind === 'image' ? (
            <ImageIcon className="size-4 shrink-0" aria-hidden="true" />
          ) : (
            <Download className="size-4 shrink-0" aria-hidden="true" />
          )}
          <span className="break-all">
            {asset.kind === 'image' ? '预览图片' : asset.name}
          </span>
        </Button>
      ))}
      {error ? (
        <p role="alert" className="text-xs leading-5">
          {error}
        </p>
      ) : null}
      <Dialog
        open={Boolean(preview)}
        onOpenChange={(open) => {
          if (!open) {
            if (preview) {
              URL.revokeObjectURL(preview.url);
              urls.current.delete(preview.url);
            }
            setPreview(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{preview?.name || '聊天图片'}</DialogTitle>
          </DialogHeader>
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element -- Authenticated blob URL cannot use the public image optimizer.
            <img
              src={preview.url}
              alt={preview.name}
              onError={() => setError('图片未能显示，请重新同步会话后重试。')}
              className="max-h-[70dvh] w-full rounded-md object-contain"
            />
          ) : null}
          {preview && error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
export function SharedContacts({
  contacts,
}: {
  contacts: BossSharedContact[];
}) {
  const [notice, setNotice] = useState('');
  return contacts.length ? (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {contacts.map((contact) => (
        <Button
          key={contact.kind}
          type="button"
          variant="ghost"
          className="min-h-11 max-w-full whitespace-normal"
          onClick={() => {
            void navigator.clipboard.writeText(contact.value).then(
              () => setNotice('已复制'),
              () => setNotice('复制失败，请选中文字复制。'),
            );
          }}
        >
          <Copy className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="select-text break-all">
            {contact.kind === 'wechat' ? '微信' : '手机'}：{contact.value}
          </span>
        </Button>
      ))}
      {notice ? <output>{notice}</output> : null}
    </div>
  ) : null;
}
