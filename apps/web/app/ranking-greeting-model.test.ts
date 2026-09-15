import { describe, expect, it } from 'vitest';
import type { Candidate } from './dashboard-client';
import {
  assertRankingGreetingPreview,
  greetingBatches,
  rankingGreetingBlockReason,
  type RankingGreetingPreview,
} from './ranking-greeting-model';

const candidate = {
  stateId: 'one',
  ruleDecision: 'matched',
  resumeScreeningStatus: 'screened',
  reviewStatus: 'pending',
} as Candidate;
const preview = (id: string): RankingGreetingPreview => ({
  preview: {
    candidateStateId: id,
    candidateName: id,
    positionId: 'position',
    taskId: 'task',
    actionKind: 'greet',
    renderedMessage: '你好，想交流岗位。',
  },
  readiness: { ready: true, checks: [] },
  approval: null,
});
const expected = {
  stateIds: ['one', 'two'],
  positionId: 'position',
  taskId: 'task',
  body: '你好，想交流岗位。',
};

describe('ranking greeting recipient scope', () => {
  it('allows matched pending candidates for explicit HR confirmation and respects independent message records', () => {
    expect(rankingGreetingBlockReason(candidate, [])).toBeNull();
    expect(
      rankingGreetingBlockReason(candidate, [
        { candidateStateId: 'one', actionKind: 'message', status: 'sent' },
      ]),
    ).toBeNull();
  });
  it.each(['ready', 'processing', 'sent', 'uncertain', 'simulated'])(
    'skips an existing %s greeting',
    (status) => {
      expect(
        rankingGreetingBlockReason(candidate, [
          { candidateStateId: 'one', actionKind: 'greet', status },
        ]),
      ).toMatch(/跳过/);
    },
  );
  it('keeps rejected, incomplete and low-score candidates on the separate review path', () => {
    expect(
      rankingGreetingBlockReason(
        { ...candidate, reviewStatus: 'rejected' },
        [],
      ),
    ).toMatch(/复核/);
    expect(
      rankingGreetingBlockReason(
        { ...candidate, resumeScreeningStatus: 'processing' },
        [],
      ),
    ).not.toBeNull();
    const low = {
      status: 'completed',
      result: { recommendation: 'below_threshold', score: 50 },
    } as Candidate['assessment'];
    expect(
      rankingGreetingBlockReason({ ...candidate, assessment: low }, []),
    ).toMatch(/低分/);
    expect(
      rankingGreetingBlockReason(
        { ...candidate, assessment: low, reviewStatus: 'approved' },
        [],
      ),
    ).toBeNull();
    expect(
      rankingGreetingBlockReason(
        {
          ...candidate,
          assessment: { status: 'failed' } as Candidate['assessment'],
        },
        [],
      ),
    ).toMatch(/未完成/);
  });
  it('preserves every ranked recipient across pages with batches of at most 20', () => {
    const ids = Array.from({ length: 49 }, (_, index) => `candidate-${index}`);
    const chunks = greetingBatches(ids);
    expect(chunks.map((batch) => batch.length)).toEqual([20, 20, 9]);
    expect(chunks.flat()).toEqual(ids);
    expect(greetingBatches([])).toEqual([]);
  });
  it('accepts only the exact unique recipients, task, position, greeting action and reference message', () => {
    expect(() =>
      assertRankingGreetingPreview([preview('one'), preview('two')], expected),
    ).not.toThrow();
    for (const patch of [
      { candidateStateId: 'one' },
      { taskId: 'another' },
      { positionId: 'another' },
      { actionKind: 'message' },
      { renderedMessage: 'changed' },
    ]) {
      const changed = preview('two');
      Object.assign(changed.preview, patch);
      expect(() =>
        assertRankingGreetingPreview([preview('one'), changed], expected),
      ).toThrow();
    }
    expect(() =>
      assertRankingGreetingPreview([preview('one')], expected),
    ).toThrow();
  });
});
