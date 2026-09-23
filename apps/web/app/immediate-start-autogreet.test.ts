import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('./dashboard-client.tsx', import.meta.url),
  'utf8',
);

describe('immediate start auto-greet wiring', () => {
  it('opens a confirm dialog instead of posting immediately', () => {
    expect(source).toContain('ImmediateStartDialog');
    expect(source).toContain('setImmediateStartDialogOpen(true)');
    expect(source).toContain('onConfirm={createImmediateTask}');
  });

  it('posts autoGreet on POST /api/tasks', () => {
    expect(source).toContain("`${controlApi}/api/tasks`");
    expect(source).toMatch(/autoGreet,\s*\n\s*source: 'recommend'/);
  });
});
