import { describe, expect, it } from 'vitest';

import {
  candidateRuleEvidenceLabel,
  candidateRuleEvidenceRecognitionLabel,
  candidateRuleEvidenceSourceText,
  contactRuntimePresentation,
  contactBlockReasonLabel,
  hrStatusLabel,
  safeIdentifierLabel,
  taskNextAction,
  waitingReasonLabel,
} from './hr-display';

describe('HR-facing status copy', () => {
  it('explains obsolete BOSS selections before generic backend retry guidance', () => {
    expect(
      taskNextAction({
        status: 'failed',
        nextAction: '请查看失败原因并重试任务',
        errorMessage:
          'BOSS_FILTER_UNAVAILABLE：当前岗位无法使用「院校 · 国内外名校」',
      }),
    ).toBe(
      'BOSS 当前不支持「院校 · 国内外名校」。请在岗位规则中获取最新 BOSS VIP 筛选并调整，再创建新任务；旧任务保留原规则，直接重试仍会失败。',
    );
  });
  it('fails closed while runtime mode is unknown or contradictory', () => {
    expect(contactRuntimePresentation({ loaded: false }).state).toBe('loading');
    expect(
      contactRuntimePresentation({
        loaded: true,
        realGreetingEnabled: true,
        contactDispatchMode: 'fake',
        sideEffectsMode: 'fake_only',
      }),
    ).toMatchObject({ state: 'blocked', allowsRealContact: false });
    expect(
      contactRuntimePresentation({
        loaded: true,
        realGreetingEnabled: true,
        contactDispatchMode: 'real',
        sideEffectsMode: 'real_greet_enabled',
      }),
    ).toMatchObject({ state: 'real', allowsRealContact: true });
  });

  it('distinguishes preview-only from an explicitly running fake worker', () => {
    expect(
      contactRuntimePresentation({
        loaded: true,
        realGreetingEnabled: false,
        contactDispatchMode: 'disabled',
        sideEffectsMode: 'preview_only',
      }),
    ).toMatchObject({
      state: 'preview',
      label: '仅预览，发送未启动',
      allowsRealContact: false,
    });
    expect(
      contactRuntimePresentation({
        loaded: true,
        realGreetingEnabled: false,
        contactDispatchMode: 'fake',
        sideEffectsMode: 'fake_only',
      }),
    ).toMatchObject({ state: 'fake', allowsRealContact: false });
  });

  it('never leaks UUIDs or raw workflow enums as the primary label', () => {
    expect(hrStatusLabel('not_required')).toBe('规则未通过，可人工改判');
    expect(safeIdentifierLabel('86ad00d0-0000-4000-8000-000000000000')).toBe(
      '系统内部对象',
    );
  });

  it('explains that a legacy gender condition no longer participates in automatic screening', () => {
    expect(
      candidateRuleEvidenceLabel({
        capabilityId: 'enum.gender',
        canonicalLabel: '枚举（gender）',
        normalizedAlias: '女',
      }),
    ).toBe('性别（不参与自动筛选）');
    expect(
      candidateRuleEvidenceLabel({
        capabilityId: 'enum.gender',
        canonicalLabel: '枚举（gender）',
        normalizedAlias: 'missing_field',
      }),
    ).toBe('性别（不参与自动筛选）');
  });

  it('preserves a human-readable label for other screening criteria', () => {
    expect(
      candidateRuleEvidenceLabel({
        capabilityId: 'language.english.credentials',
        canonicalLabel: '英语证书：CET6 或 TEM8',
        normalizedAlias: 'CET6',
      }),
    ).toBe('英语证书：CET6 或 TEM8');
  });

  it.each([
    ['gender', '未识别到性别信息'],
    ['age', '未识别到年龄信息'],
    ['graduationYear', '未识别到毕业年份信息'],
    ['educationLevel', '未识别到学历信息'],
    ['yearsOfExperience', '未识别到工作经验信息'],
    ['skills', '未识别到技能信息'],
    ['location', '未识别到所在地或期望地点信息'],
    ['status', '未识别到求职状态信息'],
    ['bossPlatformTags', '未识别到 BOSS 院校标签'],
  ])('translates a missing %s profile field', (field, expected) => {
    expect(
      candidateRuleEvidenceSourceText({
        sourceText: `未找到字段：${field}`,
      }),
    ).toBe(expected);
  });

  it('does not expose unknown internal field names in missing-field evidence', () => {
    expect(
      candidateRuleEvidenceSourceText({
        sourceText: '未找到字段：internal_score_v2',
      }),
    ).toBe('未识别到该筛选条件所需的信息');
    expect(candidateRuleEvidenceRecognitionLabel('missing_field')).toBe(
      '未识别到可用信息',
    );
  });

  it('preserves real evidence text and recognized business values', () => {
    expect(candidateRuleEvidenceSourceText({ sourceText: '性别：女' })).toBe(
      '性别：女',
    );
    expect(candidateRuleEvidenceRecognitionLabel('女')).toBe('女');
  });

  it('does not promise that a finished greet target will resume', () => {
    expect(
      taskNextAction({
        status: 'waiting_review',
        waitingReason: 'greet_target_met',
      }),
    ).toBe('已达到设定的成功打招呼人数');
    expect(
      taskNextAction({
        status: 'waiting_review',
        waitingReason: 'screening_pass_target_met',
      }),
    ).toBe('已达到设定的筛通过人数，已停止继续筛选');
    expect(
      taskNextAction({
        status: 'waiting_review',
        waitingReason: '这次筛选在打招呼人数规则上线前已经结束，不会重新开始。',
      }),
    ).toBe('这次筛选在打招呼人数规则上线前已经结束，不会重新开始。');
  });
  it('tells HR why a queued task is waiting and what happens next', () => {
    expect(
      taskNextAction({
        status: 'queued',
        waitingReason: 'outside_working_hours',
      }),
    ).toContain('条件恢复后自动继续');
  });

  it('translates every persisted resume wait reason into a specific HR message', () => {
    expect(waitingReasonLabel('outside_working_hours')).toContain('允许查看');
    expect(waitingReasonLabel('daily_hard_limit_reached')).toContain(
      '安全上限',
    );
    expect(waitingReasonLabel('daily_quota_reached')).toContain('软额度');
    expect(waitingReasonLabel('hourly_quota_reached')).toContain('一小时');
    expect(waitingReasonLabel('batch_break')).toContain('安全节奏休息');
    expect(waitingReasonLabel('resume_retry_scheduled')).toContain('自动重试');
  });

  it('translates contact safety blocks without exposing internal enums', () => {
    expect(contactBlockReasonLabel('position approval missing')).toBe(
      '当前岗位：仍使用旧审批配置，请由负责人重新开启联系开关',
    );
    expect(contactBlockReasonLabel('current_candidate_state')).toContain(
      '历史任务',
    );
    expect(contactBlockReasonLabel('contact_dispatch_disabled')).toContain(
      '只能预览',
    );
  });
});
