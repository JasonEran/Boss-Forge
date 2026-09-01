'use client';

import { apiFetch } from './api-client';

export const controlApi = process.env.NEXT_PUBLIC_CONTROL_API_URL ?? 'http://127.0.0.1:3100';
export type Row = Record<string, unknown>;

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(`${controlApi}${path}`, init);
  const payload = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(payload.message ?? `HTTP ${response.status}`);
  return payload;
}

export function postJson<T>(path: string, body: unknown): Promise<T> {
  return apiJson<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

export function rows(value: unknown): Row[] { return Array.isArray(value) ? value as Row[] : []; }
export function stringValue(value: unknown): string { return typeof value === 'string' ? value : ''; }
export function formatDate(value: unknown): string { return typeof value === 'string' ? new Date(value).toLocaleString('zh-CN') : '—'; }
