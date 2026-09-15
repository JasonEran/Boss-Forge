import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { evaluateCandidate } from '../../m1-core/src/index.js';
import { type BossChatSnapshot } from '@boss-forge/contracts';
import {
  BossForgeRepository,
  CommunicationRepository,
  DepartmentAtsRepository,
  createDatabase,
  parseRuleConfig,
  assertIsolatedTestDatabase,
  type SessionPrincipal,
} from './index.js';
import { sendQueuedBossWechat } from '../../../apps/boss-worker/src/boss-wechat.js';
import { sendQueuedBossChat } from '../../../apps/boss-worker/src/boss-communication.js';

assertIsolatedTestDatabase(process.env, { contactSideEffects: true });
const sql = createDatabase();
const ats = new DepartmentAtsRepository(sql),
  repository = new BossForgeRepository(sql),
  chat = new CommunicationRepository(sql);
try {
  await ats.ensureBootstrap({
    departmentName: '沟通验收',
    adminEmail: 'communication-test@example.com',
    adminName: '验收管理员',
    password: 'Communication-Test-Only!',
  });
  const [admin] = await sql`SELECT * FROM users WHERE role = 'admin' LIMIT 1`;
  const principal: SessionPrincipal = {
    userId: admin!.id,
    departmentId: admin!.department_id,
    email: admin!.email,
    displayName: admin!.display_name,
    role: 'admin',
  };
  const suffix = randomUUID();
  const position = await repository.createPosition({
    bossAccountId: `chat-test-${suffix}`,
    name: '沟通验收岗位',
    ownerName: '验收管理员',
  });
  await sql`UPDATE positions SET department_id=${principal.departmentId}, owner_user_id=${principal.userId}, boss_job_id='test-job' WHERE id=${position.id}`;
  const config = parseRuleConfig({
    schemaVersion: '1.0',
    root: {
      operator: 'AND',
      children: [
        {
          type: 'text',
          field: 'all',
          value: '隔离',
          match: 'contains',
          unknownPolicy: 'fail',
        },
      ],
    },
    screeningFlow: 'boss_then_resume',
    bossRecommendationFilters: { mode: 'custom', fields: {} },
  });
  await repository.createRuleVersion({
    positionId: position.id,
    name: '沟通测试',
    config,
    dictionaryVersion: 'test',
    createdBy: principal.userId,
  });
  await repository.createImmediateTask({
    positionId: position.id,
    idempotencyKey: suffix,
    source: 'recommend',
    createdBy: principal.userId,
    candidateLimit: 4,
  });
  const task = await repository.claimNextTask(
    'chat-test-worker',
    position.bossAccountId,
  );
  assert(task);
  await repository.completeTask(
    task,
    [0, 1, 2, 3].map((index) =>
      evaluateCandidate(
        {
          index: index + 1,
          name: `沟通示例${index}`,
          source: 'recommend',
          sourceLocator: {
            kind: 'boss_geek_id',
            value: `geek-test-${suffix}-${index}`,
          },
          fields: {},
          evidence: [],
          raw: '仅用于隔离验收',
        },
        config,
      ),
    ),
    position.name,
  );
  const states =
    await sql`SELECT cps.id,cps.candidate_id,s.source_locator FROM candidate_position_states cps JOIN candidate_snapshots s ON s.id=cps.latest_snapshot_id WHERE cps.position_id=${position.id} ORDER BY cps.id`;
  for (let i = 0; i < states.length; i++) {
    const status = ['sent', 'failed', 'simulated', 'sent'][i]!;
    await sql`INSERT INTO contact_intents(id,idempotency_key,candidate_position_state_id,task_id,action_kind,provider_greeting_id,provider_job_id,rendered_message,status,policy_snapshot,created_by,transport_mode,finished_at)
      VALUES(${randomUUID()},${randomUUID()},${states[i]!.id},${task.id},'greet','test-greeting','test-job','你好，想和你交流岗位。',${status},'{}',${principal.userId},${i === 2 ? 'fake' : 'real'},now())`;
  }
  let clock = Date.now();
  const stamp = () => new Date(Math.max(Date.now(), ++clock)).toISOString();
  const at = (minutes = 0) =>
    new Date(Date.now() - minutes * 60_000).toISOString();
  const inbox = (index: number) => ({
    geekId: states[index]!.source_locator.value,
    candidateName: `沟通示例${index}`,
    bossJobId: 'test-job',
    positionName: position.name,
    preview: 'BOSS 中已有会话',
    lastMessageAt: at(5),
    timeLabel: '刚刚',
    unreadCount: 0,
  });
  await chat.saveInbox(position.bossAccountId, {
    fetchedAt: stamp(),
    conversations: [inbox(0), inbox(3)],
  });
  const targets = (await chat.targets(principal)).filter(
    (t) => t.positionId === position.id,
  );
  assert.equal(targets.length, 2);
  const target = targets[0]!;
  await sql`UPDATE candidate_position_states SET is_current=false WHERE id=${target.stateId}`;
  assert.equal(
    (await chat.targets(principal)).filter((t) => t.positionId === position.id)
      .length,
    2,
  );
  const recruiter = (await ats.createUser(principal, {
    email: `chat-${suffix}@example.com`,
    displayName: '未分配岗位',
    role: 'recruiter',
    password: 'Communication-Test-Only!',
  })) as { id: string };
  const restricted = {
    ...principal,
    userId: recruiter.id,
    role: 'recruiter' as const,
  };
  assert.deepEqual(await chat.list(restricted), []);
  await assert.rejects(chat.thread(restricted, target.id));
  await assert.rejects(chat.list({ ...principal, role: 'interviewer' }));
  await assert.rejects(
    chat.thread({ ...principal, departmentId: randomUUID() }, target.id),
  );

  const snapshot: BossChatSnapshot = {
    geekId: target.geekId,
    providerConversationId: 'test-conversation',
    fetchedAt: stamp(),
    historyLimited: true,
    wechat: { state: 'available', reason: '' },
    messages: [
      {
        providerMessageId: 'incoming-1',
        direction: 'inbound',
        kind: 'text',
        body: '你好，我对岗位有兴趣。',
        sentAt: at(4),
        delivery: 'sent',
      },
      {
        providerMessageId: 'outgoing-1',
        direction: 'outbound',
        kind: 'text',
        body: '方便聊聊吗？',
        sentAt: at(3),
        delivery: 'sent',
      },
      {
        providerMessageId: 'pending-1',
        direction: 'outbound',
        kind: 'text',
        body: '尚未被 BOSS 确认',
        sentAt: at(2),
        delivery: 'pending',
      },
    ],
  };
  const save = (extra: Partial<BossChatSnapshot> = {}) =>
    chat.saveSnapshot(target, { ...snapshot, ...extra, fetchedAt: stamp() });
  await assert.rejects(save({ geekId: 'other-geek-id' }));
  await save();
  await save();
  assert.equal((await chat.thread(principal, target.id)).messages.length, 2);
  assert.equal(
    (await chat.list(principal)).find((c) => c.id === target.id)?.unreadCount,
    1,
  );
  const thread = await chat.thread(principal, target.id);
  await chat.markRead(principal, target.id, thread.messages.at(-1)!.id);
  assert.equal(
    (await chat.list(principal)).find((c) => c.id === target.id)?.unreadCount,
    0,
  );
  const previewTime = at(1);
  await chat.saveInbox(position.bossAccountId, {
    fetchedAt: stamp(),
    conversations: [
      {
        geekId: target.geekId,
        candidateName: target.candidateName,
        bossJobId: 'test-job',
        preview: '未点开的原生新回复',
        unreadCount: 2,
        timeLabel: '刚刚',
        lastMessageAt: previewTime,
      },
    ],
  });
  const withPreview = (await chat.list(principal)).find(
    (c) => c.id === target.id,
  )!;
  assert.equal(withPreview.lastMessage, '未点开的原生新回复');
  assert.equal(withPreview.lastMessageAt, previewTime);
  assert.equal(withPreview.unreadCount, 2);
  await chat.saveInbox(position.bossAccountId, {
    fetchedAt: new Date(Date.now() - 60_000).toISOString(),
    conversations: [
      {
        ...inbox(0),
        geekId: target.geekId,
        preview: '过时的列表',
        unreadCount: 0,
      },
    ],
  });
  assert.equal(
    (await chat.list(principal)).find((c) => c.id === target.id)?.lastMessage,
    '未点开的原生新回复',
  );
  await save({
    messages: [
      {
        providerMessageId: 'service-notice',
        direction: 'inbound',
        kind: 'card',
        body: '服务提示',
        sentAt: at(),
        delivery: 'sent',
      },
    ],
  });
  await save({
    messages: [
      {
        providerMessageId: 'service-notice',
        direction: 'system',
        kind: 'system',
        body: '服务提示',
        sentAt: at(),
        delivery: 'sent',
      },
    ],
  });
  assert.equal(
    (await chat.list(principal)).find((c) => c.id === target.id)?.unreadCount,
    0,
  );
  assert.equal(
    (await chat.list(principal)).find((c) => c.id === target.id)?.lastMessage,
    '未点开的原生新回复',
  );
  await assert.rejects(
    save({ providerConversationId: 'different-conversation' }),
  );

  const candidateCount = (
    await sql`SELECT count(*)::int AS n FROM candidates`
  )[0]!.n;
  const nativeId = `native-${suffix}`;
  await chat.saveInbox(position.bossAccountId, {
    fetchedAt: stamp(),
    conversations: [
      inbox(1),
      inbox(2),
      {
        geekId: nativeId,
        candidateName: '仅在 BOSS 沟通过',
        bossJobId: 'test-job',
        positionName: position.name,
        preview: '新的候选人回复',
        lastMessageAt: at(),
        timeLabel: '刚刚',
        unreadCount: 3,
      },
      {
        geekId: `old-${suffix}`,
        candidateName: '八天前会话',
        preview: '旧消息',
        lastMessageAt: new Date(Date.now() - 8 * 86_400_000).toISOString(),
        timeLabel: '八天前',
        unreadCount: 9,
      },
      {
        geekId: `unknown-${suffix}`,
        candidateName: '没有可信日期',
        preview: '日期未知',
        timeLabel: '',
        unreadCount: 0,
      },
    ],
  });
  assert.equal(
    (await sql`SELECT count(*)::int AS n FROM candidates`)[0]!.n,
    candidateCount,
    'native conversations never create screening candidates',
  );
  const native = (await chat.targets(principal)).find(
    (t) => t.geekId === nativeId,
  )!;
  assert(native);
  assert.equal(native.candidateId, null);
  assert.equal(native.taskId, null);
  const countsBeforeResume = (await sql`SELECT (SELECT count(*) FROM candidates) AS candidates, (SELECT count(*) FROM tasks) AS tasks`)[0];
  assert.equal(await chat.onlineResume(principal,native.id),null);
  const resumeSnapshot = {geekId:native.geekId,capturedAt:new Date().toISOString(),screenshotPath:'/isolated/resume.png',text:'已通过英语专八',textStatus:'ready' as const};
  await chat.saveOnlineResume(principal,native.id,resumeSnapshot);
  assert.deepEqual(await chat.onlineResume(principal,native.id),resumeSnapshot);
  await assert.rejects(chat.saveOnlineResume(principal,native.id,{...resumeSnapshot,geekId:'wrong-person'}));
  await chat.saveOnlineResume(principal,native.id,{...resumeSnapshot,capturedAt:'2020-01-01T00:00:00.000Z',text:'stale'});
  assert.equal((await chat.onlineResume(principal,native.id))!.text,resumeSnapshot.text);
  assert.equal((await chat.onlineResumeRule(principal,native.id)).rule!.version,1);
  await assert.rejects(chat.onlineResume({...principal,role:'interviewer'},native.id));
  const now=new Date(),day=new Date(now.getTime()-86400000),hour=new Date(now.getTime()-3600000);
  const usage=await repository.resumeViewUsage(position.bossAccountId,day,hour);
  await chat.recordChatResumeView(position.bossAccountId,native.geekId);
  assert.equal((await repository.resumeViewUsage(position.bossAccountId,day,hour)).viewsToday,usage.viewsToday+1);
  assert.deepEqual((await sql`SELECT (SELECT count(*) FROM candidates) AS candidates, (SELECT count(*) FROM tasks) AS tasks`)[0],countsBeforeResume);
  const recent = await chat.list(principal);
  assert(recent.some((c) => c.id === native.id));
  assert.equal(recent.find((c) => c.id === native.id)!.unreadCount, 3);
  assert.equal(
    (await chat.targets(principal)).filter((t) => t.positionId === position.id)
      .length,
    5,
    'BOSS contacts need not have a successful platform greeting',
  );
  assert(
    !(await chat.targets(principal)).some(
      (t) => t.geekId === `old-${suffix}` || t.geekId === `unknown-${suffix}`,
    ),
  );
  await sql`UPDATE communication_threads SET preview_sent_at=now()-interval '8 days' WHERE id=${native.id}`;
  assert(!(await chat.list(principal)).some((t) => t.id === native.id));
  await chat.saveInbox(position.bossAccountId, {
    fetchedAt: stamp(),
    conversations: [
      {
        geekId: nativeId,
        candidateName: native.candidateName,
        bossJobId: 'test-job',
        preview: '旧会话收到新回复',
        lastMessageAt: at(),
        timeLabel: '刚刚',
        unreadCount: 4,
      },
    ],
  });
  assert(
    (await chat.list(principal)).some((t) => t.id === native.id),
    'a new reply brings an old conversation back',
  );
  await assert.rejects(chat.target(restricted, native.id));

  await sql`INSERT INTO position_members(position_id,user_id,member_role) VALUES(${position.id},${restricted.userId},'recruiter')`;
  assert.equal(
    (await chat.target(restricted, native.id)).geekId,
    nativeId,
    'assigned recruiters can read their native BOSS conversations',
  );
  const foreignDepartment = randomUUID(),
    foreignPosition = randomUUID(),
    foreignGeek = `foreign-${suffix}`,
    unboundGeek = `unbound-${suffix}`;
  await sql`INSERT INTO departments(id,slug,name) VALUES(${foreignDepartment},${`foreign-${suffix}`},'隔离的其他部门')`;
  await sql`INSERT INTO positions(id,boss_account_id,boss_job_id,name,owner_name,department_id)
    VALUES(${foreignPosition},${position.bossAccountId},'foreign-test-job','其他部门岗位','未分配',${foreignDepartment})`;
  await chat.saveInbox(position.bossAccountId, {
    fetchedAt: stamp(),
    conversations: [
      {
        geekId: foreignGeek,
        candidateName: '其他部门会话',
        bossJobId: 'foreign-test-job',
        positionName: '其他部门岗位',
        preview: '部门隔离',
        lastMessageAt: at(),
        timeLabel: '刚刚',
        unreadCount: 1,
      },
      {
        geekId: unboundGeek,
        candidateName: '尚未导入岗位的会话',
        bossJobId: 'unbound-test-job',
        preview: '原生会话',
        lastMessageAt: at(),
        timeLabel: '刚刚',
        unreadCount: 1,
      },
    ],
  });
  assert(
    !(await chat.targets(principal)).some((t) => t.geekId === foreignGeek),
    'a known job in another department is never treated as an unbound job',
  );
  const unbound = (await chat.targets(principal)).find(
    (t) => t.geekId === unboundGeek,
  )!;
  assert(
    unbound,
    'administrators can see unbound native jobs on their account',
  );
  await assert.rejects(chat.target(restricted, unbound.id));
  // A historic successful greeting must not bypass a later native job binding.
  await sql`UPDATE communication_threads SET boss_job_id='foreign-test-job' WHERE id=${target.id}`;
  await assert.rejects(chat.target(principal, target.id));
  await sql`UPDATE communication_threads SET boss_job_id='test-job' WHERE id=${target.id}`;

  const phrase = await chat.saveQuickReply(
    principal,
    '  请问你方便沟通的时间是？  ',
  );
  assert.equal(phrase.body, '请问你方便沟通的时间是？');
  assert.deepEqual(await chat.quickReplies(restricted), []);
  await assert.rejects(chat.saveQuickReply(restricted, '越权修改', phrase.id));
  await chat.deleteQuickReply(restricted, phrase.id);
  assert((await chat.quickReplies(principal)).some((p) => p.id === phrase.id));
  await chat.saveQuickReply(
    principal,
    '方便的话，请介绍一下相关经历。',
    phrase.id,
  );
  assert.equal(
    (await chat.quickReplies(principal))[0]!.body,
    '方便的话，请介绍一下相关经历。',
  );
  await chat.deleteQuickReply(principal, phrase.id);
  assert.deepEqual(await chat.quickReplies(principal), []);

  for (const [scopeType, scopeId] of [
    ['global', 'global'],
    ['department', principal.departmentId],
    ['position', position.id],
    ['task', task.id],
  ] as const)
    await ats.setContactControl(principal, {
      scopeType,
      scopeId,
      enabled: true,
      approvalRequired: false,
      policy: { testOnly: true },
      emergencyStop: false,
    });
  const key = randomUUID();
  const [one, two] = await Promise.all([
    chat.createOutgoing(principal, target.id, '谢谢你的回复。', key),
    chat.createOutgoing(principal, target.id, '谢谢你的回复。', key),
  ]);
  assert.equal(one.id, two.id);
  await assert.rejects(
    chat.createOutgoing(principal, target.id, '换掉的内容', key),
    /Idempotency-Key/,
  );
  await assert.rejects(
    chat.createOutgoing(principal, native.id, '另一会话', randomUUID()),
    /正在发送/,
  );
  let sent = 0;
  const dependencies = {
    repository: chat,
    open: async () => {},
    send: async (geekId: string, body: string) => {
      sent++;
      return {
        schemaVersion: 1 as const,
        kind: 'contact-provider-receipt' as const,
        actionKind: 'message' as const,
        candidateId: geekId,
        bodySha256: createHash('sha256').update(body).digest('hex'),
        clientMid: 'client-1',
        serverMid: `server-${sent}`,
        providerConversationId: 'test-conversation',
        acceptedAt: at(),
      };
    },
  };
  await sendQueuedBossChat(one.id, position.bossAccountId, dependencies);
  await sendQueuedBossChat(one.id, position.bossAccountId, dependencies);
  assert.equal(sent, 1);
  assert.equal((await chat.outgoing(one.id)).row.status, 'sent');
  const uncertain = await chat.createOutgoing(
    principal,
    target.id,
    '回执丢失的消息',
    randomUUID(),
  );
  await assert.rejects(
    sendQueuedBossChat(uncertain.id, position.bossAccountId, {
      ...dependencies,
      send: async () => {
        throw new Error('lost receipt');
      },
    }),
  );
  assert.equal((await chat.outgoing(uncertain.id)).row.status, 'uncertain');
  await assert.rejects(
    chat.createOutgoing(principal, target.id, '回执丢失的消息', randomUUID()),
    /待确认/,
  );

  await save();
  const wxKey = randomUUID();
  const [wx, wxDuplicate] = await Promise.all([
    chat.createWechatAction(principal, target.id, wxKey),
    chat.createWechatAction(principal, target.id, wxKey),
  ]);
  assert.equal(wx.id, wxDuplicate.id);
  await assert.rejects(
    chat.createOutgoing(
      principal,
      target.id,
      '交换中不能并发发送',
      randomUUID(),
    ),
    /微信交换/,
  );
  await assert.rejects(
    chat.createWechatAction(principal, native.id, wxKey),
    /Idempotency-Key/,
  );
  let exchanges = 0;
  const exchange = {
    repository: chat,
    exchange: async (
      geekId: string,
      hooks: { assertAuthorized(): Promise<void>; writeAttempted(): void },
    ) => {
      await hooks.assertAuthorized();
      hooks.writeAttempted();
      exchanges++;
      return {
        geekId,
        providerConversationId: 'test-conversation',
        acceptedAt: at(),
        evidence: 'native_pending' as const,
      };
    },
  };
  await sendQueuedBossWechat(wx.id, position.bossAccountId, exchange);
  await sendQueuedBossWechat(wx.id, position.bossAccountId, exchange);
  assert.equal(exchanges, 1);
  assert.equal(
    (await chat.thread(principal, target.id)).wechat?.state,
    'pending',
  );
  assert.equal(
    (await chat.createWechatAction(principal, target.id, randomUUID())).id,
    wx.id,
    'pending requests are not resent',
  );
  await chat.saveSnapshot(native, {
    ...snapshot,
    geekId: native.geekId,
    providerConversationId: 'native-thread',
    messages: [],
    fetchedAt: stamp(),
  });
  const wxUnknown = await chat.createWechatAction(
    principal,
    native.id,
    randomUUID(),
  );
  await assert.rejects(
    sendQueuedBossWechat(wxUnknown.id, position.bossAccountId, {
      ...exchange,
      exchange: async (_geekId, hooks) => {
        hooks.writeAttempted();
        throw new Error('lost native receipt');
      },
    }),
  );
  assert.equal(
    (await chat.outgoingWechat(wxUnknown.id)).row.status,
    'uncertain',
  );
  assert.equal(
    (await chat.createWechatAction(principal, native.id, randomUUID())).id,
    wxUnknown.id,
  );

  const blocked = await chat.createOutgoing(
    principal,
    target.id,
    '不应发送',
    randomUUID(),
  );
  await sql`INSERT INTO do_not_contact(candidate_id,reason,source,active) VALUES(${target.candidateId},'fixture','manual',true)`;
  await assert.rejects(
    sendQueuedBossChat(blocked.id, position.bossAccountId, dependencies),
  );
  assert.equal((await chat.outgoing(blocked.id)).row.status, 'failed');
  assert.equal(sent, 1);
  assert.equal(
    (await chat.list(principal)).find((c) => c.id === target.id)?.canReply,
    false,
  );
  const many = Array.from({ length: 70 }, (_, i) => ({
    ...snapshot.messages[0]!,
    providerMessageId: `page-${i}`,
    body: `历史消息${i}`,
    sentAt: at(150 - i),
  }));
  await save({ messages: many });
  const newest = await chat.thread(principal, target.id);
  assert(newest.hasOlder);
  assert.equal(newest.messages.length, 60);
  const older = await chat.thread(principal, target.id, newest.before!);
  assert(older.messages.length > 0);
  assert(
    !older.messages.some((m) => newest.messages.some((n) => m.id === n.id)),
  );
  console.log(
    JSON.stringify({
      ok: true,
      onlineResumeBindingAndQuota:true,
      nativeInboxWithoutPlatformGreeting: true,
      separateConversationsNoNewCandidates: true,
      sevenDayWindow: true,
      newReplyReappears: true,
      permissionIsolation: true,
      stableTargetBinding: true,
      unreadWithoutOpening: true,
      quickRepliesPrivate: true,
      messageIdempotency: true,
      wechatIdempotency: true,
      uncertainNotRetried: true,
      doNotContactRespected: true,
      historyPagination: true,
      realMessagesSent: 0,
      realWechatRequests: 0,
    }),
  );
} finally {
  await sql.end();
}
