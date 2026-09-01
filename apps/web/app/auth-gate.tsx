'use client';

import { type ReactNode, useEffect, useState } from 'react';
import { LockKeyhole, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { apiFetch, clearSessionToken, saveSessionToken, sessionToken } from './api-client';

const controlApi = process.env.NEXT_PUBLIC_CONTROL_API_URL ?? 'http://127.0.0.1:3100';

export function AuthGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [email, setEmail] = useState('admin@boss-forge.internal');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!sessionToken()) {
      const timer = window.setTimeout(() => setReady(true), 0);
      return () => window.clearTimeout(timer);
    }
    void apiFetch(`${controlApi}/api/auth/me`, { cache: 'no-store' })
      .then((response) => {
        setAuthenticated(response.ok);
        if (!response.ok) clearSessionToken();
      })
      .finally(() => setReady(true));
  }, []);

  if (!ready) {
    return <main className="grid min-h-screen place-items-center"><LoaderCircle className="size-6 animate-spin" /></main>;
  }
  if (authenticated) return children;

  async function login(event: { preventDefault(): void }) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`${controlApi}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const payload = (await response.json()) as { token?: string; message?: string };
      if (!response.ok || !payload.token) throw new Error(payload.message ?? '登录失败');
      saveSessionToken(payload.token);
      setAuthenticated(true);
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : String(loginError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-muted/30 p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-2 grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground"><LockKeyhole className="size-5" /></div>
          <CardTitle>登录 Boss Forge</CardTitle>
          <CardDescription>使用部门内部账号进入招聘工作台。</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={(event) => void login(event)}>
            <label htmlFor="login-email" className="block space-y-1.5 text-sm font-medium">邮箱<Input id="login-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
            <label htmlFor="login-password" className="block space-y-1.5 text-sm font-medium">密码<Input id="login-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button className="w-full" disabled={submitting}>{submitting ? '登录中…' : '登录'}</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
