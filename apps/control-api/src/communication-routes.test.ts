import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { startBossBrowserControlServer } from '@boss-forge/boss-cli-adapter';
import {
  AuthorizationError,
  type CommunicationRepository,
  type SessionPrincipal,
} from '@boss-forge/data';
import { communicationRoutes } from './communication-routes.js';

it('loads cached conversations and connection status concurrently without a live browser lease', async () => {
  let resolveList!: (value: never[]) => void;
  const listReady = new Promise<never[]>(resolve => { resolveList = resolve; });
  let resolveConnection!: (value: { connected: boolean; canSend: boolean; message: string }) => void;
  const connectionReady = new Promise<{ connected: boolean; canSend: boolean; message: string }>(resolve => { resolveConnection = resolve; });
  let listStarted = false;
  let connectionStarted = false;
  let result: unknown;
  const pending = communicationRoutes({
    request: { method: 'GET', headers: {} } as IncomingMessage,
    response: {} as ServerResponse,
    url: new URL('http://localhost/api/communication/conversations'),
    principal: { role: 'admin' } as SessionPrincipal,
    repository: {
      list: () => { listStarted = true; return listReady; },
    } as unknown as CommunicationRepository,
    activity: { leaseActive: async () => { throw new Error('unexpected live browser access'); } },
    accountId: 'account-test',
    socketPath: 'unused',
    connection: () => { connectionStarted = true; return connectionReady; },
    readJson: async () => ({}),
    send: (_response, status, body) => { expect(status).toBe(200); result = body; },
  });
  expect(listStarted).toBe(true);
  expect(connectionStarted).toBe(true);
  const connection = { connected: false, canSend: false, message: 'offline' };
  resolveList([]);
  resolveConnection(connection);
  expect(await pending).toBe(true);
  expect(result).toEqual({ conversations: [], connection });
});

async function scenario(
  options: {
    loginFails?: boolean;
    policyBlocked?: boolean;
    inactive?: boolean;
    wechat?: boolean;
    acceptResume?: boolean;
    missingMessage?: boolean;
    unconfirmed?: boolean;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'chat-route-')),
    socketPath = join(dir, 'control.sock');
  const id = randomUUID(),
    outgoingId = randomUUID(),
    geekId = 'candidate-route-test';
  let authoritativeHealthFresh = false,
    queued = 0,
    sent = 0,
    status = 0;
  const server = await startBossBrowserControlServer({
    socketPath,
    accountId: 'account-test',
    greetingPreview: async () => {
      throw new Error('unexpected');
    },
    chatRead: async (target) => {
      expect(target).toBe(geekId);
      if (options.loginFails) throw new Error('BOSS login expired');
      authoritativeHealthFresh = true;
      return {
        geekId,
        providerConversationId: 'thread-test',
        fetchedAt: new Date().toISOString(),
        messages: [],
        historyLimited: true,
        wechat: { state: 'available', reason: '' },
      };
    },
    chatSend: async (messageId) => {
      sent++;
      expect(messageId).toBe(outgoingId);
      return { messageId };
    },
    chatWechat: async (actionId) => {
      sent++;
      expect(actionId).toBe(outgoingId);
      return { actionId };
    },
  });
  const repository = {
    target: async () => ({ id, geekId, bossAccountId: 'account-test' }),
    saveSnapshot: async () => {},
    assertReplyAllowed: async () => {
      if (!authoritativeHealthFresh) throw new Error('stale account health');
      if (options.policyBlocked) throw new Error('当前联系设置不允许发送');
    },
    createOutgoing: async () => {
      queued++;
      return { id: outgoingId, status: 'queued' };
    },
    thread: async () => ({ messages: [] }),
    createWechatAction: async (_principal:unknown,_id:string,_key:string,kind:string,messageId?:string) => {
      if(options.acceptResume){expect(kind).toBe('resume_accept');expect(messageId).toBe(id);}
      queued++;
      return { id: outgoingId, status: 'queued' };
    },
  } as unknown as CommunicationRepository;
  try {
    await communicationRoutes({
      request: {
        method: 'POST',
        headers: {
          'idempotency-key': randomUUID(),
          'x-boss-communication-lease': randomUUID(),
        },
      } as unknown as IncomingMessage,
      response: {} as ServerResponse,
      url: new URL(
        `http://localhost/api/communication/conversations/${id}/${options.acceptResume ? 'accept-resume' : options.wechat ? 'wechat' : 'messages'}`,
      ),
      principal: { role: 'admin' } as SessionPrincipal,
      repository,
      activity: { leaseActive: async () => !options.inactive },
      accountId: 'account-test',
      socketPath,
      connection: async () => ({
        connected: true,
        canSend: true,
        message: 'cached login is connected',
      }),
      readJson: async () => ({
        body: '仅用于隔离测试',
        confirmed: !options.unconfirmed,
        messageId:options.missingMessage?undefined:id,
      }),
      send: (_res, value) => {
        status = value;
      },
    });
    return { authoritativeHealthFresh, queued, sent, status };
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}
describe('chat send readiness', () => {
  it('refuses a paused communication page before opening BOSS or queuing a message', async () => {
    expect(await scenario({ inactive: true })).toEqual({
      authoritativeHealthFresh: false,
      queued: 0,
      sent: 0,
      status: 409,
    });
  });
  it('refreshes stale authoritative health through a native chat read before enqueue', async () => {
    expect(await scenario()).toEqual({
      authoritativeHealthFresh: true,
      queued: 1,
      sent: 1,
      status: 202,
    });
  });
  it('does not trust a cached online badge when native login verification fails', async () => {
    expect(await scenario({ loginFails: true })).toEqual({
      authoritativeHealthFresh: false,
      queued: 0,
      sent: 0,
      status: 409,
    });
  });
  it('still enforces contact controls after verifying the current BOSS session', async () => {
    expect(await scenario({ policyBlocked: true })).toEqual({
      authoritativeHealthFresh: true,
      queued: 0,
      sent: 0,
      status: 409,
    });
  });
});

