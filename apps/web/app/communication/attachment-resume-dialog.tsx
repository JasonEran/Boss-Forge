'use client';
import { useEffect, useState } from 'react';
import { Download, LoaderCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { userFacingRequestError } from '../api-client';

export function AttachmentResumeDialog({
  conversationId,
  name,
  onClose,
  loadFile,
}: {
  conversationId: string;
  name: string;
  onClose: () => void;
  loadFile(this: void, id: string): Promise<Blob>;
}) {
  const [file, setFile] = useState<{ url: string; type: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true,
      url = '';
    void loadFile(conversationId)
      .then((blob) => {
        if (!active) return;
        url = URL.createObjectURL(blob);
        setFile({ url, type: blob.type });
      })
      .catch((e) => {
        if (active) setError(userFacingRequestError(e));
      });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [conversationId, loadFile]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex h-[88dvh] max-h-[900px] flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{name} · 附件简历</DialogTitle>
          <DialogDescription>
            候选人已分享的附件，直接查看，无需分析。
          </DialogDescription>
        </DialogHeader>
        {file ? (
          <>
            <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-muted/30">
              {file.type === 'application/pdf' ? (
                <iframe
                  title={`${name}的附件简历`}
                  src={file.url}
                  className="h-full w-full"
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- Authenticated blob previews cannot use the public image optimizer.
                <img
                  src={file.url}
                  alt={`${name}的附件简历`}
                  className="h-full w-full object-contain"
                />
              )}
            </div>
            <a
              href={file.url}
              download={`${name}-附件简历.${file.type === 'application/pdf' ? 'pdf' : file.type === 'image/png' ? 'png' : 'jpg'}`}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium"
            >
              <Download className="size-4" aria-hidden="true" />
              下载简历
            </a>
          </>
        ) : error ? (
          <div
            role="alert"
            className="space-y-3 rounded-lg bg-destructive/10 p-4 text-sm"
          >
            <p>{error}</p>
            <Button variant="outline" onClick={onClose}>
              关闭
            </Button>
          </div>
        ) : (
          <output
            aria-busy="true"
            className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground"
          >
            <LoaderCircle
              className="size-5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            正在打开 BOSS 附件简历…
          </output>
        )}
      </DialogContent>
    </Dialog>
  );
}
