import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dashboard = readFileSync(
  new URL('./dashboard-client.tsx', import.meta.url),
  'utf8',
);

describe('audit labels', () => {
  it('explains resume viewing and screening outcomes to HR users', () => {
    expect(dashboard).toContain("'candidate.resume_viewed': '已安全查看简历'");
    expect(dashboard).toContain(
      "'candidate.resume_screening.failed': '简历精筛失败'",
    );
    expect(dashboard).toContain(
      "'candidate.resume_screening.no_text': '简历未识别到正文'",
    );
    expect(dashboard).toContain(
      "'candidate.resume_screening.retry_authorized': '允许重试简历精筛'",
    );
  });
});
