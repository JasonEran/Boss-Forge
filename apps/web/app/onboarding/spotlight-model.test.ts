import { describe, expect, it } from 'vitest';
import {
  navigationForRole,
  type DepartmentRole,
} from '../workspace-navigation';
import {
  readSpotlightProgress,
  spotlightFromUrl,
  spotlightHref,
  spotlightPlacement,
  spotlightSteps,
} from './spotlight-model';

describe('spotlight tour navigation', () => {
  it.each<DepartmentRole>([
    'admin',
    'recruiting_lead',
    'recruiter',
    'interviewer',
  ])('keeps the complete %s tour on accessible pages', (role) => {
    const pages = navigationForRole(role).flatMap((item) => [
      item.href,
      ...(item.relatedHrefs ?? []),
    ]);
    const steps = spotlightSteps(role);
    expect(new Set(steps.map((step) => step.id)).size).toBe(steps.length);
    expect(steps[0]?.id).toBe('welcome');
    expect(steps.at(-1)?.id).toBe('finish');
    for (const step of steps) {
      if (step.page) expect(pages).toContain(step.page);
      if (role === 'recruiter' || role === 'interviewer')
        expect(['/boss-login', '/team', '/audit', '/automation']).not.toContain(
          step.page,
        );
    }
  });
  it('resumes a paused step and preserves completion after reload', () => {
    expect(
      readSpotlightProgress(
        JSON.stringify({ stepId: 'rules', active: false, finished: false }),
        'recruiter',
      ),
    ).toEqual({ stepId: 'rules', active: false, finished: false });
    expect(
      readSpotlightProgress(
        JSON.stringify({ stepId: 'finish', active: false, finished: true }),
        'recruiter',
      ).finished,
    ).toBe(true);
  });
  it('resets corrupt or no longer accessible progress without auto-starting', () => {
    for (const raw of [
      'broken',
      'null',
      '[]',
      JSON.stringify({ stepId: 'team', active: true }),
    ])
      expect(readSpotlightProgress(raw, 'recruiter')).toEqual({
        stepId: 'welcome',
        active: false,
        finished: false,
      });
  });
  it('continues a cross-page step from its URL, including without local storage', () => {
    const next = spotlightSteps('recruiter').find(
      (step) => step.id === 'task',
    )!;
    const href = spotlightHref(
      next,
      'https://example.test/positions?guide=rules',
    );
    expect(href).toBe('/tasks?tour=task');
    expect(
      spotlightFromUrl(new URL(href, 'https://example.test'), 'recruiter')?.id,
    ).toBe('task');
  });
  it('preserves the current task when another step stays on the same page', () => {
    const step = spotlightSteps('recruiter').find(
      (item) => item.id === 'review',
    )!;
    expect(
      spotlightHref(step, 'https://example.test/candidates?position=a&task=b'),
    ).toBe('/candidates?position=a&task=b&tour=review');
  });
  it('ignores incorrect and inaccessible launch hints', () => {
    for (const path of [
      '/team?tour=team',
      '/tasks?tour=rules',
      '/?tour=missing',
    ])
      expect(
        spotlightFromUrl(new URL(path, 'https://example.test'), 'recruiter'),
      ).toBeNull();
  });
});

describe('spotlight popup placement', () => {
  it('places the callout beside a desktop sidebar target', () => {
    const placement = spotlightPlacement(
      { left: 12, top: 180, width: 192, height: 48 },
      { width: 1280, height: 800 },
      330,
    );
    expect(placement.side).toBe('right');
    expect(placement.left).toBeGreaterThan(204);
  });
  it('flips above a low target when below cannot fit', () => {
    const placement = spotlightPlacement(
      { left: 16, top: 540, width: 358, height: 48 },
      { width: 390, height: 700 },
      330,
    );
    expect(placement.side).toBe('top');
    expect(placement.top + 330).toBeLessThan(540);
  });
  it('keeps narrow and short viewport callouts inside the viewport, including missing targets', () => {
    for (const width of [320, 390, 768, 1366])
      for (const height of [360, 600, 900])
        for (const target of [
          null,
          { left: 12, top: 80, width: width - 24, height: 70 },
          { left: width - 80, top: height - 64, width: 60, height: 44 },
        ]) {
          const placement = spotlightPlacement(target, { width, height }, 410);
          expect(placement.left).toBeGreaterThanOrEqual(12);
          expect(placement.top).toBeGreaterThanOrEqual(12);
          expect(placement.left + placement.width).toBeLessThanOrEqual(
            width - 12,
          );
          expect(
            placement.top + Math.min(410, placement.maxHeight),
          ).toBeLessThanOrEqual(height - 12);
        }
  });
});
