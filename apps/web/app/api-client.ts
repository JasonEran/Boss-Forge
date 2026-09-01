'use client';

export const sessionTokenKey = 'boss-forge.session-token';

export function sessionToken(): string | null {
  return typeof window === 'undefined'
    ? null
    : window.sessionStorage.getItem(sessionTokenKey);
}

export function saveSessionToken(token: string): void {
  window.sessionStorage.setItem(sessionTokenKey, token);
}

export function clearSessionToken(): void {
  window.sessionStorage.removeItem(sessionTokenKey);
}

export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = sessionToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}
