import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  confirmWechatScript,
  wechatCapabilityScript,
  wechatReceiptScript,
} from './boss-wechat.js';
function fixture(
  options: {
    label?: string;
    disabled?: boolean;
    duplicate?: boolean;
    target?: string;
    notice?: string;
    dialog?: string;
    messages?: unknown[];
  } = {},
) {
  let clicked = 0;
  const rect = () => ({ width: 100, height: 40 });
  const button = {
    textContent: options.label ?? '换微信',
    className: options.disabled ? 'operate-btn disabled' : 'operate-btn',
    getBoundingClientRect: rect,
    hasAttribute: () => false,
    getAttribute: () => null,
    click: () => {
      clicked++;
    },
  };
  const host = {
    className: 'operate-icon-item',
    getBoundingClientRect: rect,
    querySelector: () => button,
  };
  const chat = {
    getBoundingClientRect: rect,
    __vue__: {
      conversation$: {
        encryptUid: options.target ?? 'candidate-wechat-test',
        uniqueId: 'native-thread',
      },
      list$: options.messages ?? [],
    },
  };
  const confirm = { ...button, textContent: '确定' };
  const tooltip = {
    getBoundingClientRect: rect,
    textContent: options.dialog ?? '交换微信',
    querySelectorAll: () => [confirm],
  };
  const context = {
    getComputedStyle: () => ({ visibility: 'visible' }),
    document: {
      querySelectorAll: (selector: string) =>
        selector === '.operate-icon-item'
          ? options.duplicate
            ? [host, host]
            : [host]
          : selector === '.conversation-message'
            ? [chat]
            : selector === '.exchange-tooltip'
              ? [tooltip]
              : options.notice
                ? [{ getBoundingClientRect: rect, textContent: options.notice }]
                : [],
    },
  };
  return { context, clicks: () => clicked };
}
describe('native WeChat exchange control', () => {
  it('mirrors disabled, available, pending and exchanged states without clicking during reads', () => {
    const unavailable = fixture({
      label: '换微信 交换微信：双方回复后可用',
      disabled: true,
    });
    expect(
      runInNewContext(wechatCapabilityScript(), unavailable.context),
    ).toMatchObject({
      state: 'unavailable',
      reason: expect.stringContaining('双方回复'),
    });
    for (const [label, state] of [
      ['换微信', 'available'],
      ['换微信 已申请 等待对方', 'pending'],
      ['查看微信', 'exchanged'],
    ] as const) {
      const f = fixture({ label });
      expect(runInNewContext(wechatCapabilityScript(), f.context).state).toBe(
        state,
      );
      expect(f.clicks()).toBe(0);
    }
  });
  it('requires one native control and rechecks the exact target before confirming', () => {
    const ambiguous = fixture({ duplicate: true });
    expect(
      runInNewContext(wechatCapabilityScript(true), ambiguous.context).state,
    ).toBe('unavailable');
    expect(ambiguous.clicks()).toBe(0);
    const other = fixture({ target: 'different-candidate' });
    expect(() =>
      runInNewContext(
        confirmWechatScript('candidate-wechat-test'),
        other.context,
      ),
    ).toThrow('CHAT_TARGET_MISMATCH');
    expect(other.clicks()).toBe(0);
    const same = fixture();
    expect(
      runInNewContext(
        confirmWechatScript('candidate-wechat-test'),
        same.context,
      ),
    ).toBe(true);
    expect(same.clicks()).toBe(1);
  });
  it('never treats a button click, stale notice or inbound text as a successful request', () => {
    const read = (f: ReturnType<typeof fixture>, oldNotices: string[] = []) =>
      runInNewContext(
        wechatReceiptScript('candidate-wechat-test', [], oldNotices),
        f.context,
      );
    expect(read(fixture())).toBe(false);
    expect(read(fixture({ notice: '请求已发送' }), ['请求已发送'])).toBe(false);
    expect(
      read(
        fixture({
          messages: [
            {
              mid: 'inbound',
              received: true,
              isSelf: false,
              status: 1,
              type: 'text',
              text: '交换微信请求已发送',
            },
          ],
        }),
      ),
    ).toBe(false);
    expect(read(fixture({ notice: '请求已发送' }))).toMatchObject({
      geekId: 'candidate-wechat-test',
      evidence: 'native_notice',
    });
    expect(read(fixture({ label: '换微信 已申请' }))).toMatchObject({
      evidence: 'native_pending',
    });
  });
  it('accepts a newly acknowledged native exchange card only for the selected conversation', () => {
    const f = fixture({
      messages: [
        {
          mid: 'request-card',
          received: true,
          isSelf: true,
          status: 1,
          type: 'dialog',
          text: '请求交换微信',
        },
      ],
    });
    expect(
      runInNewContext(
        wechatReceiptScript('candidate-wechat-test', [], []),
        f.context,
      ),
    ).toMatchObject({ evidence: 'native_card' });
    expect(
      runInNewContext(
        wechatReceiptScript('candidate-wechat-test', ['request-card'], []),
        f.context,
      ),
    ).toBe(false);
  });
});

describe('native resume request control', () => {
  it('only opens the resume control and its matching confirmation dialog', () => {
    const f = fixture({ label: '求简历', dialog: '索取简历' });
    expect(
      runInNewContext(wechatCapabilityScript(false, 'resume'), f.context).state,
    ).toBe('available');
    expect(f.clicks()).toBe(0);
    expect(
      runInNewContext(wechatCapabilityScript(true, 'resume'), f.context).state,
    ).toBe('available');
    expect(
      runInNewContext(
        confirmWechatScript('candidate-wechat-test', 'resume'),
        f.context,
      ),
    ).toBe(true);
    expect(f.clicks()).toBe(2);
    const wrong = fixture({ label: '换微信', dialog: '交换微信' });
    expect(
      runInNewContext(wechatCapabilityScript(true, 'resume'), wrong.context)
        .state,
    ).toBe('unavailable');
    expect(
      runInNewContext(
        confirmWechatScript('candidate-wechat-test', 'resume'),
        wrong.context,
      ),
    ).toBe(false);
    expect(wrong.clicks()).toBe(0);
  });
  it('requires a native acknowledgment specific to the resume request', () => {
    const f = fixture({ label: '求简历', dialog: '索取简历' });
    expect(
      runInNewContext(
        wechatReceiptScript('candidate-wechat-test', [], [], 'resume'),
        f.context,
      ),
    ).toBe(false);
    const ack = fixture({ label: '求简历 已申请', dialog: '索取简历' });
    expect(
      runInNewContext(
        wechatReceiptScript('candidate-wechat-test', [], [], 'resume'),
        ack.context,
      ),
    ).toMatchObject({ evidence: 'native_pending' });
    const wrong = fixture({ label: '求简历', notice: '微信交换请求已发送' });
    expect(
      runInNewContext(
        wechatReceiptScript('candidate-wechat-test', [], [], 'resume'),
        wrong.context,
      ),
    ).toBe(false);
  });
});
