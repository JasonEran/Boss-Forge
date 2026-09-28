'use client';

import { apiJson, cachedApiJson } from '../workspace-utils';

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import {
  CheckCircle2,
  LoaderCircle,
  QrCode,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiFetch } from '../api-client';
import { AuthGate } from '../auth-gate';
import { WorkspaceShell } from '../workspace-shell';
import { Notice, Panel } from '../workspace-ui';
import { controlApi } from '../workspace-utils';

type RelayState =
  | 'offline'
  | 'starting'
  | 'refreshing'
  | 'awaiting_scan'
  | 'authenticated'
  | 'risk_controlled'
  | 'error';

type RelayStatus = {
  state: RelayState;
  message: string;
  updatedAt: string | null;
  imageAvailable: boolean;
  imageUpdatedAt: string | null;
  contactDispatchMode: 'disabled' | 'fake' | 'real';
  sideEffectsMode:
    | 'preview_only'
    | 'fake_only'
    | 'real_greet_enabled'
    | 'real_enabled';
  verification?: {
    browserAuthenticated?: boolean;
    workerHeartbeatFresh?: boolean;
    verifiedAt?: string;
  } | null;
  runtimeConsistent?: boolean;
  runtimeMismatchReasons?: string[];
};

const runtimeMismatchLabels: Record<string, string> = {
  worker_release_unknown: '后台处理版本尚未上报',
  release_mismatch: '页面服务与后台处理版本不一致',
  worker_resume_policy_unknown: '后台简历查看策略尚未上报',
  resume_policy_mismatch: '页面服务与后台简历查看策略不一致',
  worker_contact_dispatch_mode_unknown: '后台联系发送模式尚未上报',
  contact_dispatch_mode_mismatch: '页面服务与后台联系发送模式不一致',
  worker_verification_incomplete: '网页登录或后台运行心跳尚未完全确认',
};

const stateLabels: Record<RelayState, string> = {
  offline: '服务未启动',
  starting: '正在启动',
  refreshing: '正在刷新二维码',
  awaiting_scan: '等待扫码',
  authenticated: '登录成功',
  risk_controlled: '检测到风控',
  error: '服务异常',
};

