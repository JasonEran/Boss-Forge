import { describe, expect, it } from 'vitest';

import {
  semanticDisplayStatus,
  semanticProviderDisplayStatus,
} from './semantic-status';

describe('semantic display status', () => {
  it('shows shadow results as a plain-language trial with counts', () => {
    expect(
      semanticDisplayStatus({
        resumeScreeningStatus: 'screened',
        semanticSummary: {
          mode: 'shadow',
          total: 3,
          matched: 1,
          notMatched: 1,
          unknown: 1,
          modelError: false,
        },
      }),
    ).toEqual({
      label: '试运行 · 3 项',
      detail: '符合 1 · 不符合 1 · 待确认 1',
      emphasized: false,
    });
  });

  it('does not imply that semantic recognition ran after resume extraction failed', () => {
    expect(
      semanticDisplayStatus({
        resumeScreeningStatus: 'failed',
        semanticSummary: {
          mode: null,
          total: 0,
          matched: 0,
          notMatched: 0,
          unknown: 0,
          modelError: false,
        },
      }),
    ).toMatchObject({ label: '未运行', detail: '简历读取失败' });
  });

  it('does not present off-mode explanation records as a shadow trial', () => {
    expect(
      semanticDisplayStatus({
        resumeScreeningStatus: 'screened',
        semanticSummary: {
          mode: 'off',
          total: 2,
          matched: 1,
          notMatched: 1,
          unknown: 0,
          modelError: false,
        },
      }),
    ).toEqual({
      label: '未启用 · 2 项解释记录',
      detail: '仅供查看，不影响筛选 · 符合 1 · 不符合 1',
      emphasized: false,
    });
  });

  it('makes active model errors visible', () => {
    expect(
      semanticDisplayStatus({
        resumeScreeningStatus: 'screened',
        semanticSummary: {
          mode: 'active',
          total: 1,
          matched: 0,
          notMatched: 0,
          unknown: 1,
          modelError: true,
        },
      }),
    ).toMatchObject({
      label: '已生效 · 有异常',
      detail: '模型未完成，筛选结论未受影响 · 待确认 1',
    });
  });

  it('explains a missing credential without exposing endpoint paths or secrets', () => {
    expect(
      semanticProviderDisplayStatus({
        enabled: true,
        ready: false,
        reason: 'missing_credential',
        endpointHost: 'model.example.internal',
        model: 'review-model',
        credentialConfigured: false,
        timeoutMs: 45_000,
      }),
    ).toEqual({
      label: '模型连接未就绪',
      detail: '尚未配置新的模型密钥，系统不会发出模型请求。',
      ready: false,
    });
  });

  it('does not claim network connectivity from configuration checks alone', () => {
    expect(
      semanticProviderDisplayStatus({
        enabled: true,
        ready: true,
        reason: 'ready',
        endpointHost: 'model.example.internal',
        model: 'review-model',
        credentialConfigured: true,
        timeoutMs: 45_000,
      }),
    ).toMatchObject({
      label: '模型配置完整',
      detail:
        'model.example.internal · review-model；连通性会在试运行时验证，结果不改变筛选结论。',
      ready: true,
    });
  });
});
