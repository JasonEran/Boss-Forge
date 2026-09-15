import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function appSource(name: string): string {
  return readFileSync(resolve(process.cwd(), 'apps/web/app', name), 'utf8');
}

describe('workspace navigation', () => {
  it.each([
    'auth-gate.tsx',
    'dashboard-client.tsx',
    'module-tabs.tsx',
    'workspace-shell.tsx',
  ])('uses workspace links with a native fallback in %s', (name) => {
    const source = appSource(name);

    expect(source).toContain("from './native-link'");
    expect(source).not.toContain("from 'next/link'");
  });

  it('renders a real anchor and ignores the framework-only scroll option', () => {
    const source = appSource('native-link.tsx');

    expect(source).toMatch(/<a\s+href=\{href\}/);
    expect(source).toContain('scroll: _scroll');
    expect(source).toContain('shouldHandleWorkspaceClick');
    expect(source).toContain('router.navigate(href)');
  });
});