function BossLoginContent() {
  const [status, setStatus] = useState<RelayStatus | null>(() =>
    cachedApiJson<RelayStatus>('/api/boss-login/status'),
  );
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [checking, setChecking] = useState(false);
  const imageUrlRef = useRef<string | null>(null);

  const replaceImage = useCallback((next: string | null) => {
    const previous = imageUrlRef.current;
    imageUrlRef.current = next;
    setImageUrl(next);
    if (previous) URL.revokeObjectURL(previous);
  }, []);

  const readStatus = useCallback(async (): Promise<RelayStatus> => {
    return apiJson<RelayStatus>('/api/boss-login/status', {
      cache: 'no-store',
    });
  }, []);

  const applyStatus = useCallback(
    async (next: RelayStatus, loadImage: boolean) => {
      setStatus(next);
      if (next.state === 'awaiting_scan' && next.imageAvailable && loadImage) {
        const imageResponse = await apiFetch(
          `${controlApi}/api/boss-login/image?updatedAt=${encodeURIComponent(next.imageUpdatedAt ?? '')}`,
          { cache: 'no-store' },
        );
        if (!imageResponse.ok) {
          const payload = (await imageResponse.json()) as { message?: string };
          throw new Error(payload.message ?? `HTTP ${imageResponse.status}`);
        }
        replaceImage(URL.createObjectURL(await imageResponse.blob()));
      } else if (
        next.state !== 'awaiting_scan' &&
        next.state !== 'refreshing'
      ) {
        replaceImage(null);
      }
    },
    [replaceImage],
  );

  const checkStatus = useCallback(async () => {
    setChecking(true);
    try {
      await applyStatus(await readStatus(), false);
      setError(null);
    } catch (checkError) {
      setError(
        checkError instanceof Error ? checkError.message : String(checkError),
      );
    } finally {
      setChecking(false);
    }
  }, [applyStatus, readStatus]);

  const refreshQrCode = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const recovering =
        status?.state === 'error' ||
        status?.state === 'offline' ||
        status?.state === 'starting';
      const previousImageUpdatedAt = status?.imageUpdatedAt ?? null;
      const response = await apiFetch(`${controlApi}/api/boss-login/refresh`, {
        method: 'POST',
      });
      const payload = (await response.json()) as { message?: string };
      if (!response.ok)
        throw new Error(payload.message ?? `HTTP ${response.status}`);

      // Error-hold recovery restarts Chromium via compose on-failure; allow
      // longer than a normal in-place QR refresh, and do not abort on the
      // transient error/offline/starting states that appear mid-restart.
      const deadline = Date.now() + (recovering ? 90_000 : 45_000);
      let lastMessage = payload.message ?? null;
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 700));
        const next = await readStatus();
        setStatus(next);
        lastMessage = next.message;
        if (next.state === 'authenticated') {
          replaceImage(null);
          setError(null);
          return;
        }
        if (next.state === 'risk_controlled') {
          replaceImage(null);
          throw new Error(next.message);
        }
        if (
          next.state === 'awaiting_scan' &&
          next.imageAvailable &&
          next.imageUpdatedAt &&
          next.imageUpdatedAt !== previousImageUpdatedAt
        ) {
          await applyStatus(next, true);
          setError(null);
          return;
        }
      }
      throw new Error(
        lastMessage
          ? `二维码刷新超时：${lastMessage}`
          : '二维码刷新超时，请稍后重试。',
      );
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : String(refreshError),
      );
    } finally {
      setRefreshing(false);
    }
  }, [applyStatus, readStatus, replaceImage, status]);

  useEffect(() => {
    let cancelled = false;
    const loadOnce = async () => {
      try {
        const next = await readStatus();
        if (!cancelled) await applyStatus(next, true);
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error ? loadError.message : String(loadError),
          );
        }
      }
    };
    void loadOnce();
    const timer = window.setInterval(() => {
      void readStatus()
        .then((next) => {
          if (!cancelled) return applyStatus(next, false);
        })
        .then(() => {
          if (!cancelled) setError(null);
        })
        .catch((pollError: unknown) => {
          if (!cancelled)
            setError(
              pollError instanceof Error
                ? pollError.message
                : String(pollError),
            );
        });
    }, 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
      imageUrlRef.current = null;
    };
  }, [applyStatus, readStatus]);

  const authenticated = status?.state === 'authenticated';
  const runtimeConsistent = status?.runtimeConsistent === true;
  const verifiedAuthenticated =
    authenticated &&
    runtimeConsistent &&
    status.verification?.browserAuthenticated === true &&
    status.verification?.workerHeartbeatFresh === true;
  const waiting = status?.state === 'awaiting_scan';
  const riskControlled = status?.state === 'risk_controlled';
  const serviceFault =
    status?.state === 'error' ||
    status?.state === 'offline' ||
    (!status && Boolean(error));
  const refreshLabel = refreshing
    ? serviceFault
      ? '正在重新连接'
      : '正在刷新'
    : serviceFault
      ? '重新连接扫码服务'
      : '立即刷新二维码';
  const realGreetingConfigured =
    status?.contactDispatchMode === 'real' &&
    (status?.sideEffectsMode === 'real_greet_enabled' ||
      status?.sideEffectsMode === 'real_enabled');
  const realGreetingEnabled = realGreetingConfigured && runtimeConsistent;
  const fakeContactEnabled =
    status?.contactDispatchMode === 'fake' &&
    status?.sideEffectsMode === 'fake_only' &&
    runtimeConsistent;
  const previewOnly =
    status?.contactDispatchMode === 'disabled' &&
    status?.sideEffectsMode === 'preview_only' &&
    runtimeConsistent;
  const knownContactMode =
    realGreetingEnabled || fakeContactEnabled || previewOnly;
  const badgeVariant = verifiedAuthenticated
    ? 'default'
    : status?.state === 'error' || riskControlled || authenticated
      ? 'destructive'
      : 'secondary';

  return (
    <WorkspaceShell
      current="/boss-login"
      title="BOSS 扫码登录"
      description="使用微信扫一扫，进入 BOSS 直聘小程序确认登录。二维码过期时可手动刷新。"
    >
      <Notice error={error} />
      {riskControlled ? (
        <section
          role="alert"
          aria-live="assertive"
          className="mb-5 rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-destructive"
        >
          <div className="flex items-start gap-3">
            <ShieldAlert
              className="mt-0.5 size-5 shrink-0"
              aria-hidden="true"
            />
            <div className="space-y-1">
              <h2 className="font-semibold">
                检测到 BOSS 风控，后台处理已停止
              </h2>
              <p className="text-sm">{status.message}</p>
              <p className="text-sm">
                请先在 BOSS 官方 App
                或网页完成安全验证。恢复后台处理前，管理员必须先确认浏览器登录目录已持久化；不要清除
                Cookie、登录数据或浏览器配置。
              </p>
            </div>
          </div>
        </section>
      ) : null}
      {status && status.runtimeConsistent !== true && !riskControlled ? (
        <section
          role="alert"
          className="mb-5 rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm"
        >
          <h2 className="font-semibold text-destructive">
            登录与后台状态未完全一致，已阻止自动操作
          </h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
            {(status.runtimeMismatchReasons?.length
              ? status.runtimeMismatchReasons
              : ['unknown']
            ).map((reason) => (
              <li key={reason}>
                {runtimeMismatchLabels[reason] ?? '状态验证信息不完整'}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-muted-foreground">
            请等待系统自动接管并重新检查；如果需要重启服务，先确认登录目录已持久化。不要刷新二维码或重新登录来绕过此状态。
          </p>
        </section>
      ) : null}
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.75fr)]">
        <Panel
          title="微信小程序扫码登录"
          description="已为你选择 BOSS「微信登录/注册」。请用微信扫描下方小程序二维码。"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <output className="flex items-center gap-2" aria-atomic="true">
              <Badge variant={badgeVariant}>
                {authenticated && !verifiedAuthenticated
                  ? '网页登录可见，后台待确认'
                  : status
                    ? stateLabels[status.state]
                    : '正在读取状态'}
              </Badge>
              <span className="text-sm text-muted-foreground">
                {status?.message ?? '正在连接扫码登录服务…'}
              </span>
            </output>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void checkStatus()}
                disabled={refreshing || checking}
              >
                {checking ? (
                  <LoaderCircle
                    className="size-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <CheckCircle2 className="size-4" aria-hidden="true" />
                )}
                检查登录状态
              </Button>
              <Button
                type="button"
                size="sm"
                data-testid="boss-login-refresh"
                onClick={() => void refreshQrCode()}
                disabled={
                  refreshing || checking || authenticated || riskControlled
                }
              >
                {refreshing ? (
                  <LoaderCircle
                    className="size-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <RefreshCw className="size-4" aria-hidden="true" />
                )}
                {refreshLabel}
              </Button>
            </div>
          </div>

          <div className="grid min-h-[420px] place-items-center overflow-hidden rounded-xl border bg-muted/35 p-3 sm:p-5">
            {imageUrl && (waiting || status?.state === 'refreshing') ? (
              <Image
                src={imageUrl}
                alt="BOSS 直聘微信小程序登录二维码，请使用微信扫一扫"
                width={1100}
                height={820}
                unoptimized
                className="max-h-[70vh] w-auto max-w-full rounded-lg border bg-white object-contain shadow-sm"
              />
            ) : verifiedAuthenticated ? (
              <div className="max-w-md space-y-3 text-center">
                <CheckCircle2
                  className="mx-auto size-12 text-success"
                  aria-hidden="true"
                />
                <p className="text-lg font-semibold">BOSS 账号已登录</p>
                <p className="text-sm text-muted-foreground">
                  {realGreetingEnabled
                    ? '登录服务已确认会话有效，当前配置允许受控真实联系。'
                    : fakeContactEnabled
                      ? '登录服务已确认会话有效，当前仅允许筛选和模拟联系。'
                      : '登录服务已确认会话有效；筛选继续运行，联系消息仅供预览，发送处理程序未启动。'}
                </p>
              </div>
            ) : authenticated ? (
              <div className="max-w-md space-y-3 text-center">
                <ShieldAlert
                  className="mx-auto size-12 text-destructive"
                  aria-hidden="true"
                />
                <p className="text-lg font-semibold">网页登录状态可见</p>
                <p className="text-sm text-muted-foreground">
                  后台处理尚未通过一致性与心跳检查，系统已暂停继续操作。请保留当前登录数据并等待管理员处理。
                </p>
              </div>
            ) : riskControlled ? (
              <div className="max-w-md space-y-3 text-center">
                <ShieldAlert
                  className="mx-auto size-12 text-destructive"
                  aria-hidden="true"
                />
                <p className="text-lg font-semibold text-destructive">
                  检测到风控
                </p>
                <p className="text-sm text-muted-foreground">
                  已停止自动操作，不会继续刷新、筛选或发送消息。
                </p>
              </div>
            ) : serviceFault ? (
              <div className="max-w-md space-y-4 text-center">
                <ShieldAlert
                  className="mx-auto size-12 text-destructive"
                  aria-hidden="true"
                />
                <p className="text-lg font-semibold text-destructive">
                  扫码服务异常
                </p>
                <p className="text-sm text-muted-foreground">
                  {status?.message ??
                    error ??
                    '二维码暂时不可用。可重新连接扫码服务，系统会重启浏览器连接并重新获取微信小程序二维码。'}
                </p>
                <Button
                  type="button"
                  size="lg"
                  data-testid="boss-login-reconnect"
                  onClick={() => void refreshQrCode()}
                  disabled={refreshing || checking}
                >
                  {refreshing ? (
                    <LoaderCircle
                      className="size-4 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <RefreshCw className="size-4" aria-hidden="true" />
                  )}
                  {refreshing ? '正在重新连接' : '重新连接扫码服务'}
                </Button>
                <p className="text-xs text-muted-foreground">
                  不会清除已保存的登录目录。若仍失败，请稍后再试或联系管理员。
                </p>
              </div>
            ) : (
              <div className="max-w-md space-y-3 text-center">
                {status?.state === 'starting' ||
                status?.state === 'refreshing' ||
                !status ? (
                  <LoaderCircle
                    className="mx-auto size-10 animate-spin text-primary"
                    aria-hidden="true"
                  />
                ) : (
                  <QrCode
                    className="mx-auto size-12 text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
                <p className="font-medium">
                  {status?.message ?? '正在等待扫码画面…'}
                </p>
                <p className="text-sm text-muted-foreground">
                  二维码只会在管理员登录后的页面中显示，不会公开暴露。
                </p>
              </div>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            二维码获取时间：
            {status?.imageUpdatedAt
              ? new Date(status.imageUpdatedAt).toLocaleString('zh-CN')
              : '—'}
          </p>
        </Panel>

        <div className="space-y-5">
          <Panel title="扫码步骤">
            <ol className="space-y-4 text-sm">
              <li className="flex gap-3">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                  1
                </span>
                <span>打开手机微信，点击右上角“＋”选择“扫一扫”。</span>
              </li>
              <li className="flex gap-3">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                  2
                </span>
                <span>扫描左侧二维码，进入 BOSS 直聘微信小程序。</span>
              </li>
              <li className="flex gap-3">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                  3
                </span>
                <span>在小程序中确认登录，然后点击“检查登录状态”。</span>
              </li>
            </ol>
          </Panel>
          <Panel title="二维码过期或服务异常怎么办">
            <p className="text-sm text-muted-foreground">
              过期时点“立即刷新二维码”；若提示“二维码刷新失败”或服务异常，点“重新连接扫码服务”，系统会重启浏览器连接并重新获取微信小程序二维码。处理期间按钮会锁定，避免重复请求。
            </p>
          </Panel>
          <Panel title="安全边界">
            <div
              className={`flex gap-3 rounded-lg p-4 text-sm ${runtimeConsistent ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}
            >
              {runtimeConsistent ? (
                <ShieldCheck
                  className="mt-0.5 size-5 shrink-0"
                  aria-hidden="true"
                />
              ) : (
                <ShieldAlert
                  className="mt-0.5 size-5 shrink-0"
                  aria-hidden="true"
                />
              )}
              <p>
                {!runtimeConsistent || !knownContactMode
                  ? '无法确认联系运行模式，真实联系应保持阻止，请管理员查看系统状态。'
                  : realGreetingEnabled
                    ? '登录和后台状态已一致确认。真实联系仍必须逐人预览、人工确认，并通过时段、额度、账号健康、冷却期和紧急停止检查。'
                    : fakeContactEnabled
                      ? '登录和后台状态已一致确认；当前只允许筛选和模拟联系，不会向候选人发送消息。'
                      : '登录和后台状态已一致确认；筛选继续运行，联系消息仅供预览，发送处理程序未启动。'}
              </p>
            </div>
          </Panel>
        </div>
      </div>
    </WorkspaceShell>
  );
}

export function BossLoginClient() {
  return (
    <AuthGate allowedRoles={['admin', 'recruiting_lead']}>
      <BossLoginContent />
    </AuthGate>
  );
}
