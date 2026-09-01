'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function Panel({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle>{description ? <CardDescription>{description}</CardDescription> : null}</CardHeader><CardContent className="space-y-4">{children}</CardContent></Card>;
}
export const inputClass = 'h-10 w-full rounded-md border bg-white px-3 text-sm';
export const textareaClass = 'min-h-24 w-full rounded-md border bg-white p-3 font-mono text-xs';
export function Notice({ error, message }: { error?: string | null; message?: string | null }) { return error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p> : message ? <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700">{message}</p> : null; }
export function Empty({ children = '暂无数据' }: { children?: React.ReactNode }) { return <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{children}</p>; }
