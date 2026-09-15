'use client';

import { apiFetch, controlApi, sessionToken } from './api-client';
import { cachedRequest, sharedRequest } from './request-cache';

export { controlApi };
export type Row = Record<string, unknown>;

export async function apiJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const fetcher = async () => {
    const response = await apiFetch(`${controlApi}${path}`, init);
    const payload = (await response.json()) as T & { message?: string };
    if (!response.ok)
      throw new Error(payload.message ?? `HTTP ${response.status}`);
    return payload;
  };
  return (!init.method || init.method === 'GET') && !init.signal
    ? sharedRequest(sessionToken() ?? '', path, fetcher)
    : fetcher();
}

export function cachedApiJson<T>(path: string): T | null {
  return cachedRequest<T>(sessionToken() ?? '', path);
}

export function postJson<T>(path: string, body: unknown): Promise<T> {
  return apiJson<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function rows(value: unknown): Row[] {
  return Array.isArray(value) ? (value as Row[]) : [];
}
export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
export function formatDate(value: unknown): string {
  return typeof value === 'string'
    ? new Date(value).toLocaleString('zh-CN')
    : '—';
}
