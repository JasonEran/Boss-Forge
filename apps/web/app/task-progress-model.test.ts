import { describe, expect, it } from 'vitest';
import { taskProgress } from './task-progress-model';
const task = { id: 'one', status: 'screening', candidateCount: 5 };
const candidates = [
  'screened',
  'failed',
  'processing',
  'queued',
  'not_requested',
].map((status) => ({ taskId: 'one', resumeScreeningStatus: status }));
describe('real background work progress', () => {
  it('distinguishes processed, successful, failed, queued and in-progress resumes', () => {
    expect(taskProgress(task, candidates)).toMatchObject({
      total: 5,
      processed: 2,
      success: 1,
      errors: 1,
      processing: 1,
      queued: 1,
      remaining: 1,
      percent: 40,
      active: true,
    });
  });
  it('uses indeterminate progress until collection provides a denominator', () => {
    expect(
      taskProgress({ ...task, candidateCount: 0, status: 'running' }, []),
    ).toMatchObject({ percent: null, active: true, label: '正在采集候选人' });
  });
  it('finishes an empty collection without showing unknown counts or an ongoing spinner', () => {
    expect(
      taskProgress({ ...task, candidateCount: 0, status: 'completed' }, []),
    ).toMatchObject({
      total: 0,
      percent: 100,
      active: false,
      emptyCompleted: true,
      label: '采集已完成 · 0 位候选人',
    });
    expect(
      taskProgress({ ...task, candidateCount: 0, status: 'failed' }, []),
    ).toMatchObject({
      percent: null,
      emptyCompleted: false,
    });
  });
  it('does not call a cancelled task active even when old queue state remains', () => {
    expect(
      taskProgress({ ...task, status: 'cancelled' }, candidates),
    ).toMatchObject({ active: false, label: '任务已取消', percent: 40 });
  });
  it('does not mistake waiting for HR review for background processing', () => {
    const processed = candidates.map((item) => ({
      ...item,
      resumeScreeningStatus: 'screened',
    }));
    expect(
      taskProgress({ ...task, status: 'waiting_review' }, processed),
    ).toMatchObject({ active: false, percent: 100, label: '等待人工审核' });
  });
  it('keeps failures visible even when every resume has been processed', () => {
    const failed = candidates.map((item) => ({
      ...item,
      resumeScreeningStatus: 'failed',
    }));
    expect(
      taskProgress({ ...task, status: 'waiting_review' }, failed),
    ).toMatchObject({ percent: 100, errors: 5, success: 0 });
  });
  it('counts only this task and never exceeds 100% while counts are catching up', () => {
    expect(
      taskProgress({ ...task, candidateCount: 1 }, [
        ...candidates,
        { taskId: 'other', resumeScreeningStatus: 'screened' },
      ]),
    ).toMatchObject({ total: 5, percent: 40 });
  });
  it('shows the actual next queued attempt time instead of a made-up duration', () => {
    const p = taskProgress(task, [
      {
        ...candidates[3]!,
        resumeScreeningNextAttemptAt: '2026-09-05T10:00:00Z',
      },
    ]);
    expect(p.retryAt).toBe('2026-09-05T10:00:00Z');
  });
});
