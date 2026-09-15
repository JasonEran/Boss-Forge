import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../dashboard-client.tsx', import.meta.url),
  'utf8',
);

describe('candidate task grouping', () => {
  it('shows one selected task at a time and resets every candidate section page', () => {
    expect(source).toContain('candidate.taskId === candidateTaskId');
    expect(source).toContain("taskScopeSelect('选择候选人所属任务')");
    expect(source).toContain('aria-label={ariaLabel}');
    expect(source).not.toContain('aria-label="按岗位筛选候选人"');
    expect(source).toContain('key={candidateTaskId}');
    expect(source).toContain('<CandidateInbox');
    expect(source).toContain('setApprovedCandidatePage(1)');
    expect(source).toContain("taskScopeSelect('选择联系名单所属任务')");
  });
});
