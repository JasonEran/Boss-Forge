import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('./workspace-shell.tsx', import.meta.url),
  'utf8',
);

describe('workspace shell runtime mode', () => {
  it('uses the supplied live mode and avoids a duplicate dashboard request', () => {
    const dashboard = readFileSync(new URL('./dashboard-client.tsx', import.meta.url), 'utf8');
    expect(source).toContain('status?: ReactNode');
    expect(source).not.toContain('/api/dashboard');
    expect(dashboard).toContain('status={contactMode.label}');
    expect(dashboard).toContain('contactRuntimePresentation');
    expect(source).toContain('/api/auth/logout');
  });
});
