export type WorkspaceScope = { positionId: string; taskId: string };
type ScopeData = {
  positions: { id: string }[];
  tasks: { id: string; positionId: string }[];
  candidates: { taskId: string }[];
};

/** Validate stored/linked selections against data the current user can actually see. */
export function resolveWorkspaceScope(
  data: ScopeData,
  requested: Partial<WorkspaceScope>,
  createdTask?: { id: string; positionId: string } | null,
): WorkspaceScope {
  // A poll begun before task creation can arrive after its successful response.
  const task =
    data.tasks.find((item) => item.id === requested.taskId) ??
    (createdTask &&
    createdTask.id === requested.taskId &&
    data.positions.some((item) => item.id === createdTask.positionId)
      ? createdTask
      : undefined);
  const positionId =
    data.positions.find((item) => item.id === requested.positionId)?.id ??
    task?.positionId ??
    data.tasks[0]?.positionId ??
    data.positions[0]?.id ??
    '';
  const taskId =
    task?.positionId === positionId
      ? task.id
      : (data.tasks.find(
          (item) =>
            item.positionId === positionId &&
            data.candidates.some((candidate) => candidate.taskId === item.id),
        )?.id ??
        data.tasks.find((item) => item.positionId === positionId)?.id ??
        '');
  return { positionId, taskId };
}

export function taskWorkspaceHref(
  path: string,
  task: { id: string; positionId: string },
): string {
  return `${path}?${new URLSearchParams({ position: task.positionId, task: task.id })}`;
}

export function readWorkspaceScope(userId: string): Partial<WorkspaceScope> {
  if (typeof window === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  // An explicit link has precedence over the previous session selection.
  if (params.has('position') || params.has('task'))
    return {
      positionId: params.get('position') ?? '',
      taskId: params.get('task') ?? '',
    };
  try {
    const stored: unknown = JSON.parse(
      window.sessionStorage.getItem(`boss-forge.workspace.${userId}`) ?? '{}',
    );
    if (!stored || typeof stored !== 'object') return {};
    const value = stored as Record<string, unknown>;
    return {
      positionId: typeof value.positionId === 'string' ? value.positionId : '',
      taskId: typeof value.taskId === 'string' ? value.taskId : '',
    };
  } catch {
    return {};
  }
}

export function saveWorkspaceScope(userId: string, scope: WorkspaceScope) {
  try {
    window.sessionStorage.setItem(
      `boss-forge.workspace.${userId}`,
      JSON.stringify(scope),
    );
  } catch {
    /* URL still preserves context. */
  }
  const url = new URL(window.location.href);
  for (const [key, value] of [
    ['position', scope.positionId],
    ['task', scope.taskId],
  ]) {
    if (value) url.searchParams.set(key!, value);
    else url.searchParams.delete(key!);
  }
  window.history.replaceState(window.history.state, '', url);
}
