import { createHash, randomUUID } from 'node:crypto';
import {
  recruitmentCaseInputSchema,
  recruitmentCaseUpdateSchema,
  recruitmentInterviewInputSchema,
  recruitmentOfferInputSchema,
  recruitmentOfferActionSchema,
  chatMessageBodySchema,
  type RecruitmentDelivery,
  type LifecycleCase,
  type LifecycleDetail,
  type LifecycleWorkspace,
} from '@boss-forge/contracts';
import {
  AuthorizationError,
  DepartmentAtsRepository,
  type SessionPrincipal,
} from './department-repository.js';
import { CommunicationRepository } from './communication-repository.js';
import type { Database } from './client.js';
import type { TransactionSql } from 'postgres';
import type {
  RecruitmentInterviewAction,
  RecruitmentOnboardingAction,
} from '@boss-forge/contracts';

type Tx = TransactionSql;
const day = (value: Date | string) =>
  typeof value === 'string'
    ? value.slice(0, 10)
    : value.toISOString().slice(0, 10);
const iso = (value: Date | string | null) =>
  value ? new Date(value).toISOString() : null;
const manager = (p: SessionPrincipal) =>
  ['admin', 'recruiting_lead'].includes(p.role);
const hr = (p: SessionPrincipal) => {
  if (!['admin', 'recruiting_lead', 'recruiter'].includes(p.role))
    throw new AuthorizationError('没有招聘跟进操作权限。');
};
const note = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 1000)
    throw new Error('请填写 1–1000 字的说明。');
  return value.trim();
};
const terminal = ['hired', 'rejected', 'withdrawn', 'no_show'];
export function renderLifecycleMessage(
  kind: 'interview' | 'offer',
  candidateName: string,
  positionName: string,
  record: Record<string, any>,
): string {
  const format = (v: string) =>
    new Date(v).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  return chatMessageBodySchema.parse(
    kind === 'interview'
      ? `${candidateName}，你好！邀请你参加「${positionName}」面试。时间：${format(record.starts_at)} 至 ${format(record.ends_at)}（北京时间）。地点/链接：${record.location}。请回复确认是否方便参加；如需改期请告诉我们。`
      : `${candidateName}，你好！我们向你发出「${positionName}」的录用邀请：税前月薪 ${Number(record.salary_monthly).toFixed(2)} 元人民币，按 ${record.salary_months} 薪约定；预计入职日期 ${day(record.start_date)}。${record.terms ? `补充约定：${record.terms}。` : ''}请在 ${format(record.expires_at)}（北京时间）前回复是否接受。本条为录用邀请，其他约定以双方确认的正式文件为准。`,
  );
}

