import { guideStepsForRole } from './guide-content';
import type { DepartmentRole } from '../workspace-navigation';

export type GuideProgress = {
  current: string;
  completed: string[];
  mode: 'reading' | 'practicing' | 'paused';
};
export type GuideAction =
  | { type: 'select' | 'practice' | 'complete'; id: string }
  | { type: 'pause' }
  | { type: 'reset' };

export function guideStorageKey(userId: string, departmentId: string) {
  return `boss-forge:hr-guide:v1:${encodeURIComponent(departmentId)}:${encodeURIComponent(userId)}`;
}

export function readGuideProgress(
  raw: string | null,
  role: DepartmentRole,
): GuideProgress {
  const ids = guideStepsForRole(role).map((step) => step.id);
  const initial: GuideProgress = {
    current: ids[0]!,
    completed: [],
    mode: 'reading',
  };
  if (!raw) return initial;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return initial;
    const saved = value as Partial<GuideProgress>;
    return {
      current:
        typeof saved.current === 'string' && ids.includes(saved.current)
          ? saved.current
          : initial.current,
      completed: Array.isArray(saved.completed)
        ? ids.filter((id) => saved.completed!.includes(id))
        : [],
      mode:
        saved.mode === 'practicing' || saved.mode === 'paused'
          ? saved.mode
          : 'reading',
    };
  } catch {
    return initial;
  }
}

export function nextGuideStep(
  progress: GuideProgress,
  role: DepartmentRole,
): string {
  const ids = guideStepsForRole(role).map((step) => step.id);
  const currentIndex = ids.indexOf(progress.current);
  const remaining = [
    ...ids.slice(currentIndex + 1),
    ...ids.slice(0, currentIndex),
  ];
  return (
    remaining.find((id) => !progress.completed.includes(id)) ?? progress.current
  );
}

export function updateGuideProgress(
  progress: GuideProgress,
  action: GuideAction,
  role: DepartmentRole,
): GuideProgress {
  if (action.type === 'reset') return readGuideProgress(null, role);
  if (action.type === 'pause') return { ...progress, mode: 'paused' };
  if (!guideStepsForRole(role).some((step) => step.id === action.id))
    return progress;
  if (action.type === 'select' || action.type === 'practice') {
    return {
      ...progress,
      current: action.id,
      mode: action.type === 'practice' ? 'practicing' : 'reading',
    };
  }
  const completed = [...new Set([...progress.completed, action.id])];
  const marked = {
    ...progress,
    current: action.id,
    completed,
    mode: 'reading' as const,
  };
  return { ...marked, current: nextGuideStep(marked, role) };
}

export function guideActionFromUrl(
  url: URL,
  role: DepartmentRole,
): GuideAction | null {
  const step = guideStepsForRole(role).find(
    (item) => item.id === url.searchParams.get('guide'),
  );
  if (!step) return null;
  if (url.pathname === '/guide' || url.pathname === '/guide/')
    return { type: 'select', id: step.id };
  if (
    url.pathname === step.target.href ||
    step.related?.some((link) => link.href === url.pathname)
  )
    return { type: 'practice', id: step.id };
  return null;
}

export function guidePracticeHref(href: string, stepId: string) {
  const url = new URL(href, 'https://boss-forge.internal');
  url.searchParams.set('guide', stepId);
  return `${url.pathname}${url.search}${url.hash}`;
}
