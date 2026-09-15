import { describe, expect, it } from 'vitest';
import {
  isWorkspaceChunkError,
  isRecoverableWorkspaceLoad,
  WorkspacePageLoadTimeout,
  reserveWorkspaceReload,
} from './workspace-load-recovery';

describe('workspace deployment recovery', () => {
  it.each([
    'Failed to fetch dynamically imported module: /assets/old.js',
    'Importing a module script failed.',
    'Loading chunk dashboard failed.',
    'Unable to preload CSS for /assets/old.css',
  ])('recognizes stale assets: %s', (message) => {
    expect(isWorkspaceChunkError(new TypeError(message))).toBe(true);
  });
  it('does not reload for an ordinary server, timeout, or application error', () => {
    expect(isWorkspaceChunkError(new Error('Failed to fetch'))).toBe(false);
    expect(
      isWorkspaceChunkError(new Error('页面加载较慢，请重试或刷新打开。')),
    ).toBe(false);
  });
  it('allows one recovery across page loads and prevents a reload loop', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    expect(reserveWorkspaceReload(storage, 100_000)).toBe(true);
    expect(reserveWorkspaceReload(storage, 100_010)).toBe(false);
    expect(reserveWorkspaceReload(storage, 160_001)).toBe(true);
  });
  it('keeps manual recovery when session storage is unavailable', () => {
    expect(
      reserveWorkspaceReload({
        getItem() {
          throw new Error('Unavailable');
        },
        setItem() {},
      }),
    ).toBe(false);
  });
});

it('recovers a stalled page module but never an API timeout or ordinary application error',()=>{
  expect(isRecoverableWorkspaceLoad(new WorkspacePageLoadTimeout())).toBe(true);
  expect(isRecoverableWorkspaceLoad(new TypeError('Failed to fetch dynamically imported module: /assets/old.js'))).toBe(true);
  expect(isRecoverableWorkspaceLoad(new Error('Request timed out'))).toBe(false);
  expect(isRecoverableWorkspaceLoad(new Error('页面加载较慢，请重试或刷新打开。'))).toBe(false);
});
