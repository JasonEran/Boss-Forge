import { describe, expect, it } from 'vitest';
import {
  shouldHandleWorkspaceClick,
  workspaceDestination,
} from './workspace-route-model';
const click = {
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
};
describe('workspace route navigation', () => {
  it('resolves a known page without losing tour or task context', () => {
    const url = workspaceDestination(
      '/candidates?task=history&tour=review',
      'https://example.test/tasks',
    );
    expect(url?.pathname).toBe('/candidates');
    expect(url?.searchParams.get('task')).toBe('history');
    expect(url?.searchParams.get('tour')).toBe('review');
  });
  it.each([
    'https://outside.test/tasks',
    '//outside.test/tasks',
    '/api/dashboard',
    '/unknown',
    'mailto:a@b.test',
    'javascript:void(0)',
  ])('leaves %s to native navigation', (href) => {
    expect(workspaceDestination(href, 'https://example.test/')).toBeNull();
  });
  it('only intercepts a normal unmodified same-window click', () => {
    expect(shouldHandleWorkspaceClick(click)).toBe(true);
    for (const modifier of [
      'ctrlKey',
      'metaKey',
      'shiftKey',
      'altKey',
      'defaultPrevented',
    ])
      expect(shouldHandleWorkspaceClick({ ...click, [modifier]: true })).toBe(
        false,
      );
    expect(shouldHandleWorkspaceClick({ ...click, button: 1 })).toBe(false);
    expect(shouldHandleWorkspaceClick(click, '_blank')).toBe(false);
    expect(shouldHandleWorkspaceClick(click, undefined, 'report.csv')).toBe(
      false,
    );
  });
});
