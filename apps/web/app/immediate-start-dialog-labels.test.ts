import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('./immediate-start-dialog.tsx', import.meta.url),
  'utf8',
);

describe('immediate start dialog HR labels', () => {
  it('exposes a per-run auto-greet switch matching timed filters', () => {
    expect(source).toContain('自动打招呼');
    expect(source).toContain('autoGreet');
    expect(source).toContain('id="immediate-auto-greet"');
    expect(source).toContain('useState(false)');
    expect(source).toContain('onConfirm(autoGreet)');
  });

  it('explains screening-only vs auto-greet for this immediate task', () => {
    expect(source).toContain('仅对本立即任务生效');
    expect(source).toContain('关闭则只筛选、不打招呼');
  });
});
