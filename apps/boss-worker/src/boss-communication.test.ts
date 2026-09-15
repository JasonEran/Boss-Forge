import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { bossChatSnapshotSchema } from '@boss-forge/contracts';
import {
  chatInboxScript,
  chatSnapshotScript,
  loadRecentInbox,
} from './boss-communication.js';
import type { Page } from 'puppeteer-core';

function read(input: {
  geekId?: string;
  multiple?: boolean;
  messages?: unknown[];
}) {
  const host = {
    getBoundingClientRect: () => ({ width: 900, height: 500 }),
    __vue__: {
      conversation$: {
        encryptUid: input.geekId ?? 'candidate-test-01',
        uniqueId: 'provider-thread-1',
      },
      list$: input.messages ?? [],
    },
  };
  return runInNewContext(chatSnapshotScript('candidate-test-01'), {
    document: {
      querySelectorAll: () => (input.multiple ? [host, host] : [host]),
    },
    getComputedStyle: () => ({ visibility: 'visible' }),
  });
}
describe('BOSS conversation state', () => {
  it('reads and locates an older virtualized conversation using the native list model', () => {
    let selected = -1,
      more = 0;
    const dataSources = Array.from({ length: 100 }, (_, i) => ({
      encryptUid: `candidate-test-${i}`,
      encryptFriendId: `candidate-test-${i}`,
      lastText: `message-${i}`,
      newMsgCount: i === 70 ? 2 : 0,
      lastTS: 1789000000000 + i * 1000,
      formateTime: '昨天',
    }));
    const host = {
      getBoundingClientRect: () => ({ width: 300, height: 380 }),
      __vue__: {
        $options: { name: 'boss-virtual-list' },
        dataSources,
        scrollToIndex: (i: number) => {
          selected = i;
        },
        scrollToBottom: () => {
          more++;
        },
      },
    };
    const context = { document: { querySelectorAll: () => [host] } };
    const result = runInNewContext(
      chatInboxScript(['candidate-test-70']),
      context,
    );
    expect(result.loadedCount).toBe(100);
    expect(result.conversations).toEqual([
      {
        geekId: 'candidate-test-70',
        unreadCount: 2,
        preview: 'message-70',
        timeLabel: '昨天',
        lastMessageAt: new Date(1789000070000).toISOString(),
      },
    ]);
    runInNewContext(chatInboxScript(['candidate-test-70'], 'locate'), context);
    expect(selected).toBe(70);
    runInNewContext(chatInboxScript(['missing-candidate'], 'more'), context);
    expect(more).toBe(1);
    dataSources[70]!.encryptFriendId = 'different-candidate';
    expect(() =>
      runInNewContext(
        chatInboxScript(['candidate-test-70'], 'locate'),
        context,
      ),
    ).toThrow('CHAT_TARGET_NOT_FOUND');
  });
  it('binds to one exact candidate, never a same-name chat', () => {
    expect(() => read({ geekId: 'other-candidate-01' })).toThrow(
      'CHAT_TARGET_MISMATCH',
    );
    expect(() => read({ multiple: true })).toThrow('CHAT_NOT_READY');
    expect(() => chatSnapshotScript('bad"target')).toThrow();
  });
  it('preserves plain text, line breaks, direction and provider message identity', () => {
    const snapshot = bossChatSnapshotSchema.parse(
      read({
        messages: [
          {
            mid: 'incoming',
            text: '你好\n<script>原文</script>',
            type: 'text',
            time: 1789000000,
            isSelf: false,
          },
          {
            mid: 'client-only',
            text: '未收到回执',
            type: 'text',
            time: 1789000000000,
            isSelf: true,
            status: 0,
          },
          {
            serverMid: 'server-accepted',
            text: '你好',
            type: 'text',
            time: 1789000001000,
            isSelf: true,
            status: 1,
          },
          {
            mid: 'attachment',
            type: 'resume',
            time: 1789000002000,
            isSelf: false,
          },
        ],
      }),
    );
    expect(snapshot.messages.map((m) => m.providerMessageId)).toEqual([
      'incoming',
      'server-accepted',
      'attachment',
    ]);
    expect(snapshot.messages[0]).toMatchObject({
      direction: 'inbound',
      body: '你好\n<script>原文</script>',
      sentAt: new Date(1789000000000).toISOString(),
    });
    expect(snapshot.messages[1]).toMatchObject({
      direction: 'outbound',
      delivery: 'sent',
    });
    expect(snapshot.messages[2]).toMatchObject({
      kind: 'file',
      body: '[附件]',
    });
    expect(snapshot.historyLimited).toBe(true);
  });
  it('omits messages with untrustworthy identity or time instead of inventing history', () => {
    expect(
      read({
        messages: [
          { text: '无编号', time: 1789000000000 },
          { mid: 'wrong-time', time: NaN },
        ],
      }).messages,
    ).toEqual([]);
  });
  it('includes delivered and read history after BOSS reloads server IDs into mid', () => {
    const snapshot = read({
      messages: [
        {
          mid: 384222334006016,
          received: true,
          isSelf: true,
          status: 1,
          type: 'text',
          text: '已送达历史',
          time: 1788943480751,
        },
        {
          mid: 384222334006017,
          received: true,
          isSelf: true,
          status: 2,
          type: 'text',
          text: '已读历史',
          time: 1788943480752,
        },
        {
          mid: 123456,
          received: false,
          isSelf: true,
          status: 1,
          type: 'text',
          text: '本地气泡',
          time: 1788943480753,
        },
        {
          mid: 123457,
          received: true,
          isSelf: true,
          status: 0,
          type: 'text',
          text: '未确认',
          time: 1788943480754,
        },
      ],
    });
    expect(
      snapshot.messages.map(
        (m: { providerMessageId: string }) => m.providerMessageId,
      ),
    ).toEqual(['384222334006016', '384222334006017']);
    expect(
      snapshot.messages.every(
        (m: { delivery: string }) => m.delivery === 'sent',
      ),
    ).toBe(true);
  });
  it('classifies native service promotions as system messages rather than candidate replies', () => {
    const snapshot = read({
      messages: [
        {
          mid: 384540191650049,
          received: true,
          isSelf: false,
          status: 2,
          type: 'dialog',
          messageType: 4,
          text: '顾问服务提示',
          time: 1788943480751,
        },
      ],
    });
    expect(snapshot.messages[0]).toMatchObject({
      kind: 'system',
      direction: 'system',
    });
  });
  it('keeps BOSS job-context cards out of candidate reply and unread counts', () => {
    const snapshot = read({
      messages: [
        {
          mid: 384206012440837,
          received: true,
          isSelf: false,
          status: 2,
          type: 'resume',
          messageType: 3,
          bizType: 21050004,
          text: '9月9日 沟通的职位',
          time: 1788943480751,
        },
      ],
    });
    expect(snapshot.messages[0]).toMatchObject({
      kind: 'system',
      direction: 'system',
    });
  });
});

