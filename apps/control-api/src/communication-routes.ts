import {readFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import { communicationCandidateContext, communicationResumeFile } from './communication-online-resume.js';
import { fetchCommunicationAsset } from './communication-assets.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CommunicationRepository,
  AuthorizationError,
  type SessionPrincipal,
  type WorkspaceActivityRepository,
} from '@boss-forge/data';
import {
  chatMessageBodySchema,
  recruitmentMessageContextSchema,
  type BossChatInbox,
} from '@boss-forge/contracts';
import {
  readResumePart,
  resolveResumeFile,
  requestBossChatAttachmentViaIpc,
  requestBossChatResumeViaIpc,
  BossBrowserControlError,
  requestBossChatInboxViaIpc,
  requestBossChatReadViaIpc,
  requestBossChatSendViaIpc,
  requestBossWechatViaIpc,
} from '@boss-forge/boss-cli-adapter';

const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
    value,
  );
import { createCommunicationSyncCache } from './communication-sync.js';
const sharedInbox = createCommunicationSyncCache<BossChatInbox>();
export async function communicationRoutes(input: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  principal: SessionPrincipal;
  repository: CommunicationRepository;
  activity: Pick<WorkspaceActivityRepository, 'leaseActive'>;
  accountId: string;
  socketPath: string;
  connection(): Promise<{
    connected: boolean;
    canSend: boolean;
    message: string;
  }>;
  readJson(request: IncomingMessage): Promise<Record<string, unknown>>;
  send(response: ServerResponse, status: number, body: unknown): void;
}): Promise<boolean> {
  const {
    request,
    response,
    url,
    principal,
    repository,
    accountId,
    socketPath,
    send,
  } = input;
  if (!url.pathname.startsWith('/api/communication/')) return false;
  if (!['admin', 'recruiting_lead', 'recruiter'].includes(principal.role))
    throw new AuthorizationError('没有实时沟通权限。');
  const lease = request.headers['x-boss-communication-lease'];
  const assertLiveMode = async (): Promise<string> => {
    if (
      !uuid(lease) ||
      !(await input.activity.leaseActive(accountId, lease, principal.userId))
    ) {
      throw new BossBrowserControlError(
        'mode_inactive',
        '实时沟通已暂停，请返回实时沟通页面。',
      );
    }
    return lease;
  };
  try {
    if (
      request.method === 'GET' &&
      url.pathname === '/api/communication/conversations'
    ) {
      send(response, 200, {
        conversations: await repository.list(principal),
        connection: await input.connection(),
      });
      return true;
    }
    if (
      request.method === 'POST' &&
      url.pathname === '/api/communication/sync'
    ) {
      const leaseId = await assertLiveMode();
      const state = await input.connection();
      if (!state.connected)
        throw new BossBrowserControlError('not_authenticated', state.message);
      await repository.assertInboxAccess(principal, accountId);
      const snapshot = await sharedInbox(accountId, async () => {
        const value = await requestBossChatInboxViaIpc({
          socketPath,
          accountId,
          leaseId,
          geekIds: [],
          timeoutMs: 60_000,
        });
        await repository.saveInbox(accountId, value);
        return value;
      });
      send(response, 200, {
        conversations: await repository.list(principal),
        connection: state,
        syncedAt: snapshot.fetchedAt,
        windowStart: snapshot.windowStart,
        coverageLimited: snapshot.coverageLimited ?? false,
      });
      return true;
    }
    const attachment = url.pathname.match(/^\/api\/communication\/conversations\/([0-9a-f-]+)\/attachment-resume$/i);
    if (attachment && uuid(attachment[1]) && request.method === 'POST') {
      const target=await repository.target(principal,attachment[1]);
      const leaseId=await assertLiveMode();
      if(target.bossAccountId!==accountId)throw new AuthorizationError('会话账号不一致。');
      const connection=await input.connection();
      if(!connection.connected)throw new BossBrowserControlError('not_authenticated',connection.message);
      const captured=await requestBossChatAttachmentViaIpc({socketPath,accountId,leaseId,geekId:target.geekId,timeoutMs:60000});
      const root=join(process.env.BOSS_FORGE_RESUME_SCREENSHOT_DIR?.trim()||join(homedir(),'.boss-cli','.cache','resume-screenshots'),'attachments');
      const file=await resolveResumeFile(captured.filePath,root);
      const info=await stat(file);
      if(!info.isFile()||info.size!==captured.size||info.size>20*1024*1024)throw new Error('附件文件不完整，请重试。');
      const body=await readFile(file);
      // API mounts the browser artifact volume read-only; the worker owns cleanup.
      response.writeHead(200,{'content-type':captured.contentType,'content-disposition':`inline; filename*=UTF-8''${encodeURIComponent(captured.name)}`,'access-control-expose-headers':'content-disposition','content-length':body.length,'cache-control':'private, no-store','x-content-type-options':'nosniff'});
      response.end(body);return true;
    }
    const analyze=url.pathname.match(/^\/api\/communication\/conversations\/([0-9a-f-]+)\/online-resume\/analyze$/i);
    if(analyze && uuid(analyze[1]) && request.method==='POST') {
      await repository.queueOnlineResumeAnalysis(principal,analyze[1]);
      send(response,202,await communicationCandidateContext(repository,principal,analyze[1]));return true;
    }
    const online = url.pathname.match(/^\/api\/communication\/conversations\/([0-9a-f-]+)\/online-resume(?:\/(\d+))?$/i);
    if (online && uuid(online[1])) {
      const id = online[1];
      const target = await repository.target(principal,id);
      if (request.method === 'POST' && online[2] === undefined) {
        const leaseId = await assertLiveMode();
        const connection = await input.connection();
        if (!connection.connected) throw new BossBrowserControlError('not_authenticated',connection.message);
        if (target.bossAccountId !== accountId) throw new AuthorizationError('会话账号不一致。');
        const snapshot = await requestBossChatResumeViaIpc({socketPath,accountId,leaseId,geekId:target.geekId,timeoutMs:240000});
        await repository.saveOnlineResume(principal,id,snapshot);
      } else if (request.method !== 'GET') { send(response,405,{message:'不支持的操作。'}); return true; }
      if (online[2] !== undefined) {
        const stored = await communicationResumeFile(repository,principal,id);
        if (!stored || url.searchParams.get('capture') !== stored.captureId) { send(response,409,{message:'简历已更新，请重新打开。'}); return true; }
        const index = Number(online[2]);
        if (!Number.isSafeInteger(index) || !stored.artifact.parts[index]) { send(response,404,{message:'简历分段不存在。'}); return true; }
        const data = await readResumePart(stored.file,stored.artifact,index);
        response.writeHead(200,{'content-type':'image/png','cache-control':'private, no-store','x-content-type-options':'nosniff'});response.end(data);return true;
      }
      send(response,200,await communicationCandidateContext(repository,principal,id)); return true;
    }
    const quick = url.pathname.match(
      /^\/api\/communication\/quick-replies(?:\/([0-9a-f-]+))?$/i,
    );
    if (quick) {
      const id = quick[1];
      if (id && !uuid(id)) {
        send(response, 400, { message: '常用语编号无效。' });
        return true;
      }
      if (request.method === 'GET' && !id) {
        send(response, 200, {
          quickReplies: await repository.quickReplies(principal),
        });
        return true;
      }
      if (
        (request.method === 'POST' && !id) ||
        (request.method === 'PATCH' && id)
      ) {
        const body = chatMessageBodySchema.safeParse(
          (await input.readJson(request)).body,
        );
        if (!body.success) {
          send(response, 400, { message: '常用语需为 1–500 字。' });
          return true;
        }
        send(response, 200, {
          quickReply: await repository.saveQuickReply(principal, body.data, id),
        });
        return true;
      }
      if (request.method === 'DELETE' && id) {
        await repository.deleteQuickReply(principal, id);
        send(response, 200, { ok: true });
        return true;
      }
      send(response, 405, { message: '不支持此操作。' });
      return true;
    }
    const assetMatch = url.pathname.match(
      /^\/api\/communication\/conversations\/([0-9a-f-]+)\/messages\/([0-9a-f-]+)\/assets\/(\d+)$/i,
    );
    if (
      request.method === 'GET' &&
      assetMatch &&
      uuid(assetMatch[1]) &&
      uuid(assetMatch[2])
    ) {
      const asset = await repository.asset(
        principal,
        assetMatch[1],
        assetMatch[2],
        Number(assetMatch[3]),
      );
      const file = await fetchCommunicationAsset(asset);
      response.writeHead(200, {
        'content-type': file.contentType,
        'content-disposition': file.disposition,
        'access-control-expose-headers': 'content-disposition',
        'content-length': file.body.length,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      });
      response.end(file.body);
      return true;
    }
    const match = url.pathname.match(
      /^\/api\/communication\/conversations\/([0-9a-f-]+)(?:\/(sync|messages|read|wechat|request-resume|accept-resume))?$/i,
    );
    if (!match || !uuid(match[1])) {
      send(response, 404, { message: '会话接口不存在。' });
      return true;
    }
    const id = match[1];
    const target = await repository.target(principal, id);
    if (request.method === 'GET' && !match[2]) {
      const before = url.searchParams.get('before');
      if (before && !uuid(before)) {
        send(response, 400, { message: '聊天记录页码无效。' });
        return true;
      }
      send(
        response,
        200,
        await repository.thread(principal, id, before ?? undefined),
      );
      return true;
    }
    if (request.method === 'POST' && match[2] === 'read') {
      const body = await input.readJson(request);
      if (!uuid(body.throughMessageId)) {
        send(response, 400, { message: '消息标记无效。' });
        return true;
      }
      await repository.markRead(principal, id, body.throughMessageId);
      send(response, 200, { ok: true });
      return true;
    }
    const connection = await input.connection();
    if (!connection.connected || target.bossAccountId !== accountId)
      throw new BossBrowserControlError(
        'not_authenticated',
        'BOSS 当前账号与会话未连接。',
      );
    if (request.method === 'POST' && match[2] === 'sync') {
      const leaseId = await assertLiveMode();
      const snapshot = await requestBossChatReadViaIpc({
        socketPath,
        accountId,
        leaseId,
        geekId: target.geekId,
        timeoutMs: 60_000,
      });
      await repository.saveSnapshot(target, snapshot);
      send(response, 200, await repository.thread(principal, id));
      return true;
    }
    if (
      request.method === 'POST' &&
      (match[2] === 'wechat' || match[2] === 'request-resume' || match[2] === 'accept-resume')
    ) {
      const leaseId = await assertLiveMode();
      if (!connection.canSend)
        throw new Error('真实发送未开启，请检查联系设置。');
      const key = request.headers['idempotency-key'];
      const body = await input.readJson(request);
      if (!uuid(key) || body.confirmed !== true || (match[2] === 'accept-resume' && !uuid(body.messageId))) {
        send(response, 400, { message: '请确认申请对象后再发起申请。' });
        return true;
      }
      const snapshot = await requestBossChatReadViaIpc({
        socketPath,
        accountId,
        leaseId,
        geekId: target.geekId,
        timeoutMs: 60_000,
      });
      await repository.saveSnapshot(target, snapshot);
      await assertLiveMode();
      await repository.assertReplyAllowed(principal, target);
      const action = await repository.createWechatAction(
        principal,
        id,
        key,
        match[2] === 'accept-resume' ? 'resume_accept' : match[2] === 'request-resume' ? 'resume' : 'wechat',
        match[2] === 'accept-resume' ? String(body.messageId) : undefined,
      );
      if (action.status === 'queued') {
        try {
          await requestBossWechatViaIpc({
            socketPath,
            accountId,
            leaseId,
            actionId: action.id,
            timeoutMs: 60_000,
          });
        } catch {
          await repository.failWechat(action.id, false, true);
        }
      }
      if (match[2] === 'accept-resume') {
        try {
          const latest=await requestBossChatReadViaIpc({socketPath,accountId,leaseId,geekId:target.geekId,timeoutMs:60000});
          await repository.saveSnapshot(target,latest);
        } catch { /* The persisted receipt survives a temporary refresh failure. */ }
      }
      send(response, 202, {
        ...(await repository.thread(principal, id)),
        wechatActionId: action.id,
      });
      return true;
    }
    if (request.method === 'POST' && match[2] === 'messages') {
      const leaseId = await assertLiveMode();
      if (!connection.canSend)
        throw new Error('真实发送未开启，请检查联系设置。');
      const body = await input.readJson(request);
      const text = chatMessageBodySchema.safeParse(body.body);
      const key = request.headers['idempotency-key'];
      if (!text.success || !uuid(key)) {
        send(response, 400, {
          message: '消息需为 1–500 字，并带有有效发送编号。',
        });
        return true;
      }
      const delivery =
        body.delivery === undefined
          ? undefined
          : recruitmentMessageContextSchema.safeParse(body.delivery);
      if (delivery && !delivery.success) {
        send(response, 400, { message: '邀请版本无效，请重新生成。' });
        return true;
      }
      // A cached login badge is insufficient. The supervisor verifies the exact
      // chat and refreshes authoritative account health before policy checks.
      const snapshot = await requestBossChatReadViaIpc({
        socketPath,
        accountId,
        leaseId,
        geekId: target.geekId,
        timeoutMs: 60_000,
      });
      await repository.saveSnapshot(target, snapshot);
      await assertLiveMode();
      await repository.assertReplyAllowed(principal, target);
      const outgoing = await repository.createOutgoing(
        principal,
        id,
        text.data,
        key,
        delivery?.data,
      );
      if (outgoing.status === 'queued') {
        try {
          await requestBossChatSendViaIpc({
            socketPath,
            accountId,
            leaseId,
            outgoingId: outgoing.id,
            timeoutMs: 60_000,
          });
        } catch {
          // The request can time out after BOSS accepted it. The persisted row,
          // not the HTTP transport outcome, determines whether it can be retried.
          await repository.failNotStarted(outgoing.id);
        }
      }
      send(response, 202, {
        ...(await repository.thread(principal, id)),
        outgoingId: outgoing.id,
      });
      return true;
    }
    send(response, 405, { message: '不支持此操作。' });
    return true;
  } catch (error) {
    if (error instanceof AuthorizationError) throw error;
    const resumeLimited = error instanceof BossBrowserControlError && error.code === 'resume_limited';
    const inactive =
      error instanceof BossBrowserControlError &&
      error.code === 'mode_inactive';
    const busy =
      error instanceof BossBrowserControlError && error.code === 'busy';
    const auth =
      error instanceof BossBrowserControlError &&
      error.code === 'not_authenticated';
    send(response, 409, {
      code: inactive
        ? 'mode_inactive'
        : busy
          ? 'busy'
          : auth
            ? 'not_authenticated'
            : 'unavailable',
      message: resumeLimited ? '当前已达到简历查看额度，或不在允许查看的时间内。已有简历仍可查看，额度恢复后可更新。' : inactive
        ? '实时沟通已暂停，请返回实时沟通页面。'
        : busy
          ? 'BOSS 正在处理其他操作，稍后会继续同步。'
          : auth
            ? 'BOSS 连接暂不可用，聊天记录和草稿已保留。'
            : error instanceof Error &&
                /消息|联系设置|发送结果|聊天对象|微信|常用语|在线简历|Idempotency-Key/.test(
                  error.message,
                )
              ? error.message
              : '暂时无法同步此会话，请稍后重试。',
    });
    return true;
  }
}
