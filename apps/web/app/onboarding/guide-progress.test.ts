import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { guideStepsForRole } from './guide-content';
import {
  guideActionFromUrl,
  guidePracticeHref,
  guideStorageKey,
  readGuideProgress,
  updateGuideProgress,
} from './guide-progress';
import {
  navigationForRole,
  type DepartmentRole,
} from '../workspace-navigation';

describe('HR guide learning progress', () => {
  it('starts without completing any real or learning task', () => {
    expect(readGuideProgress(null, 'recruiter')).toEqual({
      current: 'overview',
      completed: [],
      mode: 'reading',
    });
  });
  it.each(['broken json', 'null', '[]', 'true', '42'])(
    'recovers malformed saved progress: %s',
    (raw) => {
      expect(readGuideProgress(raw, 'recruiter')).toEqual(
        readGuideProgress(null, 'recruiter'),
      );
    },
  );
  it('deduplicates completed chapters and discards unknown or no longer accessible chapters', () => {
    expect(
      readGuideProgress(
        JSON.stringify({
          current: 'team',
          mode: 'invalid',
          completed: ['team', 'review', 'review', 1, 'deleted'],
        }),
        'recruiter',
      ),
    ).toEqual({ current: 'overview', completed: ['review'], mode: 'reading' });
  });
  it('keeps progress separate for accounts and departments, including delimiter-containing IDs', () => {
    expect(
      new Set([
        guideStorageKey('a', 'b'),
        guideStorageKey('b', 'b'),
        guideStorageKey('a', 'c'),
        guideStorageKey('a:b', 'c'),
        guideStorageKey('b', 'c:a'),
      ]).size,
    ).toBe(5);
  });
  it('visiting and practicing do not mark a chapter as learned', () => {
    const initial = readGuideProgress(null, 'recruiter');
    const selected = updateGuideProgress(
      initial,
      { type: 'select', id: 'review' },
      'recruiter',
    );
    const practice = updateGuideProgress(
      selected,
      { type: 'practice', id: 'review' },
      'recruiter',
    );
    expect(practice).toEqual({
      current: 'review',
      completed: [],
      mode: 'practicing',
    });
    expect(readGuideProgress(JSON.stringify(practice), 'recruiter')).toEqual(
      practice,
    );
  });
  it('pausing preserves the current chapter and prior learning after reload', () => {
    const initial = {
      current: 'review',
      completed: ['overview'],
      mode: 'practicing' as const,
    };
    const paused = updateGuideProgress(initial, { type: 'pause' }, 'recruiter');
    expect(readGuideProgress(JSON.stringify(paused), 'recruiter')).toEqual({
      ...initial,
      mode: 'paused',
    });
  });
  it('marks exactly one chapter and selects the next unlearned chapter', () => {
    const next = updateGuideProgress(
      readGuideProgress(null, 'recruiter'),
      { type: 'complete', id: 'overview' },
      'recruiter',
    );
    expect(next).toEqual({
      current: 'preparation',
      completed: ['overview'],
      mode: 'reading',
    });
    expect(
      updateGuideProgress(
        next,
        { type: 'complete', id: 'overview' },
        'recruiter',
      ).completed,
    ).toEqual(['overview']);
  });
  it('returns to skipped chapters instead of falsely completing the whole guide', () => {
    const steps = guideStepsForRole('recruiter');
    const progress = {
      current: 'operations',
      completed: steps
        .filter((step) => !['rules', 'operations'].includes(step.id))
        .map((step) => step.id),
      mode: 'reading' as const,
    };
    const next = updateGuideProgress(
      progress,
      { type: 'complete', id: 'operations' },
      'recruiter',
    );
    expect(next.current).toBe('rules');
    expect(next.completed).toHaveLength(steps.length - 1);
    expect(
      updateGuideProgress(next, { type: 'complete', id: 'rules' }, 'recruiter')
        .completed,
    ).toHaveLength(steps.length);
  });
  it('ignores inaccessible step actions and can restart from zero', () => {
    const initial = {
      current: 'review',
      completed: ['overview'],
      mode: 'paused' as const,
    };
    expect(
      updateGuideProgress(
        initial,
        { type: 'practice', id: 'team' },
        'recruiter',
      ),
    ).toEqual(initial);
    expect(
      updateGuideProgress(initial, { type: 'reset' }, 'recruiter'),
    ).toEqual(readGuideProgress(null, 'recruiter'));
  });
  it('starts page instructions from an explicit guide link even without stored progress', () => {
    expect(
      guideActionFromUrl(
        new URL('https://example.test/candidates?guide=review'),
        'recruiter',
      ),
    ).toEqual({ type: 'practice', id: 'review' });
    expect(
      guideActionFromUrl(
        new URL('https://example.test/guide?guide=review'),
        'recruiter',
      ),
    ).toEqual({ type: 'select', id: 'review' });
    expect(
      guideActionFromUrl(
        new URL('https://example.test/analytics?guide=operations'),
        'recruiter',
      ),
    ).toEqual({ type: 'practice', id: 'operations' });
  });
  it('ignores guide hints on unrelated or inaccessible pages', () => {
    for (const path of [
      '/contacts?guide=review',
      '/team?guide=team',
      '/guide?guide=unknown',
    ]) {
      expect(
        guideActionFromUrl(new URL(`https://example.test${path}`), 'recruiter'),
      ).toBeNull();
    }
  });
  it('preserves other page context when adding the guide launch hint', () => {
    expect(
      guidePracticeHref('/candidates?task=abc&position=def#detail', 'review'),
    ).toBe('/candidates?task=abc&position=def&guide=review#detail');
  });
});

describe('role-aware onboarding destinations', () => {
  it.each<DepartmentRole>([
    'admin',
    'recruiting_lead',
    'recruiter',
    'interviewer',
  ])('only links to existing pages available to %s', (role) => {
    const accessible = navigationForRole(role).flatMap((item) => [
      item.href,
      ...(item.relatedHrefs ?? []),
    ]);
    // Related manager-only pages share the parent module; validate their explicit restrictions too.
    const managerOnly = ['/boss-login', '/team', '/audit', '/automation'];
    const steps = guideStepsForRole(role);
    expect(new Set(steps.map((step) => step.id)).size).toBe(steps.length);
    for (const step of steps) {
      expect(step.steps).toHaveLength(3);
      for (const link of [step.target, ...(step.related ?? [])]) {
        expect(accessible).toContain(link.href);
        expect(
          existsSync(resolve('apps/web/app', `.${link.href}`, 'page.tsx')),
        ).toBe(true);
        if (role === 'recruiter' || role === 'interviewer')
          expect(managerOnly).not.toContain(link.href);
      }
    }
  });
  it('gives a recruiter the complete daily HR workflow with manager handoff for login', () => {
    expect(guideStepsForRole('recruiter').map((step) => step.id)).toEqual([
      'overview',
      'preparation',
      'positions',
      'rules',
      'tasks',
      'review',
      'contact',
      'pipeline',
      'operations',
    ]);
    expect(
      guideStepsForRole('recruiter').find((step) => step.id === 'preparation')
        ?.target.href,
    ).toBe('/operations');
  });
});