export class LifecycleRepository {
  constructor(private readonly sql: Database) {}
  private map(r: Record<string, any>): LifecycleCase {
    return {
      id: r.id,
      candidateId: r.candidate_id,
      candidateName: r.candidate_name,
      positionId: r.position_id,
      positionName: r.position_name,
      conversationId: r.resolved_conversation_id ?? r.conversation_id,
      sourceStateId: r.source_state_id,
      ownerId: r.owner_id,
      ownerName: r.owner_name,
      stage: r.stage,
      reviewStatus: r.source_review_status ?? r.review_status,
      closeReason: r.close_reason,
      nextFollowupAt: iso(r.next_followup_at),
      followupNote: r.followup_note,
      version: r.version,
      updatedAt: iso(r.updated_at)!,
    };
  }
  async row(p: SessionPrincipal, id: string): Promise<Record<string, any>> {
    const ids = await new DepartmentAtsRepository(this.sql).positionIds(p);
    const [r] = await this
      .sql`SELECT c.*,COALESCE(c.conversation_id,native.id) AS resolved_conversation_id,person.display_name AS candidate_name,pos.name AS position_name,u.display_name AS owner_name,src.review_status AS source_review_status
      FROM recruitment_cases c JOIN candidates person ON person.id=c.candidate_id JOIN positions pos ON pos.id=c.position_id
      JOIN users u ON u.id=c.owner_id LEFT JOIN candidate_position_states src ON src.id=c.source_state_id LEFT JOIN communication_threads native ON native.candidate_id=c.candidate_id AND native.boss_account_id=pos.boss_account_id AND native.boss_job_id=pos.boss_job_id
      WHERE c.id=${id} AND pos.department_id=${p.departmentId} AND
      ((${p.role === 'interviewer'} AND EXISTS(SELECT 1 FROM recruitment_interviews i WHERE i.case_id=c.id AND ${p.userId}::uuid=ANY(i.interviewer_ids)))
        OR (${p.role !== 'interviewer'} AND c.position_id=ANY(${ids}::uuid[])))`;
    if (!r) throw new AuthorizationError('招聘档案不存在或没有访问权限。');
    return {
      ...r,
      conversation_id: r.resolved_conversation_id ?? r.conversation_id,
    };
  }
  private async owner(
    p: SessionPrincipal,
    positionId: string,
    ownerId: string,
  ) {
    const [u] = await this
      .sql`SELECT u.id FROM users u WHERE u.id=${ownerId} AND u.department_id=${p.departmentId} AND u.status='active'
      AND (u.role IN ('admin','recruiting_lead') OR (u.role='recruiter' AND EXISTS(SELECT 1 FROM position_members m WHERE m.user_id=u.id AND m.position_id=${positionId})))`;
    if (!u) throw new Error('负责人必须是有该岗位权限的在职招聘成员。');
  }
  private approved(row: Record<string, any>) {
    if ((row.source_review_status ?? row.review_status) !== 'approved')
      throw new Error('请先完成人工审核，再推进面试或录用。');
    if (terminal.includes(row.stage)) throw new Error('此招聘档案已经结束。');
  }
  private async lock(tx: Tx, row: Record<string, any>) {
    const [current] =
      await tx`SELECT version FROM recruitment_cases WHERE id=${row.id} FOR UPDATE`;
    if (current?.version !== row.version)
      throw new Error('招聘档案已变化，请刷新后重试。');
  }
  private async event(
    tx: Tx,
    p: SessionPrincipal,
    id: string,
    kind: string,
    body: string,
  ) {
    await tx`INSERT INTO recruitment_case_events(id,case_id,actor_id,kind,body) VALUES(${randomUUID()},${id},${p.userId},${kind},${body})`;
    await tx`INSERT INTO audit_logs(id,actor_id,action,resource_type,resource_id,payload) VALUES(${randomUUID()},${p.userId},${`recruitment.${kind}`},'recruitment_case',${id},${tx.json({ summary: body })})`;
    await tx`UPDATE recruitment_cases SET version=version+1,updated_at=now() WHERE id=${id}`;
  }
  private async stage(tx: Tx, row: Record<string, any>, stage: string) {
    await tx`UPDATE recruitment_cases SET stage=${stage} WHERE id=${row.id}`;
    if (row.source_state_id) {
      const legacy = ['withdrawn', 'no_show'].includes(stage)
        ? 'rejected'
        : stage;
      await tx`UPDATE candidate_position_states SET stage_key=${legacy},stage_updated_at=now(),updated_at=now(),version=version+1 WHERE id=${row.source_state_id} AND review_status='approved'`;
    }
  }
  async workspace(
    p: SessionPrincipal,
    query: { search?: string; stage?: string; offset?: number } = {},
  ): Promise<LifecycleWorkspace> {
    const ids = await new DepartmentAtsRepository(this.sql).positionIds(p),
      search = `%${(query.search ?? '').slice(0, 100)}%`,
      offset = Math.max(0, query.offset ?? 0);
    const scope = this
      .sql`pos.department_id=${p.departmentId} AND ((${p.role === 'interviewer'} AND EXISTS(SELECT 1 FROM recruitment_interviews i WHERE i.case_id=c.id AND ${p.userId}::uuid=ANY(i.interviewer_ids))) OR (${p.role !== 'interviewer'} AND c.position_id=ANY(${ids}::uuid[]))) AND (${query.stage ?? null}::text IS NULL OR c.stage=${query.stage ?? null}) AND (person.display_name ILIKE ${search} OR pos.name ILIKE ${search})`;
    const [rows, totals] = await Promise.all([
      this
        .sql`SELECT c.*,COALESCE(c.conversation_id,native.id) AS resolved_conversation_id,person.display_name AS candidate_name,pos.name AS position_name,u.display_name AS owner_name,src.review_status AS source_review_status FROM recruitment_cases c JOIN positions pos ON pos.id=c.position_id JOIN candidates person ON person.id=c.candidate_id JOIN users u ON u.id=c.owner_id LEFT JOIN candidate_position_states src ON src.id=c.source_state_id LEFT JOIN communication_threads native ON native.candidate_id=c.candidate_id AND native.boss_account_id=pos.boss_account_id AND native.boss_job_id=pos.boss_job_id WHERE ${scope} ORDER BY c.updated_at DESC,c.id LIMIT 50 OFFSET ${offset}`,
      this
        .sql`SELECT count(*)::int AS n FROM recruitment_cases c JOIN positions pos ON pos.id=c.position_id JOIN candidates person ON person.id=c.candidate_id WHERE ${scope}`,
    ]);
    const applications = rows.map((r) => this.map(r));
    const positions = await this
      .sql`SELECT id,name FROM positions WHERE id=ANY(${ids}::uuid[]) AND status='active' ORDER BY name`;
    const users = await this
      .sql`SELECT id,display_name AS name,role FROM users WHERE department_id=${p.departmentId} AND status='active' ORDER BY display_name`;
    const reminders =
      p.role === 'interviewer'
        ? await this
            .sql`SELECT i.id,i.case_id AS "caseId",person.display_name AS "candidateName",'即将面试' AS title,i.starts_at AS "dueAt" FROM recruitment_interviews i JOIN recruitment_cases c ON c.id=i.case_id JOIN candidates person ON person.id=c.candidate_id JOIN positions pos ON pos.id=c.position_id WHERE pos.department_id=${p.departmentId} AND ${p.userId}::uuid=ANY(i.interviewer_ids) AND i.status IN ('scheduled','confirmed') AND c.stage NOT IN ('hired','rejected','withdrawn','no_show') AND i.ends_at>now() AND i.starts_at<now()+interval '1 day' ORDER BY i.starts_at LIMIT 30`
        : await this
            .sql`SELECT c.id,c.id AS "caseId",person.display_name AS "candidateName",COALESCE(NULLIF(c.followup_note,''),'待跟进') AS title,c.next_followup_at AS "dueAt" FROM recruitment_cases c JOIN candidates person ON person.id=c.candidate_id WHERE c.position_id=ANY(${ids}::uuid[]) AND c.stage NOT IN ('hired','rejected','withdrawn','no_show') AND c.next_followup_at<=now()+interval '1 day' AND (${manager(p)} OR c.owner_id=${p.userId}) ORDER BY c.next_followup_at LIMIT 30`;
    if (p.role !== 'interviewer') {
      const automatic = await this
        .sql`SELECT o.id,c.id AS "caseId",person.display_name AS "candidateName",CASE WHEN o.status='pending_approval' THEN 'Offer 待审批' WHEN o.status='approved' THEN '录用邀请待发送' ELSE '跟进 Offer 答复' END AS title,CASE WHEN o.status='pending_approval' THEN o.updated_at ELSE o.expires_at END AS "dueAt" FROM recruitment_offers o JOIN recruitment_cases c ON c.id=o.case_id JOIN candidates person ON person.id=c.candidate_id WHERE c.position_id=ANY(${ids}::uuid[]) AND c.stage NOT IN ('hired','rejected','withdrawn','no_show') AND (${manager(p)} OR c.owner_id=${p.userId}) AND ((${manager(p)} AND o.status='pending_approval') OR (o.status IN ('approved','sent') AND o.expires_at<=now()+interval '1 day'))
        UNION ALL SELECT i.id,c.id AS "caseId",person.display_name AS "candidateName",CASE WHEN i.status='scheduled' THEN '面试临近，请确认候选人时间' ELSE '即将面试' END AS title,i.starts_at AS "dueAt" FROM recruitment_interviews i JOIN recruitment_cases c ON c.id=i.case_id JOIN candidates person ON person.id=c.candidate_id WHERE c.position_id=ANY(${ids}::uuid[]) AND c.stage NOT IN ('hired','rejected','withdrawn','no_show') AND (${manager(p)} OR c.owner_id=${p.userId}) AND i.status IN ('scheduled','confirmed') AND i.ends_at>now() AND i.starts_at<=now()+interval '1 day' ORDER BY "dueAt" LIMIT 30`;
      reminders.push(...automatic);
      reminders.sort(
        (a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime(),
      );
    }
    return {
      applications,
      total: totals[0]!.n,
      positions: positions.map((r) => ({ id: r.id, name: r.name })),
      users: users.map((r) => ({ id: r.id, name: r.name, role: r.role })),
      reminders: reminders.slice(0, 30).map((r) => ({
        ...r,
        dueAt: iso(r.dueAt)!,
      })) as LifecycleWorkspace['reminders'],
    };
  }
  async create(p: SessionPrincipal, raw: unknown): Promise<LifecycleDetail> {
    hr(p);
    const input = recruitmentCaseInputSchema.parse(raw);
    await new DepartmentAtsRepository(this.sql).assertPosition(
      p,
      input.positionId,
    );
    await this.owner(p, input.positionId, input.ownerId);
    const [position] = await this
      .sql`SELECT * FROM positions WHERE id=${input.positionId} AND status='active'`;
    if (!position) throw new Error('请选择仍在招聘的岗位。');
    let candidateId: string | null = null,
      conversationId: string | null = null,
      stateId: string | null = null,
      name = '',
      fingerprint = '',
      review = 'pending';
    if (input.conversationId) {
      const chat = await new CommunicationRepository(this.sql).target(
        p,
        input.conversationId,
      );
      const [native] = await this
        .sql`SELECT boss_job_id FROM communication_threads WHERE id=${chat.id}`;
      if (
        chat.bossAccountId !== position.boss_account_id ||
        (native?.boss_job_id &&
          position.boss_job_id &&
          native.boss_job_id !== position.boss_job_id)
      )
        throw new Error('会话所属 BOSS 岗位与选择岗位不一致。');
      candidateId = chat.candidateId;
      conversationId = chat.id;
      name = chat.candidateName;
      fingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            platform: 'boss',
            kind: 'boss_geek_id',
            value: chat.geekId.trim(),
          }),
        )
        .digest('hex');
    } else {
      const [state] = await this
        .sql`SELECT s.*,c.display_name FROM candidate_position_states s JOIN candidates c ON c.id=s.candidate_id WHERE s.id=${input.stateId!} AND s.position_id=${input.positionId}`;
      if (!state || state.review_status !== 'approved')
        throw new Error('请先在候选人审核中通过此人，再进入招聘跟进。');
      candidateId = state.candidate_id;
      stateId = state.id;
      name = state.display_name;
      review = 'approved';
      const [thread] = await this
        .sql`SELECT id FROM communication_threads WHERE candidate_id=${candidateId} AND boss_account_id=${position.boss_account_id} AND boss_job_id=${position.boss_job_id}`;
      conversationId = thread?.id ?? null;
    }
    const id = await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`recruitment:${candidateId ?? fingerprint}`},41))`;
      if (!candidateId) {
        const [person] =
          await tx`INSERT INTO candidates(id,fingerprint,display_name) VALUES(${randomUUID()},${fingerprint},${name}) ON CONFLICT(fingerprint) DO UPDATE SET updated_at=now() RETURNING id`;
        candidateId = person!.id;
      }
      if (conversationId)
        await tx`UPDATE communication_threads SET candidate_id=${candidateId} WHERE id=${conversationId} AND candidate_id IS NULL`;
      const [existing] =
        await tx`SELECT id FROM recruitment_cases WHERE candidate_id=${candidateId} AND position_id=${input.positionId}`;
      if (existing) {
        await tx`UPDATE recruitment_cases SET conversation_id=COALESCE(conversation_id,${conversationId}) WHERE id=${existing.id}`;
        return existing.id as string;
      }
      const next = randomUUID();
      await tx`INSERT INTO recruitment_cases(id,candidate_id,position_id,conversation_id,source_state_id,owner_id,created_by,review_status,stage)
        VALUES(${next},${candidateId},${input.positionId},${conversationId},${stateId},${input.ownerId},${p.userId},${review},${review === 'approved' ? 'communicating' : 'review'})`;
      await this.event(
        tx,
        p,
        next,
        'created',
        `${input.conversationId ? '从 BOSS 会话' : '从已审核候选人'}建档，关联岗位「${position.name}」。`,
      );
      return next;
    });
    return this.detail(p, id);
  }
  async context(
    p: SessionPrincipal,
    input: { conversationId?: string; stateId?: string },
  ) {
    hr(p);
    let candidateId: string | null = null,
      positionId: string | null = null,
      candidateName = '';
    if (input.conversationId) {
      const target = await new CommunicationRepository(this.sql).target(
        p,
        input.conversationId,
      );
      candidateId = target.candidateId;
      positionId = target.positionId;
      candidateName = target.candidateName;
    } else if (input.stateId) {
      const [state] = await this
        .sql`SELECT s.candidate_id,s.position_id,c.display_name FROM candidate_position_states s JOIN candidates c ON c.id=s.candidate_id WHERE s.id=${input.stateId}`;
      if (!state) throw new AuthorizationError('候选人不存在。');
      await new DepartmentAtsRepository(this.sql).assertPosition(
        p,
        state.position_id,
      );
      candidateId = state.candidate_id;
      positionId = state.position_id;
      candidateName = state.display_name;
    } else throw new Error('请选择候选人或会话。');
    const rows = await this
      .sql`SELECT id FROM recruitment_cases WHERE (conversation_id=${input.conversationId ?? null} OR (candidate_id=${candidateId} AND position_id=${positionId})) ORDER BY updated_at DESC`;
    const applications = [];
    for (const item of rows) {
      try {
        applications.push(this.map(await this.row(p, item.id)));
      } catch (error) {
        if (!(error instanceof AuthorizationError)) throw error;
      }
    }
    const workspace = await this.workspace(p);
    return {
      applications,
      positions: workspace.positions,
      users: workspace.users,
      candidateName,
      positionId,
    };
  }
  async detail(p: SessionPrincipal, id: string): Promise<LifecycleDetail> {
    const row = await this.row(p, id);
    const interviews = await this
      .sql`SELECT i.*,m.status AS invitation_status FROM recruitment_interviews i LEFT JOIN communication_messages m ON m.id=i.invitation_message_id WHERE i.case_id=${id} AND (${p.role !== 'interviewer'} OR ${p.userId}::uuid=ANY(i.interviewer_ids)) ORDER BY i.starts_at DESC`;
    const feedback = await this
      .sql`SELECT f.*,u.display_name FROM recruitment_interview_feedback f JOIN recruitment_interviews i ON i.id=f.interview_id JOIN users u ON u.id=f.reviewer_id WHERE i.case_id=${id}`;
    const restricted = p.role === 'interviewer';
    const events = restricted
      ? []
      : await this
          .sql`SELECT e.id,e.body,e.created_at,u.display_name FROM recruitment_case_events e JOIN users u ON u.id=e.actor_id WHERE e.case_id=${id} ORDER BY e.created_at DESC LIMIT 100`;
    const offers = restricted
      ? []
      : await this
          .sql`SELECT o.*,m.status AS delivery_status FROM recruitment_offers o LEFT JOIN communication_messages m ON m.id=o.delivery_message_id WHERE o.case_id=${id} ORDER BY o.created_at DESC`;
    const items = restricted
      ? []
      : await this
          .sql`SELECT * FROM recruitment_onboarding_items WHERE case_id=${id} ORDER BY created_at,id`;
    const [onboarding] = restricted
      ? []
      : await this
          .sql`SELECT * FROM recruitment_onboarding WHERE case_id=${id}`;
    return {
      application: this.map(row),
      events: events.map((r) => ({
        id: r.id,
        body: r.body,
        actorName: r.display_name,
        createdAt: iso(r.created_at)!,
      })),
      interviews: interviews.map((r) => ({
        id: r.id,
        startsAt: iso(r.starts_at)!,
        endsAt: iso(r.ends_at)!,
        location: r.location,
        interviewerIds: r.interviewer_ids,
        status: r.status,
        version: r.version,
        confirmationNote: r.confirmation_note,
        invitationStatus: r.invitation_status,
        feedback: feedback
          .filter((f) => f.interview_id === r.id)
          .map((f) => ({
            reviewerId: f.reviewer_id,
            reviewerName: f.display_name,
            recommendation: f.recommendation,
            score: f.score,
            body: f.body,
          })),
      })),
      offers: offers.map((r) => ({
        id: r.id,
        salaryMonthly: Number(r.salary_monthly),
        salaryMonths: r.salary_months,
        startDate: day(r.start_date),
        expiresAt: iso(r.expires_at)!,
        terms: r.terms,
        status: r.status,
        version: r.version,
        responseNote: r.response_note,
        deliveryStatus: r.delivery_status,
      })),
      onboardingItems: items.map((r) => ({
        id: r.id,
        title: r.title,
        required: r.required,
        completedAt: iso(r.completed_at),
        note: r.note,
      })),
      onboarding: onboarding
        ? {
            actualStartDate: onboarding.actual_start_date
              ? day(onboarding.actual_start_date)
              : null,
            note: onboarding.note,
          }
        : null,
    };
  }
  async update(p: SessionPrincipal, id: string, raw: unknown) {
    hr(p);
    const input = recruitmentCaseUpdateSchema.parse(raw),
      row = await this.row(p, id);
    if (input.ownerId) await this.owner(p, row.position_id, input.ownerId);
    if (input.review || input.close) note(input.note);
    if (input.review && input.close)
      throw new Error('请分别提交审核和结束操作。');
    if (input.review && row.review_status !== 'pending')
      throw new Error('审核已完成，不可覆盖原结论。');
    if (input.close === 'no_show') this.approved(row);
    if (input.review && row.source_state_id)
      throw new Error('此档案来自筛选，请在候选人审核页修改原审核结论。');
    if (terminal.includes(row.stage)) throw new Error('此招聘档案已经结束。');
    return this.sql
      .begin(async (tx) => {
        const [locked] =
          await tx`SELECT version FROM recruitment_cases WHERE id=${id} FOR UPDATE`;
        if (locked!.version !== input.version)
          throw new Error('档案已更新，请刷新后重试。');
        await tx`UPDATE recruitment_cases SET owner_id=${input.ownerId ?? row.owner_id},next_followup_at=${input.nextFollowupAt === undefined ? row.next_followup_at : input.nextFollowupAt},followup_note=${input.followupNote ?? row.followup_note} WHERE id=${id}`;
        if (input.review) {
          await tx`UPDATE recruitment_cases SET review_status=${input.review} WHERE id=${id}`;
          if (input.review === 'rejected')
            await tx`UPDATE recruitment_cases SET close_reason=${input.note!},next_followup_at=NULL WHERE id=${id}`;
          await this.stage(
            tx,
            row,
            input.review === 'approved' ? 'communicating' : 'rejected',
          );
        }
        if (input.close) {
          await this.stage(tx, row, input.close);
          await tx`UPDATE recruitment_cases SET close_reason=${input.note!},next_followup_at=NULL WHERE id=${id}`;
          await tx`UPDATE recruitment_interviews SET status='cancelled',confirmation_note=${input.note!},version=version+1 WHERE case_id=${id} AND status IN ('scheduled','confirmed')`;
          await tx`UPDATE recruitment_offers SET status='withdrawn',response_note=${input.note!},version=version+1,updated_at=now() WHERE case_id=${id} AND status IN ('draft','pending_approval','approved','sent')`;
        }
        await this.event(
          tx,
          p,
          id,
          input.review ? 'reviewed' : input.close ? 'closed' : 'followup',
          input.note ?? input.followupNote ?? '更新跟进负责人或提醒时间。',
        );
      })
      .then(() => this.detail(p, id));
  }
  async schedule(p: SessionPrincipal, id: string, raw: unknown) {
    hr(p);
    const row = await this.row(p, id);
    this.approved(row);
    const input = recruitmentInterviewInputSchema.parse(raw);
    if (
      row.stage === 'offer' &&
      (
        await this
          .sql`SELECT id FROM recruitment_offers WHERE case_id=${id} AND status NOT IN ('declined','withdrawn')`
      )[0]
    )
      throw new Error('当前已进入录用阶段，请先完成录用处理。');
    if (Date.parse(input.startsAt) <= Date.now())
      throw new Error('请选择未来的面试时间。');
    const users = await this
      .sql`SELECT id FROM users WHERE id=ANY(${input.interviewerIds}::uuid[]) AND department_id=${p.departmentId} AND status='active'`;
    if (users.length !== new Set(input.interviewerIds).size)
      throw new Error('面试官必须是本部门在职成员。');
    const next = randomUUID();
    await this.sql.begin(async (tx) => {
      await this.lock(tx, row);
      // Serialize a person's calendar across cases, not just a single candidate.
      for (const uid of [...new Set(input.interviewerIds)].sort())
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${uid},43))`;
      const conflict =
        await tx`SELECT id FROM recruitment_interviews WHERE status IN ('scheduled','confirmed') AND interviewer_ids && ${input.interviewerIds}::uuid[] AND starts_at<${input.endsAt}::timestamptz AND ends_at>${input.startsAt}::timestamptz`;
      if (conflict.length)
        throw new Error('面试官在这个时间已有面试，请调整时间。');
      await tx`INSERT INTO recruitment_interviews(id,case_id,starts_at,ends_at,location,interviewer_ids) VALUES(${next},${id},${input.startsAt},${input.endsAt},${input.location},${input.interviewerIds})`;
      await this.stage(tx, row, 'interview');
      await this.event(
        tx,
        p,
        id,
        'interview.scheduled',
        '面试已登记，等待发送邀请和候选人确认。',
      );
    });
    return this.detail(p, id);
  }
  async interview(
    p: SessionPrincipal,
    id: string,
    interviewId: string,
    input: RecruitmentInterviewAction,
  ) {
    const row = await this.row(p, id);
    this.approved(row);
    if (input.action !== 'feedback') hr(p);
    await this.sql.begin(async (tx) => {
      await this.lock(tx, row);
      const [i] =
        await tx`SELECT * FROM recruitment_interviews WHERE id=${interviewId} AND case_id=${id} FOR UPDATE`;
      if (!i) throw new Error('面试不存在。');
      if (input.action === 'feedback') {
        if (!manager(p) && !i.interviewer_ids.includes(p.userId))
          throw new AuthorizationError(
            '只有本场面试官或招聘负责人可以填写反馈。',
          );
        if (
          ['cancelled', 'no_show'].includes(i.status) ||
          new Date(i.starts_at).getTime() > Date.now()
        )
          throw new Error('面试尚未开始或已取消，暂不能提交反馈。');
        if (
          !['yes', 'mixed', 'no'].includes(input.recommendation ?? '') ||
          !Number.isInteger(input.score) ||
          input.score! < 1 ||
          input.score! > 5
        )
          throw new Error('请填写有效的面试建议和 1–5 分评分。');
        await tx`INSERT INTO recruitment_interview_feedback(interview_id,reviewer_id,recommendation,score,body) VALUES(${interviewId},${p.userId},${input.recommendation!},${input.score!},${note(input.body)}) ON CONFLICT(interview_id,reviewer_id) DO UPDATE SET recommendation=EXCLUDED.recommendation,score=EXCLUDED.score,body=EXCLUDED.body,updated_at=now()`;
      } else {
        if (i.version !== input.version)
          throw new Error('面试已更新，请刷新后重试。');
        if (
          !['confirm', 'cancel', 'complete', 'no_show'].includes(
            input.action,
          ) ||
          ['cancelled', 'completed', 'no_show'].includes(i.status)
        )
          throw new Error('当前面试状态不允许此操作。');
        note(input.note);
        if (
          ['complete', 'no_show'].includes(input.action) &&
          new Date(i.starts_at).getTime() > Date.now()
        )
          throw new Error('面试尚未开始。');
        if (
          input.action === 'complete' &&
          !(
            await tx`SELECT interview_id FROM recruitment_interview_feedback WHERE interview_id=${interviewId}`
          )[0]
        )
          throw new Error('请先提交面试反馈。');
        await tx`UPDATE recruitment_interviews SET status=${({ confirm: 'confirmed', cancel: 'cancelled', complete: 'completed', no_show: 'no_show' } as Record<string, string>)[input.action]!},confirmation_note=${input.note!},version=version+1 WHERE id=${interviewId}`;
      }
      await this.event(
        tx,
        p,
        id,
        `interview.${input.action}`,
        input.action === 'feedback' ? '已提交面试反馈。' : input.note!,
      );
    });
    return this.detail(p, row.id);
  }
  async createOffer(p: SessionPrincipal, id: string, raw: unknown) {
    hr(p);
    const row = await this.row(p, id);
    this.approved(row);
    const input = recruitmentOfferInputSchema.parse(raw);
    if (Date.parse(input.expiresAt) <= Date.now())
      throw new Error('Offer 有效期必须晚于当前时间。');
    const next = randomUUID();
    await this.sql.begin(async (tx) => {
      await this.lock(tx, row);
      if (
        (
          await tx`SELECT id FROM recruitment_offers WHERE case_id=${id} AND status NOT IN ('declined','withdrawn')`
        )[0]
      )
        throw new Error('已有进行中的 Offer，请先处理或撤回。');
      await tx`INSERT INTO recruitment_offers(id,case_id,salary_monthly,salary_months,start_date,expires_at,terms,created_by) VALUES(${next},${id},${input.salaryMonthly},${input.salaryMonths},${input.startDate},${input.expiresAt},${input.terms},${p.userId})`;
      await this.stage(tx, row, 'offer');
      await this.event(
        tx,
        p,
        id,
        'offer.drafted',
        '创建 Offer 草稿，尚未审批或发送。',
      );
    });
    return this.detail(p, id);
  }
  async offer(p: SessionPrincipal, id: string, offerId: string, raw: unknown) {
    hr(p);
    const row = await this.row(p, id);
    this.approved(row);
    const input = recruitmentOfferActionSchema.parse(raw);
    await this.sql.begin(async (tx) => {
      await this.lock(tx, row);
      const [offer] =
        await tx`SELECT * FROM recruitment_offers WHERE id=${offerId} AND case_id=${id} FOR UPDATE`;
      if (!offer || offer.version !== input.version)
        throw new Error('Offer 已更新，请刷新后重试。');
      const expected: Record<string, string[]> = {
        submit: ['draft'],
        approve: ['pending_approval'],
        return: ['pending_approval'],
        accept: ['sent'],
        decline: ['sent'],
        withdraw: ['draft', 'pending_approval', 'approved', 'sent'],
        revise: ['draft'],
      };
      if (!expected[input.action]!.includes(offer.status))
        throw new Error('当前 Offer 状态不允许此操作。');
      if (['approve', 'return'].includes(input.action) && !manager(p))
        throw new AuthorizationError('Offer 审批需要招聘负责人或管理员。');
      if (
        ['submit', 'approve', 'accept'].includes(input.action) &&
        new Date(offer.expires_at).getTime() <= Date.now()
      )
        throw new Error('Offer 已过期，请撤回后重新创建。');
      if (input.action !== 'submit') note(input.note);
      if (input.action === 'revise') {
        const changes = recruitmentOfferInputSchema.parse(input.changes);
        if (Date.parse(changes.expiresAt) <= Date.now())
          throw new Error('Offer 有效期必须晚于当前时间。');
        await tx`UPDATE recruitment_offers SET salary_monthly=${changes.salaryMonthly},salary_months=${changes.salaryMonths},start_date=${changes.startDate},expires_at=${changes.expiresAt},terms=${changes.terms},version=version+1,updated_at=now() WHERE id=${offerId}`;
        await this.event(tx, p, id, 'offer.revised', note(input.note));
        return;
      }
      if (input.responseMessageId) {
        const [proof] =
          await tx`SELECT id FROM communication_messages WHERE id=${input.responseMessageId} AND conversation_id=${row.conversation_id} AND direction='inbound' AND status='sent'`;
        if (!proof) throw new Error('候选人回复必须来自当前会话。');
      }
      const status = (
        {
          submit: 'pending_approval',
          approve: 'approved',
          return: 'draft',
          accept: 'accepted',
          decline: 'declined',
          withdraw: 'withdrawn',
        } as const
      )[input.action];
      await tx`UPDATE recruitment_offers SET status=${status},version=version+1,updated_at=now(),response_note=${input.note ?? ''},response_message_id=${input.responseMessageId ?? null},approved_by=CASE WHEN ${input.action === 'approve'} THEN ${p.userId}::uuid ELSE approved_by END,approved_at=CASE WHEN ${input.action === 'approve'} THEN now() ELSE approved_at END WHERE id=${offerId}`;
      if (input.action === 'accept') {
        await tx`INSERT INTO recruitment_onboarding(case_id) VALUES(${id}) ON CONFLICT DO NOTHING`;
        for (const title of [
          '确认入职日期',
          '收齐必要入职材料',
          '完成入职安排',
        ])
          await tx`INSERT INTO recruitment_onboarding_items(id,case_id,title) VALUES(${randomUUID()},${id},${title})`;
      }
      await this.event(
        tx,
        p,
        id,
        `offer.${input.action}`,
        input.action === 'accept'
          ? `HR 记录候选人接受：${input.note}`
          : input.action === 'decline'
            ? `HR 记录候选人拒绝：${input.note}`
            : (input.note ?? 'Offer 已提交审批。'),
      );
    });
    return this.detail(p, id);
  }
  async onboarding(
    p: SessionPrincipal,
    id: string,
    input: RecruitmentOnboardingAction,
  ) {
    hr(p);
    const row = await this.row(p, id);
    this.approved(row);
    if (
      !(
        await this
          .sql`SELECT id FROM recruitment_offers WHERE case_id=${id} AND status='accepted'`
      )[0]
    )
      throw new Error('请先记录候选人接受 Offer。');
    await this.sql.begin(async (tx) => {
      await this.lock(tx, row);
      if (input.action === 'add') {
        await tx`INSERT INTO recruitment_onboarding_items(id,case_id,title,required) VALUES(${randomUUID()},${id},${note(input.title)},${input.required ?? true})`;
      } else if (input.action === 'item') {
        const changed =
          await tx`UPDATE recruitment_onboarding_items SET completed_at=${input.completed ? new Date() : null},completed_by=${input.completed ? p.userId : null},note=${note(input.note)} WHERE id=${input.itemId!} AND case_id=${id} RETURNING id`;
        if (!changed.length) throw new Error('入职清单项目不存在。');
      } else if (input.action === 'confirm') {
        if (
          !input.actualStartDate ||
          !/^\d{4}-\d{2}-\d{2}$/.test(input.actualStartDate) ||
          !Number.isFinite(Date.parse(input.actualStartDate)) ||
          input.actualStartDate >
            new Date().toLocaleDateString('sv-SE', {
              timeZone: 'Asia/Shanghai',
            })
        )
          throw new Error('请填写已发生的实际入职日期。');
        if (
          (
            await tx`SELECT id FROM recruitment_onboarding_items WHERE case_id=${id} AND required AND completed_at IS NULL`
          )[0]
        )
          throw new Error('请先完成必需的入职清单。');
        await tx`UPDATE recruitment_onboarding SET actual_start_date=${input.actualStartDate},note=${note(input.note)},confirmed_by=${p.userId},confirmed_at=now() WHERE case_id=${id}`;
        await this.stage(tx, row, 'hired');
        await tx`UPDATE recruitment_cases SET next_followup_at=NULL WHERE id=${id}`;
      } else throw new Error('入职操作无效。');
      await this.event(
        tx,
        p,
        id,
        `onboarding.${input.action}`,
        input.note ?? input.title ?? '更新入职清单。',
      );
    });
    return this.detail(p, id);
  }
  async delivery(
    p: SessionPrincipal,
    id: string,
    delivery: RecruitmentDelivery,
    ownMessageId?: string,
  ) {
    hr(p);
    const row = await this.row(p, id);
    this.approved(row);
    if (!row.conversation_id)
      throw new Error('尚未关联 BOSS 会话，请先建立联系。');
    const [binding] = await this
      .sql`SELECT t.id FROM communication_threads t JOIN positions p ON p.id=${row.position_id} WHERE t.id=${row.conversation_id} AND t.boss_account_id=p.boss_account_id AND (t.boss_job_id IS NULL OR p.boss_job_id IS NULL OR t.boss_job_id=p.boss_job_id)`;
    if (!binding)
      throw new Error('会话当前岗位与招聘档案不一致，请重新核对关联。');
    const table =
      delivery.kind === 'offer'
        ? 'recruitment_offers'
        : 'recruitment_interviews';
    const [record] = await this.sql.unsafe(
      `SELECT * FROM ${table} WHERE id=$1 AND case_id=$2`,
      [delivery.recordId, id],
    );
    if (!record || record.version !== delivery.version)
      throw new Error('邀请内容已更新，请重新生成。');
    if (
      delivery.kind === 'offer' &&
      (record.status !== 'approved' ||
        new Date(record.expires_at).getTime() <= Date.now())
    )
      throw new Error('Offer 尚未批准、已发出或已过期。');
    if (
      delivery.kind === 'interview' &&
      (!['scheduled', 'confirmed'].includes(record.status) ||
        new Date(record.starts_at).getTime() <= Date.now())
    )
      throw new Error('此面试已开始或取消，请检查安排。');
    const messageId =
      record[
        delivery.kind === 'offer'
          ? 'delivery_message_id'
          : 'invitation_message_id'
      ];
    if (messageId && messageId !== ownMessageId) {
      const [m] = await this
        .sql`SELECT status FROM communication_messages WHERE id=${messageId}`;
      if (m && m.status !== 'failed')
        throw new Error('邀请已发送或结果待确认，请勿重复发送。');
    }
    return {
      conversationId: row.conversation_id as string,
      body: renderLifecycleMessage(
        delivery.kind,
        row.candidate_name,
        row.position_name,
        record,
      ),
      delivery,
      caseId: id,
    };
  }
}
