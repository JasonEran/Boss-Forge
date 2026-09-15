import { runInNewContext } from 'node:vm';
import { describe, it, expect } from 'vitest';
import { chatAssetsScript } from './boss-chat-assets.js';
import {
  bossChatAssetSchema,
  bossChatSnapshotSchema,
} from '@boss-forge/contracts';
function read({
  kind = 'card',
  self = false,
  body = '微信号：test_wx_01\n手机号：13800000000',
  bound = 'message-1',
  duplicate = false,
  url = 'https://static.zhipin.com/resume.pdf',
} = {}) {
  const anchor = {
    href: url,
    textContent: '简历.pdf',
    className: 'resume-attachment',
    getAttribute: () => null,
    hasAttribute: () => false,
  };
  const image = {
    src: url,
    currentSrc: url,
    className: 'chat-image',
    getAttribute: () => null,
  };
  const root = {
    getAttribute: (key: string) => (key === 'data-mid' ? bound : null),
    innerText: body,
    querySelectorAll: (query: string) => (query === 'img' ? [image] : [anchor]),
  };
  return runInNewContext(chatAssetsScript(), {
    URL,
    location: { href: 'https://www.zhipin.com/web/chat' },
    m: { mid: 'message-1' },
    hosts: [{ querySelectorAll: () => (duplicate ? [root, root] : [root]) }],
    kind,
    self,
    providerMessageId: 'message-1',
  });
}
describe('native chat assets and contact cards', () => {
  it('requires a unique exact message binding and rejects arbitrary remote URLs', () => {
    expect(read({ bound: 'someone-else' })).toEqual({
      assets: [],
      contacts: [],
    });
    expect(read({ duplicate: true })).toEqual({ assets: [], contacts: [] });
    for (const url of [
      'http://127.0.0.1/admin',
      'https://zhipin.com.evil.test/cv.pdf',
      'https://x@static.zhipin.com/cv.pdf',
      'https://static.zhipin.com:8000/cv.pdf',
      'data:text/html,hello',
    ])
      expect(read({ url }).assets).toEqual([]);
    expect(read().assets).toEqual([
      {
        kind: 'file',
        name: '简历.pdf',
        url: 'https://static.zhipin.com/resume.pdf',
      },
    ]);
  });
  it('extracts explicit inbound cards, never contact-like free text or outbound cards', () => {
    expect(read().contacts).toEqual([
      { kind: 'wechat', value: 'test_wx_01', providerMessageId: 'message-1' },
      { kind: 'phone', value: '13800000000', providerMessageId: 'message-1' },
    ]);
    expect(read({ kind: 'text' }).contacts).toEqual([]);
    expect(read({ self: true }).contacts).toEqual([]);
    expect(read({ body: '我可以给你手机号 138****0000' }).contacts).toEqual([]);
    expect(read({ body: '你好 test_wx_01 13800000000' }).contacts).toEqual([]);
    expect(
      read({ kind: 'image', url: 'https://img.bosszhipin.com/image.png' })
        .assets[0].kind,
    ).toBe('image');
  });
  it('validates persisted URLs at the contract boundary as well', () => {
    expect(
      bossChatAssetSchema.safeParse({
        kind: 'image',
        name: '图',
        url: 'https://attacker.example/pixel',
      }).success,
    ).toBe(false);
    expect(
      bossChatSnapshotSchema.safeParse({
        geekId: 'candidate-test',
        providerConversationId: 'conversation',
        fetchedAt: new Date().toISOString(),
        historyLimited: true,
        messages: [],
        contacts: [],
      }).success,
    ).toBe(true);
  });
});
