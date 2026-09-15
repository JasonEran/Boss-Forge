'use client';

import { clearRequestCache } from './request-cache';

export const sessionTokenKey = 'boss-forge.session-token';
const localDevelopmentApi = 'http://127.0.0.1:3100';

function loopbackHostname(hostname: string): boolean {
  return (
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

function urlOf(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * A browser on another machine must never call its own 127.0.0.1. Production
 * exposes the API through the same gateway as the web app, so a missing or
 * accidentally loopback build-time value safely falls back to that origin.
 */
export function resolveControlApiUrl(
  configuredUrl: string | undefined,
  browserOrigin: string | undefined,
): string {
  const configured = configuredUrl?.trim().replace(/\/+$/, '');
  const origin = browserOrigin?.trim().replace(/\/+$/, '');
  const browserUrl = origin ? urlOf(origin) : null;
  const configuredApiUrl = configured ? urlOf(configured) : null;
  const configuredIsLoopback =
    configuredApiUrl !== null && loopbackHostname(configuredApiUrl.hostname);

  if (
    origin &&
    browserUrl &&
    (!configured || configuredIsLoopback) &&
    (!loopbackHostname(browserUrl.hostname) ||
      (browserUrl.protocol === 'https:' &&
        configuredApiUrl?.protocol === 'http:'))
  ) {
    return origin;
  }

  return configured || localDevelopmentApi;
}

export const controlApi = resolveControlApiUrl(
  process.env.NEXT_PUBLIC_CONTROL_API_URL,
  typeof window === 'undefined' ? undefined : window.location.origin,
);

export function userFacingRequestError(
  error: unknown,
  fallback = '操作失败，请稍后重试。',
): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  if (
    /load failed|failed to fetch|networkerror|network request failed/i.test(
      message,
    )
  ) {
    return '暂时无法连接系统服务。请刷新页面后重试；若仍失败，请联系管理员检查网关和 API 状态。';
  }
  return message.trim() || fallback;
}

export function sessionToken(): string | null {
  return typeof window === 'undefined'
    ? null
    : window.sessionStorage.getItem(sessionTokenKey);
}

export function saveSessionToken(token: string): void {
  clearRequestCache();
  window.sessionStorage.setItem(sessionTokenKey, token);
}

export function clearSessionToken(): void {
  clearRequestCache();
  window.sessionStorage.removeItem(sessionTokenKey);
}

export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = !init.method || init.method === 'GET' ? 15000 : 90000,
): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = sessionToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  const controller = new AbortController();
  const abort = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) abort();
  else init.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(
    () =>
      controller.abort(new DOMException('请求超时，请重试。', 'TimeoutError')),
    timeoutMs,
  );
  try {
    const response = await fetch(input, {
      ...init,
      headers,
      signal: controller.signal,
    });
    if (response.ok && init.method && !['GET', 'HEAD'].includes(init.method))
      clearRequestCache();
    if (response.status === 401 && token === sessionToken())
      window.dispatchEvent(new Event('boss-forge:session-expired'));
    return response;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw new Error(userFacingRequestError(error));
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener('abort', abort);
  }
}
