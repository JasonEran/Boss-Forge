'use client';

import { LoaderCircle } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export function Panel({
  title,
  description,
  children,
  spotlight,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  spotlight?: string;
}) {
  return (
    <Card>
      <CardHeader data-spotlight={spotlight}>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}
export const inputClass =
  'h-11 w-full rounded-md border bg-white px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:h-10 md:text-sm';
export const textareaClass =
  'min-h-24 w-full rounded-md border bg-white p-3 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';
export function Field({
  label,
  hint,
  className = '',
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`grid min-w-0 gap-1.5 text-sm font-medium ${className}`}>
      <span>{label}</span>
      {children}
      {hint ? (
        <span className="text-xs font-normal text-muted-foreground">
          {hint}
        </span>
      ) : null}
    </label>
  );
}
export function Notice({
  error,
  message,
  errorHint = '相关数据没有更新。请检查填写内容或网络连接后重试；若问题持续，请联系管理员查看服务状态。',
}: {
  error?: string | null;
  message?: string | null;
  errorHint?: string | null;
}) {
  return error ? (
    <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
      <p>{error}</p>
      {errorHint ? <p className="mt-1 text-xs leading-5">{errorHint}</p> : null}
    </div>
  ) : message ? (
    <output className="block rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700">
      {message}
    </output>
  ) : null;
}
export function Empty({
  children = '暂无数据',
}: {
  children?: React.ReactNode;
}) {
  return (
    <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}
export function LoadingState({
  label = '正在读取最新数据…',
  compact = false,
}: {
  label?: string;
  compact?: boolean;
}) {
  return (
    <output
      aria-live="polite"
      className={`grid place-items-center rounded-xl border bg-card text-sm text-muted-foreground ${compact ? 'min-h-11 px-4 py-2' : 'min-h-40 p-6'}`}
    >
      <span className="flex items-center gap-2">
        <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
        {label}
      </span>
    </output>
  );
}
export function AdvancedSection({
  title = '高级功能',
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group rounded-xl border bg-card">
      <summary className="flex min-h-11 cursor-pointer list-none items-center px-4 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span>{title}</span>
        <span className="ml-auto text-xs font-normal text-muted-foreground group-open:hidden">
          展开
        </span>
        <span className="ml-auto hidden text-xs font-normal text-muted-foreground group-open:inline">
          收起
        </span>
      </summary>
      <div className="space-y-4 border-t p-4">
        {description ? (
          <p className="text-sm leading-6 text-muted-foreground">
            {description}
          </p>
        ) : null}
        {children}
      </div>
    </details>
  );
}