describe('native WeChat request readiness', () => {
  it('requires a confirmed target before any native read or enqueue', async () => {
    expect(await scenario({ wechat: true, unconfirmed: true })).toEqual({
      authoritativeHealthFresh: false,
      queued: 0,
      sent: 0,
      status: 400,
    });
  });
  it('reads the current native chat and policy before dispatching a persisted action', async () => {
    expect(await scenario({ wechat: true })).toEqual({
      authoritativeHealthFresh: true,
      queued: 1,
      sent: 1,
      status: 202,
    });
  });
  it.each([{ inactive: true }, { loginFails: true }, { policyBlocked: true }])(
    'blocks WeChat when readiness fails: %j',
    async (option) => {
      const result = await scenario({ wechat: true, ...option });
      expect(result).toMatchObject({ queued: 0, sent: 0, status: 409 });
    },
  );
});

describe('native inbox discovery', () => {
  it.each([false, true])(
    'checks account permissions before discovering all BOSS contacts (denied=%s)',
    async (denied) => {
      const dir = await mkdtemp(join(tmpdir(), 'inbox-route-')),
        socketPath = join(dir, 'control.sock'),
        accountId = `account-${randomUUID()}`;
      let scans = 0,
        saved = 0,
        status = 0;
      const conversation = { id: randomUUID(), candidateName: '原生会话示例' };
      const server = await startBossBrowserControlServer({
        socketPath,
        accountId,
        greetingPreview: async () => {
          throw new Error('unexpected');
        },
        chatInbox: async (ids) => {
          scans++;
          expect(ids).toEqual([]);
          return { fetchedAt: new Date().toISOString(), conversations: [] };
        },
      });
      try {
        const promise = communicationRoutes({
          request: {
            method: 'POST',
            headers: { 'x-boss-communication-lease': randomUUID() },
          } as unknown as IncomingMessage,
          response: {} as ServerResponse,
          url: new URL('http://localhost/api/communication/sync'),
          principal: { role: 'admin' } as SessionPrincipal,
          repository: {
            assertInboxAccess: async () => {
              if (denied) throw new AuthorizationError('denied');
            },
            saveInbox: async () => {
              saved++;
            },
            list: async () => [conversation],
          } as unknown as CommunicationRepository,
          activity: { leaseActive: async () => true },
          accountId,
          socketPath,
          connection: async () => ({
            connected: true,
            canSend: true,
            message: 'connected',
          }),
          readJson: async () => ({}),
          send: (_res, code, body) => {
            status = code;
            expect(body).toMatchObject({ conversations: [conversation] });
          },
        });
        if (denied)
          await expect(promise).rejects.toBeInstanceOf(AuthorizationError);
        else await promise;
        expect({ scans, saved, status }).toEqual(
          denied
            ? { scans: 0, saved: 0, status: 0 }
            : { scans: 1, saved: 1, status: 200 },
        );
      } finally {
        await server.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('resume offer consent route',()=>{
  it('requires a selected message and explicit confirmation',async()=>{
    for(const option of [{unconfirmed:true},{missingMessage:true}])expect(await scenario({acceptResume:true,...option})).toMatchObject({queued:0,sent:0,status:400});
  });
  it('uses the same refreshed health, live lease and contact controls as other native actions',async()=>{
    expect(await scenario({acceptResume:true})).toMatchObject({queued:1,sent:1,status:202});
    for(const option of [{inactive:true},{policyBlocked:true},{loginFails:true}])expect(await scenario({acceptResume:true,...option})).toMatchObject({queued:0,sent:0});
  });
});

describe('received attachment serving',()=>{
  it('serves the verified file from the read-only browser volume without deleting it',async()=>{
    const {mkdir,writeFile,readFile,chmod}=await import('node:fs/promises');
    const root=await mkdtemp(join(tmpdir(),'resume-ro-')),folder=join(root,'attachments'),socketPath=join(root,'control.sock');
    await mkdir(folder);
    const filePath=join(folder,`${randomUUID()}.pdf`),body=Buffer.from('%PDF-1.7\nread-only resume fixture');
    await writeFile(filePath,body);await chmod(folder,0o555);
    const previous=process.env.BOSS_FORGE_RESUME_SCREENSHOT_DIR;
    process.env.BOSS_FORGE_RESUME_SCREENSHOT_DIR=root;
    const id=randomUUID(),leaseId=randomUUID();let status=0,received:Buffer|undefined;
    const server=await startBossBrowserControlServer({socketPath,accountId:'attachment-test',greetingPreview:async()=>{throw Error('unexpected');},chatAttachment:async(geek,lease)=>{
      expect(geek).toBe('attachment-candidate');expect(lease).toBe(leaseId);
      return {geekId:geek,filePath,name:'附件简历.pdf',contentType:'application/pdf',size:body.length};
    }});
    try {
      await communicationRoutes({
        request:{method:'POST',headers:{'x-boss-communication-lease':leaseId}} as unknown as IncomingMessage,
        response:{writeHead:(code:number,headers:Record<string,unknown>)=>{status=code;expect(headers['content-type']).toBe('application/pdf');},end:(data:Buffer)=>{received=data;}} as unknown as ServerResponse,
        url:new URL(`http://localhost/api/communication/conversations/${id}/attachment-resume`),principal:{role:'admin'} as SessionPrincipal,
        repository:{target:async()=>({id,bossAccountId:'attachment-test',geekId:'attachment-candidate'})} as unknown as CommunicationRepository,
        activity:{leaseActive:async()=>true},accountId:'attachment-test',socketPath,connection:async()=>({connected:true,canSend:true,message:''}),readJson:async()=>({}),send:(_res,code)=>{status=code;},
      });
      expect(status).toBe(200);expect(received).toEqual(body);expect(await readFile(filePath)).toEqual(body);
    }finally{
      if(previous===undefined)delete process.env.BOSS_FORGE_RESUME_SCREENSHOT_DIR;else process.env.BOSS_FORGE_RESUME_SCREENSHOT_DIR=previous;
      await server.close();await chmod(folder,0o755);await rm(root,{recursive:true,force:true});
    }
  });
});