describe('seven-day native BOSS inbox', () => {
  it('discovers conversations that were never sent by our platform, excluding old, unknown-date and deleted rows', () => {
    const now = Date.now(),
      since = new Date(now - 7 * 86_400_000).toISOString();
    const rows = [
      {
        name: '置顶旧会话',
        encryptUid: 'candidate-pinned-old',
        lastTS: now - 10 * 86_400_000,
        isTop: 1,
      },
      {
        name: '原生新回复',
        encryptUid: 'candidate-native-new',
        encryptFriendId: 'candidate-native-new',
        encryptJobId: 'job-native',
        jobName: '测试岗位',
        uniqueId: 'thread-native',
        newMsgCount: 3,
        lastTS: now,
        lastText: '你好',
      },
      {
        name: '六天前',
        encryptUid: 'candidate-six-days',
        lastTS: now - 6 * 86_400_000,
      },
      {
        name: '过期',
        encryptUid: 'candidate-old-eight',
        lastTS: now - 8 * 86_400_000,
      },
      { name: '无日期', encryptUid: 'candidate-no-date' },
      { name: '已删除', encryptUid: 'candidate-deleted', lastTS: now, del: 1 },
    ];
    const host = {
      getBoundingClientRect: () => ({ width: 300, height: 400 }),
      __vue__: { $options: { name: 'boss-virtual-list' }, dataSources: rows },
    };
    const context = { document: { querySelectorAll: () => [host] } };
    const result = runInNewContext(chatInboxScript([], 'read', since), context);
    expect(
      result.conversations.map((c: { geekId: string }) => c.geekId),
    ).toEqual(['candidate-native-new', 'candidate-six-days']);
    expect(result.conversations[0]).toMatchObject({
      candidateName: '原生新回复',
      bossJobId: 'job-native',
      positionName: '测试岗位',
      providerConversationId: 'thread-native',
      unreadCount: 3,
    });
    expect(result.windowPassed).toBe(false);
    expect(result.skippedCount).toBe(1);
    rows.splice(4, 2);
    expect(
      runInNewContext(chatInboxScript([], 'read', since), context).windowPassed,
    ).toBe(true);
  });
  it('reports partial coverage even when the cutoff is reached after more than 2,000 recent rows', async () => {
    const now = Date.now();
    const rows = Array.from({ length: 2001 }, (_, i) => ({
      name: `隔离会话${i}`,
      encryptUid: `candidate-cap-${i}`,
      lastTS: now - i * 1000,
    }));
    rows.push({
      name: '旧会话',
      encryptUid: 'candidate-older-window',
      lastTS: now - 8 * 86_400_000,
    });
    const host = {
      getBoundingClientRect: () => ({ width: 300, height: 400 }),
      __vue__: { $options: { name: 'boss-virtual-list' }, dataSources: rows },
    };
    const page = {
      evaluate: async (script: string) =>
        runInNewContext(script, {
          document: { querySelectorAll: () => [host] },
        }),
    } as unknown as Page;
    const result = await loadRecentInbox(page);
    expect(result.conversations).toHaveLength(2000);
    expect(result.coverageLimited).toBe(true);
    expect(result.scannedCount).toBe(2002);
  });
});
