export const workspacePaths = [
  '/',
  '/positions',
  '/tasks',
  '/candidates',
  '/contacts',
  '/communication',
  '/audit',
  '/pipeline',
  '/operations',
  '/analytics',
  '/team',
  '/boss-login',
  '/automation',
  '/guide',
] as const;
export function workspaceDestination(
  href: string,
  current: string,
): URL | null {
  try {
    const base = new URL(current);
    const url = new URL(href, base);
    if (
      url.origin !== base.origin ||
      !workspacePaths.some((path) => path === url.pathname)
    )
      return null;
    return url;
  } catch {
    return null;
  }
}
export function shouldHandleWorkspaceClick(
  event: {
    button: number;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    defaultPrevented: boolean;
  },
  target?: string,
  download?: unknown,
) {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    (!target || target === '_self') &&
    (download === undefined || download === false)
  );
}
