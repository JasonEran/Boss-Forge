'use client';

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from 'react';
import { LockKeyhole, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  apiFetch,
  clearSessionToken,
  controlApi,
  saveSessionToken,
  sessionToken,
  userFacingRequestError,
} from './api-client';
import { NativeLink as Link } from './native-link';
import type { DepartmentRole } from './workspace-navigation';

export type AuthenticatedUser = {
  userId: string;
  departmentId: string;
  email: string;
  displayName: string;
  role: DepartmentRole;
};

const CurrentUserContext = createContext<AuthenticatedUser | null>(null);

export function useCurrentUser(): AuthenticatedUser {
  const user = useContext(CurrentUserContext);
  if (!user) throw new Error('useCurrentUser must be used inside AuthGate.');
  return user;
}

export function AuthGate({
  children,
  allowedRoles,
}: {
  children: ReactNode;
  allowedRoles?: readonly DepartmentRole[];
}) {
  const inherited = useContext(CurrentUserContext);
  if (inherited)
    return (
      <RoleGate user={inherited} allowedRoles={allowedRoles}>
        {children}
      </RoleGate>
    );
  return <SessionGate allowedRoles={allowedRoles}>{children}</SessionGate>;
}

function RoleGate({
  user,
  allowedRoles,
  children,
}: {
  user: AuthenticatedUser;
  allowedRoles?: readonly DepartmentRole[];
  children: ReactNode;
}) {
  if (!allowedRoles || allowedRoles.includes(user.role)) return children;
  return (
    <main className="grid min-h-screen place-items-center bg-muted/30 p-6">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>当前账号无需使用此页面</CardTitle>
          <CardDescription>该功能只向对应岗位角色开放。</CardDescription>
        </CardHeader>
        <CardContent>
          <Button nativeButton={false} render={<Link href="/" />}>
            返回工作台
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

function SessionGate({
  children,
  allowedRoles,
}: {
  children: ReactNode;
  allowedRoles?: readonly DepartmentRole[];
}) {
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [email, setEmail] = useState('admin@boss-forge.internal');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [currentUser, setCurrentUser] = useState<AuthenticatedUser | null>(
    null,
  );

  useEffect(() => {
    const expired = () => {
      clearSessionToken();
      setAuthenticated(false);
      setCurrentUser(null);
      setReady(true);
      setError('登录已过期，请重新登录。');
    };
    window.addEventListener('boss-forge:session-expired', expired);
    return () =>
      window.removeEventListener('boss-forge:session-expired', expired);
  }, []);

  useEffect(() => {
    if (!sessionToken()) {
      const timer = window.setTimeout(() => setReady(true), 0);
      return () => window.clearTimeout(timer);
    }
    void apiFetch(`${controlApi}/api/auth/me`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) {
          clearSessionToken();
          setAuthenticated(false);
          return;
        }
        const payload = (await response.json()) as { user: AuthenticatedUser };
        setCurrentUser(payload.user);
        setAuthenticated(true);
      })
      .catch((loadError: unknown) => {
        setAuthenticated(false);
        setError(userFacingRequestError(loadError));
      })
      .finally(() => setReady(true));
  }, []);

  if (!ready) {
    return (
      <main className="grid min-h-screen place-items-center">
        <output className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-6 animate-spin" aria-hidden="true" />
          正在确认登录状态…
        </output>
      </main>
    );
  }
  if (authenticated && currentUser) {
    return (
      <CurrentUserContext.Provider value={currentUser}>
        <RoleGate user={currentUser} allowedRoles={allowedRoles}>
          {children}
        </RoleGate>
      </CurrentUserContext.Provider>
    );
  }

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
      const payload = (await response.json()) as {
        token?: string;
        message?: string;
        principal?: AuthenticatedUser;
      };
      if (!response.ok || !payload.token)
        throw new Error(payload.message ?? '登录失败');
      saveSessionToken(payload.token);
      if (!payload.principal) throw new Error('登录响应缺少用户信息。');
      setCurrentUser(payload.principal);
      setAuthenticated(true);
    } catch (loginError) {
      setError(userFacingRequestError(loginError, '登录失败，请稍后重试。'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-muted/30 p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-2 grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground">
            <LockKeyhole className="size-5" aria-hidden="true" />
          </div>
          <CardTitle>登录 Boss Forge</CardTitle>
          <CardDescription>使用部门内部账号进入招聘工作台。</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={(event) => void login(event)}>
            <label
              htmlFor="login-email"
              className="block space-y-1.5 text-sm font-medium"
            >
              邮箱
              <Input
                id="login-email"
                name="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
            <label
              htmlFor="login-password"
              className="block space-y-1.5 text-sm font-medium"
            >
              密码
              <Input
                id="login-password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
            {error ? (
              <p
                role="alert"
                aria-live="polite"
                className="text-sm text-destructive"
              >
                {error}
              </p>
            ) : null}
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? '登录中…' : '登录'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
