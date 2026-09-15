import { describe, expect, it } from 'vitest';

import { resolveControlApiUrl, userFacingRequestError } from './api-client';

describe('control API browser routing', () => {
  it('uses the production page origin when an image was accidentally built with loopback', () => {
    expect(
      resolveControlApiUrl('http://127.0.0.1:3100', 'https://106.12.106.113'),
    ).toBe('https://106.12.106.113');
    expect(
      resolveControlApiUrl('http://localhost:3100/', 'https://hr.internal/'),
    ).toBe('https://hr.internal');
  });

  it('keeps the separate loopback API during local development', () => {
    expect(
      resolveControlApiUrl('http://127.0.0.1:3100', 'http://localhost:3000'),
    ).toBe('http://127.0.0.1:3100');
  });

  it.each([
    'http://127.0.0.0:3100',
    'http://127.23.45.67:3100',
    'http://0.0.0.0:3100',
    'http://[::1]:3100',
  ])(
    'falls back to the remote page origin for loopback or wildcard API %s',
    (configuredUrl) => {
      expect(
        resolveControlApiUrl(configuredUrl, 'https://hr.example.internal/'),
      ).toBe('https://hr.example.internal');
    },
  );

  it('uses same-origin routing for a remote browser when no public API URL was built in', () => {
    expect(resolveControlApiUrl(undefined, 'https://hr.example.internal/')).toBe(
      'https://hr.example.internal',
    );
  });

  it('does not depend on window during SSR evaluation', () => {
    expect(resolveControlApiUrl('http://127.0.0.1:3100/', undefined)).toBe(
      'http://127.0.0.1:3100',
    );
    expect(resolveControlApiUrl(undefined, undefined)).toBe(
      'http://127.0.0.1:3100',
    );
  });

  it('preserves an explicitly configured non-loopback API', () => {
    expect(
      resolveControlApiUrl('https://api.hr.internal/', 'https://hr.internal'),
    ).toBe('https://api.hr.internal');
  });

  it('explains network failures in actionable HR language', () => {
    expect(userFacingRequestError(new TypeError('Load failed'))).toContain(
      '检查网关和 API 状态',
    );
    expect(userFacingRequestError(new TypeError('Failed to fetch'))).toContain(
      '请刷新页面后重试',
    );
  });

  it('preserves actionable API errors and supplies a fallback for empty failures', () => {
    expect(userFacingRequestError(new Error('当前账号无权查看该岗位。'))).toBe(
      '当前账号无权查看该岗位。',
    );
    expect(userFacingRequestError(null, '登录失败，请稍后重试。')).toBe(
      '登录失败，请稍后重试。',
    );
  });
});
