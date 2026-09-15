import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('./dashboard-client.tsx', import.meta.url),
  'utf8',
);

describe('dashboard position and task pairing', () => {
  it('selects the latest task from the currently displayed position', () => {
    expect(source).toContain('item.positionId === position?.id');
    expect(source).not.toContain('const latestTask = data?.tasks[0]');
  });

  it('scopes both candidate review and contact lists to one named task', () => {
    expect(source).toContain('candidate.taskId === candidateTaskId');
    expect(source).toContain('taskContactIntents');
    expect(source).toContain('选择联系名单所属任务');
  });
});
