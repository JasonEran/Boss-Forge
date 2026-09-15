import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('./boss-login-client.tsx', import.meta.url),
  'utf8',
);

describe('BOSS risk-control UI', () => {
  it('renders an explicit persistent risk-control alert with recovery guidance', () => {
    expect(source).toContain("risk_controlled: '检测到风控'");
    expect(source).toContain('role="alert"');
    expect(source).toContain('后台处理已停止');
    expect(source).toContain('完成安全验证');
    expect(source).toContain('浏览器登录目录已持久化');
  });

  it('disables QR refresh while risk control is active', () => {
    expect(source).toContain('authenticated || riskControlled');
  });

  it('fails closed when login and background runtime cannot be verified together', () => {
    expect(source).toContain('status?.runtimeConsistent === true');
    expect(source).toContain(
      'status.verification?.browserAuthenticated === true',
    );
    expect(source).toContain('登录与后台状态未完全一致，已阻止自动操作');
    expect(source).toContain('不要刷新二维码或重新登录来绕过此状态');
  });
});
