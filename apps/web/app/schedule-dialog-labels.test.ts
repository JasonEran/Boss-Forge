import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('./schedule-dialog.tsx', import.meta.url),
  'utf8',
);

describe('schedule dialog HR labels', () => {
  it('renders business labels instead of internal enum values', () => {
    expect(source).toContain('frequencyLabels[frequency]');
    expect(source).toContain('sourceLabels[source]');
    expect(source).toContain("recommend: 'BOSS 推荐'");
    expect(source).toContain("search: '关键词搜索'");
  });

  it('explains how an out-of-hours first run resumes', () => {
    expect(source).toContain('在下一个可运行时段自动继续');
    expect(source).toContain('无需重复创建');
  });

  it('exposes a per-batch auto-greet switch for timed filters', () => {
    expect(source).toContain('自动打招呼');
    expect(source).toContain('autoGreet');
    expect(source).toContain('id="schedule-auto-greet"');
    expect(source).not.toContain('不会打招呼');
  });
});
