import { describe, expect, it } from 'vitest';
import { resolveWorkspaceScope, taskWorkspaceHref } from './workspace-scope';
const data = {
  positions: [{ id: 'a' }, { id: 'b' }],
  tasks: [
    { id: 'new-b', positionId: 'b' },
    { id: 'new-a', positionId: 'a' },
    { id: 'old-a', positionId: 'a' },
  ],
  candidates: [{ taskId: 'old-a' }],
};
describe('workspace context', () => {
  it('keeps a newly created task selected when an older dashboard poll arrives late', () => {
    const created = { id: 'created-a', positionId: 'a' };
    const scope = { positionId: 'a', taskId: created.id };
    expect(resolveWorkspaceScope(data, scope, created)).toEqual(scope);
    expect(
      resolveWorkspaceScope(
        { ...data, tasks: [created, ...data.tasks] },
        scope,
        created,
      ),
    ).toEqual(scope);
    expect(
      resolveWorkspaceScope(data, { positionId: 'a', taskId: 'old-a' }, created)
        .taskId,
    ).toBe('old-a');
    expect(
      resolveWorkspaceScope(
        data,
        { taskId: 'hidden-task' },
        { id: 'hidden-task', positionId: 'hidden' },
      ).positionId,
    ).toBe('b');
  });
  it('opens a linked historical task instead of silently selecting the latest task', () => {
    expect(resolveWorkspaceScope(data, { taskId: 'old-a' })).toEqual({
      positionId: 'a',
      taskId: 'old-a',
    });
  });
  it('keeps a valid selected job when switching modules', () => {
    expect(
      resolveWorkspaceScope(data, { positionId: 'a', taskId: 'old-a' }),
    ).toEqual({ positionId: 'a', taskId: 'old-a' });
  });
  it('replaces a mismatched task with one belonging to the selected job', () => {
    expect(
      resolveWorkspaceScope(data, { positionId: 'a', taskId: 'new-b' }).taskId,
    ).toBe('old-a');
  });
  it('discards removed or inaccessible selections and handles an empty workspace', () => {
    expect(
      resolveWorkspaceScope(data, { taskId: 'deleted', positionId: 'hidden' }),
    ).toEqual({ positionId: 'b', taskId: 'new-b' });
    expect(
      resolveWorkspaceScope({ positions: [], tasks: [], candidates: [] }, {}),
    ).toEqual({ positionId: '', taskId: '' });
  });
  it('encodes task links and preserves their position', () => {
    const url = new URL(
      taskWorkspaceHref('/candidates', { id: 'a & b', positionId: '岗位' }),
      'https://example.test',
    );
    expect(url.searchParams.get('task')).toBe('a & b');
    expect(url.searchParams.get('position')).toBe('岗位');
  });
});
