import assert from 'node:assert/strict';
import { evaluateCandidate } from '../../m1-core/src/index.js';
import { parseRuleConfig } from './index.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  createDatabase,
  assertIsolatedTestDatabase,
  DepartmentAtsRepository,
  BossForgeRepository,
  LifecycleRepository,
  CommunicationRepository,
  type SessionPrincipal,
} from './index.js';
import { sendQueuedBossChat } from '../../../apps/boss-worker/src/boss-communication.js';
import { sendQueuedBossWechat } from '../../../apps/boss-worker/src/boss-wechat.js';
assertIsolatedTestDatabase(process.env, { contactSideEffects: true });
const sql = createDatabase(),
  ats = new DepartmentAtsRepository(sql),
  repo = new BossForgeRepository(sql),
  life = new LifecycleRepository(sql),
  chat = new CommunicationRepository(sql);
try {
  await ats.ensureBootstrap({
    departmentName: '招聘闭环隔离测试',
    adminEmail: 'lifecycle-test@example.com',
    adminName: '闭环验收管理员',
    password: 'Lifecycle-Test-Only!',
  });
  const [u] = await sql`SELECT * FROM users WHERE role='admin' LIMIT 1`;
  const admin: SessionPrincipal = {
    userId: u!.id,
    departmentId: u!.department_id,
    email: u!.email,
    displayName: u!.display_name,
    role: 'admin',
  };
  const suffix = randomUUID(),
    accountId = `lifecycle-test-${suffix}`;
  const position = await repo.createPosition({
    bossAccountId: accountId,
    name: '闭环测试岗位',
    ownerName: admin.displayName,
  });
  await sql`UPDATE positions SET department_id=${admin.departmentId},owner_user_id=${admin.userId},boss_job_id='lifecycle-job' WHERE id=${position.id}`;
  const makeUser = async (role: 'recruiter' | 'interviewer') => {
    const user = (await ats.createUser(admin, {
      email: `${role}-${suffix}@example.com`,
      displayName: `测试${role}`,
      role,
      password: 'Lifecycle-Test-Only!',
    })) as { id: string };
    return { ...admin, userId: user.id, role };
  };
  const recruiter = await makeUser('recruiter'),
    interviewer = await makeUser('interviewer');
  const at = (hours = 0) =>
    new Date(Date.now() + hours * 3600_000).toISOString();
  const countBefore = (await sql`SELECT count(*)::int AS n FROM tasks`)[0]!.n;
  await chat.saveInbox(accountId, {
    fetchedAt: at(),
    conversations: [0, 1, 2].map((i) => ({
      geekId: `lifecycle-geek-${suffix}-${i}`,
      candidateName: `闭环示例${i}`,
      bossJobId: 'lifecycle-job',
      positionName: position.name,
      preview: '隔离验收',
      lastMessageAt: at(),
      timeLabel: '刚刚',
      unreadCount: 0,
    })),
  });
  const [target, other, third] = (await chat.targets(admin)).filter(
    (t) => t.bossAccountId === accountId,
  );
  assert(target && other && third);
  await assert.rejects(
    life.create(recruiter, {
      conversationId: target.id,
      positionId: position.id,
      ownerId: recruiter.userId,
    }),
  );
  await sql`INSERT INTO position_members(position_id,user_id,member_role) VALUES(${position.id},${recruiter.userId},'recruiter')`;
  let detail = await life.create(admin, {
    conversationId: target.id,
    positionId: position.id,
    ownerId: recruiter.userId,
  });
  const id = detail.application.id;
  const duplicate = await life.create(admin, {
    conversationId: target.id,
    positionId: position.id,
    ownerId: admin.userId,
  });
  assert.equal(id, duplicate.application.id);
  assert.equal(detail.application.reviewStatus, 'pending');
  assert.equal(detail.application.stage, 'review');
  assert.equal(
    (await sql`SELECT count(*)::int AS n FROM tasks`)[0]!.n,
    countBefore,
    'filing does not create screening tasks',
  );
  const expected = createHash('sha256')
    .update(
      JSON.stringify({
        platform: 'boss',
        kind: 'boss_geek_id',
        value: target.geekId,
      }),
    )
    .digest('hex');
  assert.equal(
    (
      await sql`SELECT fingerprint FROM candidates WHERE id=${detail.application.candidateId}`
    )[0]!.fingerprint,
    expected,
  );
  await assert.rejects(
    life.detail({ ...admin, departmentId: randomUUID() }, id),
  );
  await assert.rejects(life.detail(interviewer, id));
  const schedule = {
    startsAt: at(2),
    endsAt: at(3),
    location: '测试会议室',
    interviewerIds: [interviewer.userId],
  };
  await assert.rejects(life.schedule(admin, id, schedule), /人工审核/);
  await assert.rejects(
    life.update(admin, id, {
      version: 1,
      review: 'approved',
      note: '已人工核对相关经历',
    }),
    /刷新/,
  );
  detail = await life.update(recruiter, id, {
    version: detail.application.version,
    review: 'approved',
    note: '已人工核对相关经历',
    nextFollowupAt: at(0.5),
    followupNote: '确认面试时间',
  });
  assert(
    (await life.workspace(recruiter)).reminders.some((r) => r.caseId === id),
  );
  await assert.rejects(
    life.update(admin, id, {
      version: detail.application.version,
      review: 'approved',
      note: '覆盖结论',
    }),
    /审核已完成/,
  );
  detail = await life.schedule(admin, id, schedule);
  let interview = detail.interviews[0]!;
  let otherDetail = await life.create(admin, {
    conversationId: other.id,
    positionId: position.id,
    ownerId: admin.userId,
  });
  otherDetail = await life.update(admin, otherDetail.application.id, {
    version: otherDetail.application.version,
    review: 'approved',
    note: '人工通过',
  });
  await assert.rejects(
    life.schedule(admin, otherDetail.application.id, schedule),
    /已有面试/,
  );
  assert(
    (await life.workspace(interviewer)).applications.some((c) => c.id === id),
  );
  assert.equal((await life.detail(interviewer, id)).events.length, 0);
  const snapshot = {
    geekId: target.geekId,
    providerConversationId: `thread-${suffix}`,
    fetchedAt: at(),
    historyLimited: true,
    wechat: { state: 'available' as const, reason: '' },
    resume: { state: 'available' as const, reason: '' },
    messages: [
      {
        providerMessageId: 'contact-card',
        direction: 'inbound' as const,
        kind: 'card' as const,
        body: '对方分享的联系方式',
        sentAt: at(),
        delivery: 'sent' as const,
        assets: [
          {
            kind: 'file' as const,
            name: '示例简历.pdf',
            url: 'https://static.zhipin.com/example.pdf',
          },
        ],
      },
    ],
    contacts: [
      {
        kind: 'wechat' as const,
        value: 'test_wechat_01',
        providerMessageId: 'contact-card',
      },
    ],
  };
  await chat.saveSnapshot(await chat.target(admin, target.id), snapshot);
  const rich = await chat.thread(admin, target.id);
  assert.equal(rich.contacts?.[0]?.value, 'test_wechat_01');
  assert.equal(rich.messages[0]?.assets?.[0]?.name, '示例简历.pdf');
  assert(
    !JSON.stringify(rich).includes('https://'),
    'asset URLs do not leak into thread JSON',
  );
  await assert.rejects(
    chat.asset(
      { ...admin, departmentId: randomUUID() },
      target.id,
      rich.messages[0]!.id,
      0,
    ),
  );
  assert.equal(
    (await chat.asset(admin, target.id, rich.messages[0]!.id, 0)).name,
    '示例简历.pdf',
  );
  await assert.rejects(
    chat.saveSnapshot(await chat.target(admin, target.id), {
      ...snapshot,
      contacts: [
        {
          kind: 'phone',
          value: '13800000000',
          providerMessageId: 'other-thread-card',
        },
      ],
    }),
    /联系方式/,
  );
  for (const [scopeType, scopeId] of [
    ['global', 'global'],
    ['department', admin.departmentId],
    ['position', position.id],
  ] as const)
    await ats.setContactControl(admin, {
      scopeType,
      scopeId,
      enabled: true,
      approvalRequired: false,
      emergencyStop: false,
      policy: { testOnly: true },
    });
  let sends = 0;
  const dependencies = {
    repository: chat,
    open: async () => {},
    send: async (geekId: string, body: string) => ({
      schemaVersion: 1 as const,
      kind: 'contact-provider-receipt' as const,
      actionKind: 'message' as const,
      candidateId: geekId,
      bodySha256: createHash('sha256').update(body).digest('hex'),
      clientMid: 'test-client',
      serverMid: `lifecycle-sent-${++sends}`,
      providerConversationId: snapshot.providerConversationId,
      acceptedAt: at(),
    }),
  };
  const invite = await life.delivery(admin, id, {
    kind: 'interview',
    recordId: interview.id,
    version: interview.version,
  });
  await assert.rejects(
    chat.createOutgoing(admin, target.id, invite.body + '修改', randomUUID(), {
      ...invite.delivery,
      caseId: id,
    }),
    /内容|邀请/,
  );
  const outgoing = await chat.createOutgoing(
    admin,
    target.id,
    invite.body,
    randomUUID(),
    { ...invite.delivery, caseId: id },
  );
  await sendQueuedBossChat(outgoing.id, accountId, dependencies);
  assert.equal(sends, 1);
  await sendQueuedBossChat(outgoing.id, accountId, dependencies);
  assert.equal(sends, 1);
  await assert.rejects(life.delivery(admin, id, invite.delivery), /重复/);
  detail = await life.interview(admin, id, interview.id, {
    action: 'confirm',
    version: interview.version,
    note: 'HR 记录对方已确认时间',
  });
  interview = detail.interviews[0]!;
  await assert.rejects(
    life.interview(interviewer, id, interview.id, {
      action: 'feedback',
      recommendation: 'yes',
      score: 4,
      body: '面试证据',
    }),
    /尚未开始/,
  );
  await sql`UPDATE recruitment_interviews SET starts_at=now()-interval '2 hours',ends_at=now()-interval '1 hour' WHERE id=${interview.id}`;
  await assert.rejects(
    life.interview(admin, id, interview.id, {
      action: 'complete',
      version: interview.version,
      note: '面试完成',
    }),
    /反馈/,
  );
  await life.interview(interviewer, id, interview.id, {
    action: 'feedback',
    recommendation: 'yes',
    score: 4,
    body: '有同类项目经验，回答具体',
  });
  detail = await life.interview(admin, id, interview.id, {
    action: 'complete',
    version: interview.version,
    note: '完成结构化面试',
  });
  assert.equal(detail.interviews[0]!.status, 'completed');
  const startDate = new Date().toLocaleDateString('sv-SE', {
    timeZone: 'Asia/Shanghai',
  });
  const offerInput = {
    salaryMonthly: 12000,
    salaryMonths: 13,
    startDate,
    expiresAt: at(48),
    terms: '工作地点上海',
  };
  detail = await life.createOffer(recruiter, id, offerInput);
  let offer = detail.offers[0]!;
  assert.equal(offer.startDate, startDate);
  detail = await life.offer(recruiter, id, offer.id, {
    version: offer.version,
    action: 'submit',
  });
  offer = detail.offers[0]!;
  await assert.rejects(
    life.offer(recruiter, id, offer.id, {
      version: offer.version,
      action: 'approve',
      note: '批准',
    }),
    /负责人/,
  );
  detail = await life.offer(admin, id, offer.id, {
    version: offer.version,
    action: 'return',
    note: '调整月薪后重新审批',
  });
  offer = detail.offers[0]!;
  detail = await life.offer(recruiter, id, offer.id, {
    version: offer.version,
    action: 'revise',
    changes: { ...offerInput, salaryMonthly: 12500 },
    note: '按审批意见调整',
  });
  offer = detail.offers[0]!;
  assert.equal(offer.salaryMonthly, 12500);
  detail = await life.offer(recruiter, id, offer.id, {
    version: offer.version,
    action: 'submit',
  });
  offer = detail.offers[0]!;
  detail = await life.offer(admin, id, offer.id, {
    version: offer.version,
    action: 'approve',
    note: '预算确认，批准',
  });
  offer = detail.offers[0]!;
  await assert.rejects(life.schedule(admin, id, schedule), /录用阶段/);
  assert.equal(
    (await life.detail(interviewer, id)).offers.length,
    0,
    'interviewers cannot read compensation',
  );
  await assert.rejects(
    life.offer(admin, id, offer.id, {
      version: offer.version,
      action: 'accept',
      note: '未经发送不能确认',
    }),
    /状态/,
  );
  const offerDraft = await life.delivery(admin, id, {
    kind: 'offer',
    recordId: offer.id,
    version: offer.version,
  });
  assert(offerDraft.body.includes(startDate));
  const queued = await chat.createOutgoing(
    admin,
    target.id,
    offerDraft.body,
    randomUUID(),
    { ...offerDraft.delivery, caseId: id },
  );
  await sendQueuedBossChat(queued.id, accountId, dependencies);
  detail = await life.detail(admin, id);
  offer = detail.offers[0]!;
  assert.equal(offer.status, 'sent');
  const receipt = (await chat.outgoing(queued.id)).row.receipt;
  const eventsBefore = detail.events.length;
  await chat.finishOutgoing(queued.id, receipt);
  assert.equal(
    (await life.detail(admin, id)).events.length,
    eventsBefore,
    'receipt finalization is idempotent',
  );
  detail = await life.offer(recruiter, id, offer.id, {
    version: offer.version,
    action: 'accept',
    note: 'HR 已收到候选人明确接受答复',
    responseMessageId: rich.messages[0]!.id,
  });
  assert.equal(detail.onboardingItems.length, 3);
  await assert.rejects(
    life.onboarding(admin, id, {
      action: 'confirm',
      actualStartDate: startDate,
      note: '已入职',
    }),
    /必需/,
  );
  for (const item of detail.onboardingItems)
    detail = await life.onboarding(recruiter, id, {
      action: 'item',
      itemId: item.id,
      completed: true,
      note: '已核实必要事项',
    });
  detail = await life.onboarding(admin, id, {
    action: 'confirm',
    actualStartDate: startDate,
    note: '已实际到岗',
  });
  assert.equal(detail.application.stage, 'hired');
  assert.equal(detail.onboarding!.actualStartDate, startDate);
  await assert.rejects(
    life.interview(interviewer, id, interview.id, {
      action: 'feedback',
      recommendation: 'no',
      score: 1,
      body: '结束后不能改',
    }),
    /已经结束/,
  );
  // A queued offer is invalidated by withdrawal before the fake transport runs.
  const otherCase = otherDetail.application.id;
  otherDetail = await life.createOffer(admin, otherCase, offerInput);
  let otherOffer = otherDetail.offers[0]!;
  otherDetail = await life.offer(admin, otherCase, otherOffer.id, {
    version: otherOffer.version,
    action: 'submit',
  });
  otherOffer = otherDetail.offers[0]!;
  otherDetail = await life.offer(admin, otherCase, otherOffer.id, {
    version: otherOffer.version,
    action: 'approve',
    note: '批准',
  });
  otherOffer = otherDetail.offers[0]!;
  const stale = await life.delivery(admin, otherCase, {
    kind: 'offer',
    recordId: otherOffer.id,
    version: otherOffer.version,
  });
  const staleQueued = await chat.createOutgoing(
    admin,
    other.id,
    stale.body,
    randomUUID(),
    { ...stale.delivery, caseId: otherCase },
  );
  await life.offer(admin, otherCase, otherOffer.id, {
    version: otherOffer.version,
    action: 'withdraw',
    note: '需修订条件，撤回旧版',
  });
  await assert.rejects(
    sendQueuedBossChat(staleQueued.id, accountId, dependencies),
    /更新|过期|批准/,
  );
  assert.equal(sends, 2);
  assert.equal((await chat.outgoing(staleQueued.id)).row.status, 'failed');
  otherDetail = await life.schedule(admin, otherCase, {
    ...schedule,
    startsAt: at(5),
    endsAt: at(6),
  });
  otherDetail = await life.update(admin, otherCase, {
    version: otherDetail.application.version,
    close: 'withdrawn',
    note: '候选人退出招聘',
  });
  assert.equal(otherDetail.interviews[0]!.status, 'cancelled');
  assert(
    !(await life.workspace(admin)).reminders.some(
      (r) => r.caseId === otherCase,
    ),
  );
  // WeChat and resume have independent idempotency, and only native receipts count.
  const actionKey = randomUUID();
  const resumeAction = await chat.createWechatAction(
    admin,
    target.id,
    actionKey,
    'resume',
  );
  assert.equal(
    (await chat.createWechatAction(admin, target.id, actionKey, 'resume')).id,
    resumeAction.id,
  );
  await assert.rejects(
    chat.createWechatAction(admin, target.id, actionKey, 'wechat'),
    /Idempotency/,
  );
  let native = 0;
  await sendQueuedBossWechat(resumeAction.id, accountId, {
    repository: chat,
    exchange: async (geekId, hooks, kind) => {
      assert.equal(kind, 'resume');
      await hooks.assertAuthorized();
      hooks.writeAttempted();
      native++;
      return {
        geekId,
        providerConversationId: snapshot.providerConversationId,
        acceptedAt: at(),
        evidence: 'native_pending',
      };
    },
  });
  assert.equal(native, 1);
  assert.equal((await chat.thread(admin, target.id)).resume?.state, 'pending');
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
  await repo.createRuleVersion({
    positionId: position.id,
    name: '原流程衔接验收',
    config,
    dictionaryVersion: 'test',
    createdBy: admin.userId,
  });
  await repo.createImmediateTask({
    positionId: position.id,
    idempotencyKey: randomUUID(),
    source: 'recommend',
    createdBy: admin.userId,
    candidateLimit: 1,
  });
  const task = await repo.claimNextTask('lifecycle-legacy-test', accountId);
  assert(task);
  await repo.completeTask(
    task,
    [
      evaluateCandidate(
        {
          index: 1,
          name: '原流程候选人',
          source: 'recommend',
          sourceLocator: {
            kind: 'boss_geek_id',
            value: `legacy-geek-${suffix}`,
          },
          fields: {},
          evidence: [],
          raw: '隔离测试简历',
        },
        config,
      ),
    ],
    position.name,
  );
  const screening = await repo.claimNextResumeScreening(
    'lifecycle-legacy-test',
    accountId,
  );
  assert(screening);
  await repo.completeResumeScreening({
    job: screening,
    record: evaluateCandidate(screening.candidate, config, '隔离测试完整简历'),
    screenshotPath: null,
    resumeTextHash: 'test-lifecycle-legacy',
    workerId: 'lifecycle-legacy-test',
  });
  const [source] =
    await sql`SELECT id,version FROM candidate_position_states WHERE position_id=${position.id} LIMIT 1`;
  assert(source);
  await repo.reviewCandidate({
    stateId: source.id,
    idempotencyKey: randomUUID(),
    decision: 'approved',
    note: '人工核实相关经历',
    correctionCode: 'other',
    reviewerId: admin.userId,
    expectedVersion: source.version,
  });
  const linked = await life.create(admin, {
    stateId: source.id,
    positionId: position.id,
    ownerId: admin.userId,
  });
  assert.equal(linked.application.sourceStateId, source.id);
  await assert.rejects(ats.moveStage(admin, source.id, 'hired'), /招聘跟进/);
  assert.equal(linked.application.conversationId, null);
  await chat.saveInbox(accountId, {
    fetchedAt: at(),
    conversations: [
      {
        geekId: `legacy-geek-${suffix}`,
        candidateName: '原流程候选人',
        bossJobId: 'lifecycle-job',
        preview: '新建立联系',
        lastMessageAt: at(),
        timeLabel: '刚刚',
        unreadCount: 1,
      },
    ],
  });
  const lateConversation = (await life.detail(admin, linked.application.id))
    .application.conversationId;
  assert(
    lateConversation,
    'a conversation created after filing is linked by exact candidate/account/job',
  );
  assert.equal(
    (await life.workspace(admin)).applications.find(
      (c) => c.id === linked.application.id,
    )?.conversationId,
    lateConversation,
  );
  const [freshSource] =
    await sql`SELECT version FROM candidate_position_states WHERE id=${source.id}`;
  await assert.rejects(
    repo.reviewCandidate({
      stateId: source.id,
      idempotencyKey: randomUUID(),
      decision: 'rejected',
      note: '不能从旧入口覆盖后续流程',
      correctionCode: 'other',
      reviewerId: admin.userId,
      expectedVersion: freshSource!.version,
    }),
    /招聘跟进/,
  );
  console.log(
    'PASS: filing, human review, role/department isolation, reminders, interview conflicts/invitation/feedback, Offer revision/approval/receipt/acceptance, onboarding, stale-send prevention, attachment authorization, shared contacts, native resume action. Synthetic transports only.',
  );
} finally {
  await sql.end();
}
