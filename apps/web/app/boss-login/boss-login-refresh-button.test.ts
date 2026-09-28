import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('./boss-login-client.tsx', import.meta.url),
  'utf8',
);

describe('BOSS login self-recovery refresh', () => {
  it('exposes a reconnect CTA when the login relay is in error hold', () => {
    expect(source).toContain('重新连接扫码服务');
    expect(source).toContain('data-testid="boss-login-reconnect"');
    expect(source).toContain('扫码服务异常');
    expect(source).toContain('不会清除已保存的登录目录');
  });

  it('keeps polling through transient error/offline while Chromium restarts', () => {
    expect(source).toContain('recovering ? 90_000 : 45_000');
    expect(source).not.toContain(
      "if (next.state === 'error' || next.state === 'offline')",
    );
    expect(source).toContain("next.state === 'risk_controlled'");
  });

  it('relabels the header refresh button for service faults', () => {
    expect(source).toContain('data-testid="boss-login-refresh"');
    expect(source).toContain('立即刷新二维码');
    expect(source).toContain('正在重新连接');
  });
});
