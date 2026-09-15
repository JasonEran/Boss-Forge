const reloadKey = 'boss-forge.workspace-reload-at';

export function isWorkspaceChunkError(reason: unknown): boolean {
  return (
    reason instanceof Error &&
    /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk [\w-]+ failed|Unable to preload CSS/i.test(
      reason.message,
    )
  );
}

/** A deployment can remove a chunk referenced by an already-open page. */
export function reserveWorkspaceReload(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  now = Date.now(),
): boolean {
  try {
    const previous = Number(storage.getItem(reloadKey));
    if (previous > 0 && now - previous < 60_000) return false;
    storage.setItem(reloadKey, String(now));
    return true;
  } catch {
    return false;
  }
}


/** Only our page-module deadline may trigger navigation recovery. API timeouts
 * and application errors must keep their normal handling. */
export class WorkspacePageLoadTimeout extends Error {
  constructor(){super('页面加载较慢，请重试或刷新打开。');this.name='WorkspacePageLoadTimeout';}
}
export function isRecoverableWorkspaceLoad(reason:unknown):boolean {
  return isWorkspaceChunkError(reason)||reason instanceof WorkspacePageLoadTimeout;
}
