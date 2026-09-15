import { describe, expect, it } from 'vitest';

import {
  isNavigationActive,
  moduleNavigation,
  navigationForRole,
  primaryNavigation,
} from './workspace-navigation';

describe('workspace navigation', () => {
  it('places the recruiting workflow directly below real-time communication', () => {
    expect(primaryNavigation).toHaveLength(9);
    expect(navigationForRole('admin').map((item) => item.label)).toEqual([
      '工作台',
      '岗位设置',
      '任务与计划',
      '候选人',
      '联系',
      '实时沟通',
      '招聘流程',
      '招聘运营',
      '系统设置',
    ]);
  });

  it('keeps candidate and assigned interview workflows accessible to interviewers', () => {
    expect(navigationForRole('interviewer').map((item) => item.href)).toEqual([
      '/',
      '/candidates',
      '/pipeline',
    ]);
  });

  it('places contact safety inside system settings', () => {
    const contacts = primaryNavigation.find(item => item.href === '/contacts')!;
    const settings = primaryNavigation.find(item => item.href === '/team')!;
    expect(isNavigationActive(contacts, '/automation')).toBe(false);
    expect(isNavigationActive(settings, '/automation')).toBe(true);
    const settingsPages = moduleNavigation.find(items => items.some(item => item.href === '/team'))!;
    expect(settingsPages.find(item => item.href === '/automation')?.roles).toEqual(['admin', 'recruiting_lead']);
  });

  it('removes duplicate page tabs and highlights the standalone workflow', () => {
    const standalone = ['/tasks', '/candidates', '/pipeline', '/contacts', '/communication'];
    expect(moduleNavigation.flat().some(item => standalone.includes(item.href))).toBe(false);
    expect(isNavigationActive(primaryNavigation.find(item => item.href === '/candidates')!, '/pipeline')).toBe(false);
    expect(isNavigationActive(primaryNavigation.find(item => item.href === '/pipeline')!, '/pipeline')).toBe(true);
  });
});
