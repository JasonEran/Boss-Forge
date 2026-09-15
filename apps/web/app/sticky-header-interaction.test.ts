import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function appSource(name: string): string {
  return readFileSync(resolve(process.cwd(), 'apps/web/app', name), 'utf8');
}

describe('sticky workspace headers', () => {
  it.each(['workspace-shell.tsx'])(
    'does not create a Safari backdrop-filter hit-testing layer in %s',
    (name) => {
      const source = appSource(name);

      expect(source).toContain('sticky top-0 z-30');
      expect(source).not.toContain('backdrop-blur');
      expect(source).not.toContain('bg-card/95');
    },
  );
});
