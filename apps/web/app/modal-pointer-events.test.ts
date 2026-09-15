import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function componentSource(name: string): string {
  return readFileSync(resolve(process.cwd(), 'apps/web/components/ui', name), 'utf8');
}

describe('closed modal layers', () => {
  it('cannot intercept clicks after a dialog closes', () => {
    expect(componentSource('dialog.tsx')).toContain('data-closed:pointer-events-none');
    expect(componentSource('alert-dialog.tsx')).toContain('data-closed:pointer-events-none');
  });

  it('cannot intercept clicks while a sheet is leaving', () => {
    expect(componentSource('sheet.tsx')).toContain('data-ending-style:pointer-events-none');
  });
});
