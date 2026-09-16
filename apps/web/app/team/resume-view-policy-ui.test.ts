import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('./team-client.tsx', import.meta.url),
  'utf8',
);

describe('system settings resume viewing policy', () => {
  it('shows effective usage, cadence, limits, and risk behavior', () => {
    expect(source).toContain('/api/system/resume-view-policy');
    expect(source).toContain('简历查看策略');
    expect(source).toContain('今日已查看');
    expect(source).toContain('最近一小时');
    expect(source).toContain('系统硬上限');
    expect(source).toContain('/api/system/resume-view-policy/reset');
    expect(source).toContain('重置本轮软额度');
    expect(source).toContain('检测到验证码、访问受限或平台风控时');
    expect(source).toContain('系统会立即停止查看，并在登录页显示风控状态');
  });

  it('shows 无限制 when quotas are disabled instead of fake caps', () => {
    expect(source).toContain('quotasEnabled');
    expect(source).toContain('无限制');
    expect(source).toContain('无限制（额度已关闭）');
    expect(source).toContain('不设上限、不停筛');
    expect(source).toContain('不分批暂停');
    // Soft-reset only when quotas are on
    expect(source).toContain('{quotasEnabled ? (');
    expect(source).toMatch(/quotasEnabled \? \([\s\S]*重置本轮软额度/);
  });
});
