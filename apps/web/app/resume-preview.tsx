'use client';
/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- The scroll region needs keyboard focus. */

import { useEffect, useState } from 'react';
import { FileText, LoaderCircle, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiFetch, userFacingRequestError } from './api-client';

type Preview = {
  captureId: string;
  complete: boolean;
  capturedAt: string | null;
  parts: Array<{ index: number; width: number; height: number }>;
};

type PreviewProps = {
  stateId: string;
  name: string;
  available: boolean;
  controlApi: string;
};

export function ResumePreview(props: PreviewProps) {
  return (
    <ResumePreviewContent
      key={`${props.stateId}:${props.available}`}
      {...props}
    />
  );
}

function ResumePreviewContent({
  stateId,
  name,
  available,
  controlApi,
}: PreviewProps) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [images, setImages] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    if (!available) return;
    const controller = new AbortController();
    const urls: string[] = [];
    async function load() {
      try {
        const base = `${controlApi}/api/candidate-position-states/${stateId}/resume-preview`;
        const response = await apiFetch(base, { signal: controller.signal });
        const metadata = (await response.json()) as Preview & {
          message?: string;
        };
        if (!response.ok)
          throw new Error(metadata.message ?? '简历预览加载失败');
        if (controller.signal.aborted) return;
        setPreview(metadata);
        for (const part of metadata.parts) {
          const image = await apiFetch(
            `${base}/${part.index}?capture=${encodeURIComponent(metadata.captureId)}`,
            {
              signal: controller.signal,
            },
          );
          if (!image.ok) throw new Error('部分简历图片未能加载，请重试。');
          const blob = await image.blob();
          if (controller.signal.aborted) return;
          urls.push(URL.createObjectURL(blob));
          setImages([...urls]);
        }
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(userFacingRequestError(failure));
      }
    }
    void load();
    return () => {
      controller.abort();
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [available, controlApi, stateId, attempt]);
  const loading =
    available && !error && (!preview || images.length < preview.parts.length);
  return (
    <section
      aria-label="简历预览"
      className="overflow-hidden rounded-xl border bg-muted/20"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <FileText className="size-4" />
            简历预览
          </h3>
          {preview ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {preview.complete
                ? `完整截图 · 共 ${preview.parts.length} 段`
                : '历史截图 · 尚未确认是否截全'}
              {preview.capturedAt
                ? ` · ${new Date(preview.capturedAt).toLocaleString('zh-CN', { hour12: false })}`
                : ''}
            </p>
          ) : null}
        </div>
        {images.length ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => setZoomed((value) => !value)}
            aria-pressed={zoomed}
          >
            {zoomed ? <ZoomOut /> : <ZoomIn />}
            {zoomed ? '适合宽度' : '放大查看'}
          </Button>
        ) : null}
      </div>
      {!available ? (
        <p className="p-4 text-sm text-muted-foreground">
          尚无简历截图。完成简历读取后，可在这里查看原始简历。
        </p>
      ) : null}
      {loading ? (
        <output className="block space-y-2 p-4 text-sm text-muted-foreground">
          <span className="flex items-center gap-2">
            <LoaderCircle className="size-4 animate-spin" />
            {preview
              ? `正在加载简历 ${images.length} / ${preview.parts.length}`
              : '正在读取简历预览'}
          </span>
          {preview ? (
            <progress
              className="h-2 w-full accent-primary"
              value={images.length}
              max={preview.parts.length}
              aria-label="简历图片加载进度"
            />
          ) : null}
        </output>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm text-destructive"
        >
          <span>{error}</span>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => {
              setPreview(null);
              setImages([]);
              setError(null);
              setAttempt((value) => value + 1);
            }}
          >
            重新加载
          </Button>
        </div>
      ) : null}
      {/* Keyboard users need a focus target to scroll the résumé independently. */}
      {images.length ? (
        <section
          tabIndex={0}
          aria-label="简历图片，滚动查看全部内容"
          className="max-h-[42dvh] sm:max-h-[60dvh] overflow-auto overscroll-contain p-2 focus-visible:outline-2 focus-visible:outline-ring"
        >
          {images.map((url, index) => (
            <figure key={url} className="mb-3 last:mb-0">
              <figcaption className="sticky left-0 mb-1 text-xs text-muted-foreground">
                第 {index + 1} / {preview?.parts.length} 段
              </figcaption>
              {/* Authenticated blob URLs cannot use the Next image optimizer. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                onError={() => setError('图片未能显示，请重新加载简历预览。')}
                alt={`${name}的简历，第 ${index + 1} 段，共 ${preview?.parts.length} 段`}
                width={preview?.parts[index]?.width}
                height={preview?.parts[index]?.height}
                className={
                  zoomed
                    ? 'h-auto max-w-none rounded border bg-white'
                    : 'h-auto w-full rounded border bg-white'
                }
              />
            </figure>
          ))}
        </section>
      ) : null}
    </section>
  );
}
