import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  startBossBrowserControlServer,
  requestBossChatInboxViaIpc,
  requestBossChatReadViaIpc,
  requestBossChatResumeViaIpc,
  requestBossChatAttachmentViaIpc,
  requestBossChatSendViaIpc,
  requestBossWechatViaIpc,
} from './browser-control-ipc.js';

describe('communication IPC', () => {
  it('binds reads and persisted sends to the account, candidate and message request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chat-ipc-'));
    const socketPath = join(dir, 'control.sock');
    const sent: string[] = [],
      exchanges: string[] = [];
    let wrong = false;
    const server = await startBossBrowserControlServer({
      socketPath,
      accountId: 'account-test',
      greetingPreview: async () => {
        throw new Error('unexpected');
      },
      chatInbox: async (geekIds) => ({
        fetchedAt: new Date().toISOString(),
        conversations: geekIds.map((geekId) => ({
          geekId,
          unreadCount: 1,
          preview: '新回复',
          timeLabel: '今天',
        })),
      }),
      chatRead: async (geekId) => ({
        geekId: wrong ? 'wrong-candidate' : geekId,
        providerConversationId: 'thread-1',
        fetchedAt: new Date().toISOString(),
        messages: [],
        historyLimited: true,
      }),
      chatAttachment: async (geekId,leaseId)=>{expect(leaseId).toBe(input.leaseId);return {geekId:wrong?'wrong-candidate':geekId,filePath:'/resume/attachments/file.pdf',name:'简历.pdf',contentType:'application/pdf',size:100};},
      chatResume: async (geekId, leaseId) => {expect(leaseId).toBe(input.leaseId); return {geekId:wrong?'wrong-candidate':geekId,capturedAt:new Date().toISOString(),screenshotPath:'/resume/test.png',text:'已通过专八',textStatus:'ready'};},
      chatSend: async (id) => {
        sent.push(id);
        return { messageId: wrong ? randomUUID() : id };
      },
      chatWechat: async (id, lease) => {
        expect(lease).toBe(input.leaseId);
        exchanges.push(id);
        return { actionId: wrong ? randomUUID() : id };
      },
    });
    const input = {
      socketPath,
      accountId: 'account-test',
      leaseId: randomUUID(),
      timeoutMs: 1000,
    };
    try {
      await expect(requestBossChatAttachmentViaIpc({...input,geekId:'candidate-01'})).resolves.toMatchObject({contentType:'application/pdf'});
      expect(
        (
          await requestBossChatInboxViaIpc({
            ...input,
            geekIds: ['candidate-01'],
          })
        ).conversations,
      ).toHaveLength(1);
      await expect(
        requestBossChatReadViaIpc({ ...input, geekId: 'candidate-01' }),
      ).resolves.toMatchObject({ geekId: 'candidate-01' });
      await expect(
        requestBossChatReadViaIpc({
          ...input,
          accountId: 'other',
          geekId: 'candidate-01',
        }),
      ).rejects.toMatchObject({ code: 'unavailable' });
      await expect(requestBossChatResumeViaIpc({...input,geekId:'candidate-01'})).resolves.toMatchObject({geekId:'candidate-01'});
      await expect(requestBossChatResumeViaIpc({...input,leaseId:'',geekId:'candidate-01'})).rejects.toMatchObject({code:'unavailable'});
      const outgoingId = randomUUID();
      await requestBossChatSendViaIpc({ ...input, outgoingId });
      expect(sent).toEqual([outgoingId]);
      const actionId = randomUUID();
      await requestBossWechatViaIpc({ ...input, actionId });
      expect(exchanges).toEqual([actionId]);
      wrong = true;
      await expect(requestBossChatAttachmentViaIpc({...input,geekId:'candidate-01'})).rejects.toThrow();
      await expect(requestBossChatResumeViaIpc({...input,geekId:'candidate-01'})).rejects.toMatchObject({code:'unavailable'});
      await expect(
        requestBossChatReadViaIpc({ ...input, geekId: 'candidate-01' }),
      ).rejects.toMatchObject({ code: 'unavailable' });
      await expect(
        requestBossChatSendViaIpc({ ...input, outgoingId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'unavailable' });
      await expect(
        requestBossChatSendViaIpc({ ...input, outgoingId: 'arbitrary body' }),
      ).rejects.toMatchObject({ code: 'unavailable' });
      await expect(
        requestBossWechatViaIpc({ ...input, actionId }),
      ).rejects.toMatchObject({ code: 'unavailable' });
      await expect(
        requestBossWechatViaIpc({ ...input, actionId: 'arbitrary action' }),
      ).rejects.toMatchObject({ code: 'unavailable' });
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
