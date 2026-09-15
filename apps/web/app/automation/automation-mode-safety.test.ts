import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('./automation-client.tsx', import.meta.url),
  'utf8',
);

describe('automation runtime safety presentation', () => {
  it('presents this page as safety configuration rather than a second send entry', () => {
    expect(source).toContain('title="联系安全设置"');
    expect(source).toContain('逐人预览确认');
    expect(source).not.toContain('title="自动联系与安全控制"');
  });

  it('uses manager-owned safety switches without an unreachable scope approval flow', () => {
    expect(source).toContain('approvalRequired: false');
    expect(source).toContain('确认开启${objectLabel(scopeType, scopeId)}联系');
    expect(source).toContain('开启全局联系');
    expect(source).toContain('开启本部门联系');
    expect(source).toContain('保存岗位开关');
    expect(source).toContain('保存任务开关');
    expect(source).not.toContain(
      "postJson('/api/automation/approval-requests'",
    );
    expect(source).not.toContain('授权申请与审批');
    expect(source).not.toContain('申请开启（需审批）');
  });

  it('cross-checks readiness mode and fails closed on mismatches', () => {
    expect(source).toContain('readiness.sideEffectsMode');
    expect(source).toContain('readiness.contactDispatchMode');
    expect(source).toContain("readinessMode.state !== 'blocked'");
    expect(source).toContain('readinessMode.state === effectiveMode.state');
    expect(source).toContain('readinessPassed');
    expect(source).toContain('运行模式来源不一致，已阻止');
  });

  it('keeps real-contact enable and approval actions disabled when transport is unavailable', () => {
    expect(source).toContain('realContactTransportAvailable');
    expect(source).toContain('!realContactAvailable');
    expect(source).toContain('真实联系尚未交付，所有开启入口已禁用');
    expect(source).toContain('环境变量或页面开关都不能绕过此限制');
  });
});
