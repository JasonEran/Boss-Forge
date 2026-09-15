import { describe, expect, it } from 'vitest';
import {
  canRetryResumeScreening,
  describeResumeScreeningFailure,
} from './resume-screening-error';

describe('resume screening failure copy', () => {
  it('turns stable error codes into an actionable HR explanation', () => {
    expect(describeResumeScreeningFailure('risk_control')).toMatchObject({
      retryable: false,
      title: 'BOSS 风控已触发',
    });
    expect(describeResumeScreeningFailure('ocr_failed')?.guidance).toContain(
      '人工查看',
    );
  });
  it('allows explicit recovery now that every attempt restores the original task context', () => {
    expect(
      describeResumeScreeningFailure('BOSS_TARGET_MISSING：刷新后未找到候选人'),
    ).toMatchObject({ retryable: true, title: '暂未定位到原候选人' });
  });

  it('does not invite retry when a card changed or a name is ambiguous', () => {
    expect(describeResumeScreeningFailure('target_changed')).toMatchObject({
      retryable: false,
      title: '候选人卡片信息已变化',
    });
    expect(describeResumeScreeningFailure('target_ambiguous')).toMatchObject({
      retryable: false,
      title: '当前列表存在同名候选人',
    });
    expect(
      describeResumeScreeningFailure('BOSS_TARGET_CHANGED：定位信息不再一致'),
    ).toMatchObject({ retryable: false, title: '候选人卡片信息已变化' });
  });

  it('keeps task and candidate retry controls closed for non-retryable failures', () => {
    expect(canRetryResumeScreening('failed', 'risk_control')).toBe(false);
    expect(
      canRetryResumeScreening('failed', 'BOSS_SOURCE_EXPIRED：卡片已过期'),
    ).toBe(true);
    expect(canRetryResumeScreening('failed', 'target_changed')).toBe(false);
    expect(canRetryResumeScreening('failed', 'target_ambiguous')).toBe(false);
    expect(canRetryResumeScreening('failed', 'ocr_failed')).toBe(true);
    expect(canRetryResumeScreening('no_text', 'content_empty')).toBe(true);
  });

  it('turns the legacy duplicate-card failure into a recoverable action', () => {
    expect(
      describeResumeScreeningFailure(
        'Candidate target is missing or ambiguous after refreshing the BOSS result list; operation was blocked.',
      ),
    ).toMatchObject({ retryable: true, title: '旧版候选人定位失败' });
  });

  it('explains an iframe failure without exposing implementation-only wording', () => {
    expect(
      describeResumeScreeningFailure(
        '点击后未出现在线简历 iframe（c-resume）。',
      ),
    ).toMatchObject({ retryable: true, title: 'BOSS 未打开完整简历' });
  });

  it('turns a blank resume capture into a clear retryable failure', () => {
    expect(
      describeResumeScreeningFailure(
        'BOSS_RESUME_CONTENT_EMPTY：简历截图中没有可识别正文。',
      ),
    ).toMatchObject({
      retryable: true,
      title: '完整简历内容没有加载出来',
    });
  });
});
