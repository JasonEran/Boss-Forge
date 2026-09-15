import { createHash, randomUUID } from 'node:crypto';
import {
  bossChatOnlineResumeSchema,
  type BossChatOnlineResume,
  bossChatInboxSchema,
  bossChatAssetSchema,
  type BossChatAsset,
  bossChatSnapshotSchema,
  bossWechatCapabilitySchema,
  bossWechatReceiptSchema,
  chatMessageBodySchema,
  communicationSince,
  contactSourceLocatorSha256,
  type BossChatInbox,
  type BossChatSnapshot,
  type BossWechatReceipt,
  type CommunicationConversation,
  type CommunicationMessage,
  type CommunicationThread,
  type CommunicationQuickReply,
  type CommunicationWechatAction,
} from '@boss-forge/contracts';
import type { Database } from './client.js';
import {
  recruitmentMessageContextSchema,
  type RecruitmentMessageContext,
} from '@boss-forge/contracts';
import {
  AuthorizationError,
  DepartmentAtsRepository,
  type SessionPrincipal,
} from './department-repository.js';

export type CommunicationTarget = {
  id: string;
  candidateId: string | null;
  candidateName: string;
  positionId: string | null;
  positionName: string;
  stateId: string | null;
  taskId: string | null;
  bossAccountId: string;
  geekId: string;
  lastContactAt: Date;
  lastContactBody: string;
};
const iso = (value: Date | string) => new Date(value).toISOString();
const allowedRole = (principal: SessionPrincipal) => {
  if (!['admin', 'recruiting_lead', 'recruiter'].includes(principal.role))
    throw new AuthorizationError('没有实时沟通权限。');
};

export class CommunicationRepository {
  constructor(private readonly sql: Database) {}

  async onlineResume(principal: SessionPrincipal, id: string) {
    const target = await this.target(principal, id);
    const rows = await this.sql`SELECT snapshot FROM communication_online_resumes
      WHERE conversation_id = ${id} AND boss_account_id = ${target.bossAccountId} AND geek_id = ${target.geekId}`;
    return rows[0] ? bossChatOnlineResumeSchema.parse(rows[0].snapshot) : null;
  }

  async saveOnlineResume(principal: SessionPrincipal, id: string, snapshot: BossChatOnlineResume) {
    const target = await this.target(principal, id);
    const value = bossChatOnlineResumeSchema.parse(snapshot);
    if (value.geekId !== target.geekId) throw new Error('在线简历身份不一致。');
    await this.sql`INSERT INTO communication_online_resumes (conversation_id, boss_account_id, geek_id, snapshot, captured_at)
      VALUES (${id}, ${target.bossAccountId}, ${target.geekId}, ${this.sql.json(value)}, ${value.capturedAt})
      ON CONFLICT (conversation_id) DO UPDATE SET snapshot = EXCLUDED.snapshot, captured_at = EXCLUDED.captured_at,
        boss_account_id = EXCLUDED.boss_account_id, geek_id = EXCLUDED.geek_id, analysis_claim_id = NULL, analysis_claimed_at = NULL
      WHERE communication_online_resumes.captured_at < EXCLUDED.captured_at`;
  }

  async queueOnlineResumeAnalysis(principal: SessionPrincipal, id: string) {
    const target=await this.target(principal,id);
    const rows=await this.sql`UPDATE communication_online_resumes SET
      snapshot=snapshot || jsonb_build_object('textStatus','pending','analysisError',NULL,'analysisVersion',COALESCE((snapshot->>'analysisVersion')::int,0)+1),
      analysis_claim_id=NULL, analysis_claimed_at=NULL
      WHERE conversation_id=${id} AND boss_account_id=${target.bossAccountId} AND geek_id=${target.geekId}
        AND snapshot->>'textStatus' IN ('unavailable','skipped') RETURNING conversation_id`;
    if(!rows.length && !await this.onlineResume(principal,id))throw new Error('请先获取在线简历截图。');
  }

  /** Workers claim saved images only; no BOSS session or chat lease is used. */
  async claimOnlineResumeAnalysis(accountId: string) {
    const claimId=randomUUID();
    const rows=await this.sql`WITH pending AS (
      SELECT conversation_id FROM communication_online_resumes WHERE boss_account_id=${accountId}
        AND (snapshot->>'textStatus'='pending' OR (snapshot->>'textStatus'='processing' AND analysis_claimed_at < now()-interval '2 minutes'))
      ORDER BY captured_at FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE communication_online_resumes r SET
      analysis_claim_id=${claimId},analysis_claimed_at=now(),
      snapshot=r.snapshot || jsonb_build_object('textStatus','processing','analysisVersion',COALESCE((r.snapshot->>'analysisVersion')::int,0)+1)
      FROM pending WHERE r.conversation_id=pending.conversation_id
      RETURNING r.conversation_id,r.snapshot`;
    return rows[0]?{conversationId:String(rows[0].conversation_id),accountId,claimId,snapshot:bossChatOnlineResumeSchema.parse(rows[0].snapshot)}:null;
  }

  async renewOnlineResumeAnalysis(job: {conversationId:string;accountId:string;claimId:string}) {
    const rows=await this.sql`UPDATE communication_online_resumes SET analysis_claimed_at=now()
      WHERE conversation_id=${job.conversationId} AND boss_account_id=${job.accountId} AND analysis_claim_id=${job.claimId}
        AND snapshot->>'textStatus'='processing' RETURNING conversation_id`;
    return rows.length===1;
  }

  async finishOnlineResumeAnalysis(job: {conversationId:string;accountId:string;claimId:string;snapshot:BossChatOnlineResume}, result: {text:string;error?:string}) {
    const text=result.text.slice(0,100000);
    const rows=await this.sql`UPDATE communication_online_resumes SET
      snapshot=snapshot || jsonb_build_object('text',${text}::text,'textStatus',${text?'ready':'unavailable'}::text,
        'analysisError',${result.error?.slice(0,500) ?? null}::text,'analysisVersion',COALESCE((snapshot->>'analysisVersion')::int,0)+1),
      analysis_claim_id=NULL,analysis_claimed_at=NULL
      WHERE conversation_id=${job.conversationId} AND boss_account_id=${job.accountId} AND geek_id=${job.snapshot.geekId}
        AND captured_at=${job.snapshot.capturedAt} AND snapshot->>'screenshotPath'=${job.snapshot.screenshotPath}
        AND analysis_claim_id=${job.claimId} AND snapshot->>'textStatus'='processing' RETURNING conversation_id`;
    return rows.length===1;
  }

  async onlineResumeRule(principal: SessionPrincipal, id: string) {
    let target = await this.target(principal, id);
    if (!target.positionId) {
      const positions = await this.positions(principal);
      const cases = await this.sql`SELECT DISTINCT p.id,p.name FROM recruitment_cases c JOIN positions p ON p.id=c.position_id
        WHERE c.conversation_id=${id} AND p.boss_account_id=${target.bossAccountId} AND p.id=ANY(${positions.map(p=>p.id)}::uuid[])`;
      if (cases.length === 1) target = {...target,positionId:cases[0]!.id,positionName:cases[0]!.name};
    }
    const rows = target.positionId ? await this.sql`SELECT rv.version, rv.config FROM rule_sets rs
      JOIN rule_versions rv ON rv.id = rs.active_version_id WHERE rs.position_id = ${target.positionId}` : [];
    return { target, rule: rows[0] ? { version: Number(rows[0].version), config: rows[0].config as import('./types.js').RuleConfig } : null };
  }

  /** Same audit action as screening, so account view quotas include chat views. Caller holds the account lock. */
  async recordChatResumeView(accountId: string, geekId: string) {
    await this.sql`INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
      VALUES (${randomUUID()}, 'communication-worker', 'candidate.resume_viewed', 'boss_chat', ${geekId},
        ${this.sql.json({bossAccountId: accountId, geekId, source: 'communication'})})`;
  }

  private async positions(principal: SessionPrincipal) {
    allowedRole(principal);
    const ids = await new DepartmentAtsRepository(this.sql).positionIds(
      principal,
    );
    return ids.length
      ? this
          .sql`SELECT id, boss_account_id, boss_job_id, name, department_id FROM positions WHERE id = ANY(${ids}::uuid[])`
      : [];
  }

  async assertInboxAccess(
    principal: SessionPrincipal,
    accountId: string,
  ): Promise<void> {
    if (
      !(await this.positions(principal)).some(
        (p) => p.boss_account_id === accountId,
      )
    )
      throw new AuthorizationError('没有此 BOSS 账号的沟通权限。');
  }

  /** Existing successful contacts retain their original position/task controls. */
  private async contactTargets(
    principal: SessionPrincipal,
  ): Promise<CommunicationTarget[]> {
    const positions = await this.positions(principal);
    if (!positions.length) return [];
    const rows = await this.sql`
      SELECT DISTINCT ON (c.id) c.id, c.display_name, p.id AS position_id, p.name AS position_name,
        cps.id AS state_id, ci.task_id, p.boss_account_id, snapshot.source_locator,
        ci.policy_snapshot->'contactPreviewApproval' AS approval,
        COALESCE(ci.finished_at, ci.created_at) AS contacted_at, ci.rendered_message
      FROM contact_intents ci JOIN candidate_position_states cps ON cps.id = ci.candidate_position_state_id
      JOIN candidates c ON c.id = cps.candidate_id JOIN positions p ON p.id = cps.position_id
      JOIN candidate_snapshots snapshot ON snapshot.id = cps.latest_snapshot_id
      WHERE ci.status = 'sent' AND ci.transport_mode = 'real' AND p.id = ANY(${positions.map((p) => p.id)}::uuid[])
        AND snapshot.source_locator->>'kind' = 'boss_geek_id'
        AND snapshot.source_locator->>'value' ~ '^[A-Za-z0-9_~-]{8,160}$'
      ORDER BY c.id, ci.finished_at DESC NULLS LAST, ci.created_at DESC
    `;
    return rows.flatMap((row) => {
      const locator = row.source_locator as {
        kind: 'boss_geek_id';
        value: string;
      };
      const approval = row.approval as {
        bossAccountId?: string;
        sourceLocatorSha256?: string;
      } | null;
      if (
        approval &&
        (approval.bossAccountId !== row.boss_account_id ||
          approval.sourceLocatorSha256 !== contactSourceLocatorSha256(locator))
      )
        return [];
      return [
        {
          id: row.id,
          candidateId: row.id,
          candidateName: row.display_name,
          positionId: row.position_id,
          positionName: row.position_name,
          stateId: row.state_id,
          taskId: row.task_id,
          bossAccountId: row.boss_account_id,
          geekId: locator.value,
          lastContactAt: row.contacted_at,
          lastContactBody: row.rendered_message,
        },
      ];
    });
  }

  async targets(principal: SessionPrincipal): Promise<CommunicationTarget[]> {
    const positions = await this.positions(principal);
    if (!positions.length) return [];
    const accounts = [...new Set(positions.map((p) => p.boss_account_id))];
    const contacts = await this.contactTargets(principal);
    const rows = await this
      .sql`SELECT * FROM communication_threads WHERE boss_account_id = ANY(${accounts}::text[])`;
    // An unbound BOSS job is visible only to the account's administrator. A job
    // assigned to a different department is never treated as an unbound job.
    const bindings = await this
      .sql`SELECT id, boss_account_id, boss_job_id FROM positions WHERE boss_account_id = ANY(${accounts}::text[])`;
    return rows.flatMap((row) => {
      const contact = contacts.find(
        (c) =>
          c.bossAccountId === row.boss_account_id && c.geekId === row.geek_id,
      );
      const position = positions.find(
        (p) =>
          p.boss_account_id === row.boss_account_id &&
          p.boss_job_id &&
          p.boss_job_id === row.boss_job_id,
      );
      const knownElsewhere =
        row.boss_job_id &&
        bindings.some(
          (p) =>
            p.boss_account_id === row.boss_account_id &&
            p.boss_job_id === row.boss_job_id,
        );
      if (knownElsewhere && !position) return [];
      if (!contact && !position && principal.role !== 'admin') return [];
      return [
        {
          id: row.id,
          candidateId: row.candidate_id ?? contact?.candidateId ?? null,
          candidateName:
            row.candidate_name || contact?.candidateName || 'BOSS 候选人',
          positionId: contact?.positionId ?? position?.id ?? null,
          positionName:
            row.position_name ||
            contact?.positionName ||
            position?.name ||
            'BOSS 沟通',
          stateId: contact?.stateId ?? null,
          taskId: contact?.taskId ?? null,
          bossAccountId: row.boss_account_id,
          geekId: row.geek_id,
          lastContactAt:
            row.preview_sent_at ?? contact?.lastContactAt ?? new Date(0),
          lastContactBody: row.preview || contact?.lastContactBody || '',
        },
      ];
    });
  }

  async target(
    principal: SessionPrincipal,
    id: string,
  ): Promise<CommunicationTarget> {
    const target = (await this.targets(principal)).find(
      (item) => item.id === id,
    );
    if (!target) throw new AuthorizationError('会话不存在或没有访问权限。');
    return target;
  }

  private async conversations(
    principal: SessionPrincipal,
    targets: CommunicationTarget[],
  ): Promise<CommunicationConversation[]> {
    if (!targets.length) return [];
    const rows = await this.sql`
      SELECT t.id, t.synced_at, t.inbox_synced_at, t.preview, t.preview_sent_at, t.unread_count, latest.body, latest.sent_at,
        (SELECT count(*)::int FROM communication_messages m WHERE m.conversation_id = t.id AND m.direction = 'inbound'
          AND m.received_at > COALESCE(r.read_through, '-infinity'::timestamptz)) AS local_unread,
        EXISTS(SELECT 1 FROM do_not_contact d WHERE d.active AND (d.candidate_id = t.candidate_id OR d.candidate_id IN (
          SELECT cps.candidate_id FROM candidate_position_states cps JOIN positions p ON p.id = cps.position_id
          JOIN candidate_snapshots s ON s.id = cps.latest_snapshot_id WHERE p.boss_account_id = t.boss_account_id
          AND s.source_locator->>'kind' = 'boss_geek_id' AND s.source_locator->>'value' = t.geek_id))) AS dnc
      FROM communication_threads t LEFT JOIN communication_reads r ON r.conversation_id = t.id AND r.user_id = ${principal.userId}
      LEFT JOIN LATERAL (SELECT body, sent_at FROM communication_messages WHERE conversation_id = t.id AND direction <> 'system' AND status = 'sent'
        ORDER BY sent_at DESC, id DESC LIMIT 1) latest ON true
      WHERE t.id = ANY(${targets.map((t) => t.id)}::uuid[])
    `;
    return targets
      .map((target) => {
        const row = rows.find((item) => item.id === target.id)!;
        const previewIsNewer =
          row.preview_sent_at &&
          (!row.sent_at ||
            new Date(row.preview_sent_at) >= new Date(row.sent_at));
        return {
          id: target.id,
          candidateName: target.candidateName,
          positionId: target.positionId,
          positionName: target.positionName,
          lastMessage:
            (previewIsNewer ? row.preview : (row.body ?? row.preview)) ||
            target.lastContactBody,
          lastMessageAt: iso(
            previewIsNewer
              ? row.preview_sent_at
              : (row.sent_at ?? target.lastContactAt),
          ),
          unreadCount: Math.max(row.local_unread ?? 0, row.unread_count ?? 0),
          syncedAt: row.synced_at ? iso(row.synced_at) : null,
          inboxSyncedAt: row.inbox_synced_at ? iso(row.inbox_synced_at) : null,
          canReply: !row.dnc,
          replyBlockedReason: row.dnc ? '此候选人已设为禁止联系。' : null,
        };
      })
      .sort(
        (a, b) =>
          b.lastMessageAt.localeCompare(a.lastMessageAt) ||
          a.id.localeCompare(b.id),
      );
  }

  async list(
    principal: SessionPrincipal,
  ): Promise<CommunicationConversation[]> {
    const cutoff = communicationSince();
    return (
      await this.conversations(principal, await this.targets(principal))
    ).filter((c) => c.lastMessageAt >= cutoff);
  }

  async thread(
    principal: SessionPrincipal,
    id: string,
    before?: string,
  ): Promise<CommunicationThread> {
    const target = await this.target(principal, id);
    await this.expireOutgoing(target.bossAccountId);
    const conversation = (await this.conversations(principal, [target]))[0]!;
    const rows = await this.sql`
      SELECT id, direction, kind, body, status, error, sent_at, received_at, assets, provider_message_id
      FROM communication_messages WHERE conversation_id = ${id}
      AND (${before ?? null}::uuid IS NULL OR (sent_at, id) <
        (SELECT sent_at, id FROM communication_messages WHERE id = ${before ?? null}::uuid AND conversation_id = ${id}))
      ORDER BY sent_at DESC, id DESC LIMIT 61
    `;
    const messages = rows
      .slice(0, 60)
      .reverse()
      .map((row) => this.message(row));
    const [metadata] = await this
      .sql`SELECT history_limited, wechat, native_actions, contact_details FROM communication_threads WHERE id = ${id}`;
    const [action] = await this
      .sql`SELECT id, status, error FROM communication_wechat_actions WHERE conversation_id = ${id} AND action_kind='wechat' ORDER BY created_at DESC LIMIT 1`;
    const [resumeAction] = await this
      .sql`SELECT id,status,error FROM communication_wechat_actions WHERE conversation_id=${id} AND action_kind='resume' ORDER BY created_at DESC LIMIT 1`;
    const acceptActions = await this.sql`SELECT id,status,error,provider_message_id FROM communication_wechat_actions WHERE conversation_id=${id} AND action_kind='resume_accept' ORDER BY created_at DESC`;
    for (const message of messages) {
      const row = rows.find(r=>r.id===message.id)!;
      const offer = metadata?.native_actions?.resumeOffers?.[row.provider_message_id];
      if (offer) {
        const action = acceptActions.find(a=>a.provider_message_id===row.provider_message_id);
        message.resumeOffer = {...offer,...(action ? {action:this.action(action)} : {})};
      }
      message.resumeAttachment = (metadata?.native_actions?.resumeAttachments ?? []).includes(row.provider_message_id);
    }
    return {
      conversation,
      messages,
      attachmentAvailable: metadata?.native_actions?.attachmentAvailable === true,
      hasOlder: rows.length > 60,
      before: messages[0]?.id ?? null,
      historyLimited: metadata?.history_limited ?? true,
      wechat: bossWechatCapabilitySchema.parse(
        metadata?.wechat ?? {
          state: 'unavailable',
          reason: '请先同步当前会话。',
        },
      ),
      wechatAction: action ? this.action(action) : null,
      resume: bossWechatCapabilitySchema.parse(
        metadata?.native_actions?.resume ?? {
          state: 'unavailable',
          reason: '请先同步当前会话。',
        },
      ),
      resumeAction: resumeAction ? this.action(resumeAction) : null,
      contacts: Object.values(metadata?.contact_details ?? {}),
    };
  }

  private message(row: Record<string, any>): CommunicationMessage {
    return {
      id: row.id,
      direction: row.direction,
      kind: row.kind,
      body: row.body,
      assets: (row.assets ?? []).map((a: BossChatAsset, index: number) => ({
        index,
        kind: a.kind,
        name: a.name,
      })),
      status: row.status,
      error: row.error ?? null,
      sentAt: iso(row.sent_at),
      receivedAt: iso(row.received_at),
    };
  }

  async asset(
    principal: SessionPrincipal,
    conversationId: string,
    messageId: string,
    index: number,
  ): Promise<BossChatAsset> {
    await this.target(principal, conversationId);
    const [row] = await this
      .sql`SELECT assets FROM communication_messages WHERE id=${messageId} AND conversation_id=${conversationId} AND status='sent'`;
    const asset = row?.assets?.[index];
    if (!asset) throw new Error('附件不存在，请重新同步此会话。');
    return bossChatAssetSchema.parse(asset);
  }

  async saveInbox(accountId: string, raw: BossChatInbox): Promise<void> {
    const snapshot = bossChatInboxSchema.parse(raw);
    const cutoff = communicationSince();
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${accountId}, 37))`;
      for (const item of snapshot.conversations) {
        if (
          !item.lastMessageAt ||
          item.lastMessageAt < cutoff ||
          Date.parse(item.lastMessageAt) > Date.now() + 60_000 ||
          !item.candidateName
        )
          continue;
        const [known] =
          await tx`SELECT cps.candidate_id FROM candidate_position_states cps JOIN positions p ON p.id = cps.position_id
          JOIN candidate_snapshots s ON s.id = cps.latest_snapshot_id
          WHERE p.boss_account_id = ${accountId} AND s.source_locator->>'kind' = 'boss_geek_id' AND s.source_locator->>'value' = ${item.geekId}
          AND NOT EXISTS(SELECT 1 FROM communication_threads t WHERE t.candidate_id = cps.candidate_id AND (t.boss_account_id <> ${accountId} OR t.geek_id <> ${item.geekId}))
          ORDER BY cps.updated_at DESC LIMIT 1`;
        await tx`
          INSERT INTO communication_threads (id, candidate_id, candidate_name, boss_account_id, geek_id, boss_job_id, position_name,
            provider_conversation_id, unread_count, preview, preview_sent_at, inbox_synced_at)
          VALUES (${known?.candidate_id ?? randomUUID()}, ${known?.candidate_id ?? null}, ${item.candidateName}, ${accountId}, ${item.geekId}, ${item.bossJobId ?? null}, ${item.positionName ?? ''},
            ${item.providerConversationId || null}, ${item.unreadCount}, ${item.preview}, ${item.lastMessageAt}, ${snapshot.fetchedAt})
          ON CONFLICT (boss_account_id, geek_id) DO UPDATE SET candidate_id=COALESCE(communication_threads.candidate_id,EXCLUDED.candidate_id),candidate_name = EXCLUDED.candidate_name, boss_job_id = EXCLUDED.boss_job_id,
            position_name = EXCLUDED.position_name, unread_count = EXCLUDED.unread_count, preview = EXCLUDED.preview,
            preview_sent_at = EXCLUDED.preview_sent_at, inbox_synced_at = EXCLUDED.inbox_synced_at
          WHERE communication_threads.inbox_synced_at IS NULL OR communication_threads.inbox_synced_at < EXCLUDED.inbox_synced_at
        `;
      }
    });
  }

  async saveSnapshot(
    target: CommunicationTarget,
    raw: BossChatSnapshot,
  ): Promise<void> {
    const snapshot = bossChatSnapshotSchema.parse(raw);
    if (snapshot.geekId !== target.geekId)
      throw new Error('聊天对象不一致，已停止同步。');
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${target.bossAccountId}, 37))`;
      const [existing] =
        await tx`SELECT * FROM communication_threads WHERE id = ${target.id} FOR UPDATE`;
      if (
        !existing ||
        existing.boss_account_id !== target.bossAccountId ||
        existing.geek_id !== target.geekId ||
        (existing.provider_conversation_id &&
          existing.provider_conversation_id !== snapshot.providerConversationId)
      )
        throw new Error('聊天会话绑定已变化。');
      if (existing.synced_at && iso(existing.synced_at) > snapshot.fetchedAt)
        return;
      const contacts = { ...(existing.contact_details ?? {}) };
      for (const item of snapshot.contacts ?? []) {
        if (
          !snapshot.messages.some(
            (m) =>
              m.providerMessageId === item.providerMessageId &&
              m.direction === 'inbound' &&
              m.kind === 'card' &&
              m.delivery === 'sent',
          )
        )
          throw new Error('联系方式缺少同一会话内的已接收卡片。');
        contacts[item.kind] = item;
      }
      await tx`UPDATE communication_threads SET provider_conversation_id = ${snapshot.providerConversationId}, synced_at = ${snapshot.fetchedAt},
        contact_details=${tx.json(contacts)},native_actions=${tx.json({ resume: snapshot.resume ?? { state: 'unavailable', reason: '请重新同步求简历按钮。' }, attachmentAvailable:snapshot.attachmentAvailable ?? false, resumeOffers:Object.fromEntries(snapshot.messages.filter(m=>m.resumeOffer).map(m=>[m.providerMessageId,m.resumeOffer!])), resumeAttachments:snapshot.messages.filter(m=>m.resumeAttachment).map(m=>m.providerMessageId) })},
        history_limited = ${snapshot.historyLimited}, wechat = ${snapshot.wechat ? tx.json(snapshot.wechat) : null},
        unread_count = CASE WHEN inbox_synced_at > ${snapshot.fetchedAt}::timestamptz THEN unread_count ELSE 0 END WHERE id = ${target.id}`;
      for (const message of snapshot.messages) {
        if (message.delivery !== 'sent') continue;
        await tx`
          INSERT INTO communication_messages (id, conversation_id, candidate_id, boss_account_id, geek_id, provider_message_id,
            provider_conversation_id, direction, kind, body, status, sent_at, assets)
          VALUES (${randomUUID()}, ${target.id}, ${target.candidateId}, ${target.bossAccountId}, ${target.geekId}, ${message.providerMessageId},
            ${snapshot.providerConversationId}, ${message.direction}, ${message.kind}, ${message.body}, 'sent', ${message.sentAt}, ${tx.json(message.assets ?? [])})
          ON CONFLICT (boss_account_id, geek_id, provider_message_id) DO UPDATE
            SET direction = EXCLUDED.direction, kind = EXCLUDED.kind, assets=EXCLUDED.assets,body=EXCLUDED.body WHERE communication_messages.sender_id IS NULL
        `;
      }
    });
  }

  async markRead(
    principal: SessionPrincipal,
    id: string,
    throughMessageId: string,
  ): Promise<void> {
    const target = await this.target(principal, id);
    await this
      .sql`INSERT INTO communication_reads (conversation_id, candidate_id, user_id, read_through)
      SELECT ${id}, ${target.candidateId}, ${principal.userId}, received_at FROM communication_messages WHERE id = ${throughMessageId} AND conversation_id = ${id}
      ON CONFLICT (conversation_id, user_id) DO UPDATE SET read_through = GREATEST(communication_reads.read_through, EXCLUDED.read_through)`;
  }

  async assertReplyAllowed(
    principal: SessionPrincipal,
    target: CommunicationTarget,
  ): Promise<void> {
    const fresh = await this.target(principal, target.id);
    if (
      fresh.geekId !== target.geekId ||
      fresh.bossAccountId !== target.bossAccountId
    )
      throw new Error('聊天对象绑定已变化。');
    if (!(await this.conversations(principal, [fresh]))[0]?.canReply)
      throw new Error('此候选人已设为禁止联系。');
    if (fresh.positionId) {
      const readiness = (await new DepartmentAtsRepository(
        this.sql,
      ).contactReadiness(principal, {
        positionId: fresh.positionId,
        taskId: fresh.taskId,
        candidateId: fresh.stateId ? fresh.candidateId : null,
      })) as { ready: boolean };
      if (!readiness.ready)
        throw new Error(
          '当前联系设置不允许发送，请检查联系安全设置或禁止联系状态。',
        );
      return;
    }
    // Only an administrator may reply to a native conversation whose BOSS job
    // has not been imported. Global/department stops and verified health apply.
    if (principal.role !== 'admin')
      throw new AuthorizationError('没有此会话的发送权限。');
    const controls = await this
      .sql`SELECT * FROM contact_controls WHERE (scope_type='global' AND scope_id='global')
      OR (scope_type='department' AND scope_id=${principal.departmentId})`;
    if (
      ['global', 'department'].some(
        (scope) =>
          !controls.some(
            (c) =>
              c.scope_type === scope &&
              c.enabled &&
              !c.emergency_stop &&
              (!c.approval_required || c.approved_at),
          ),
      )
    )
      throw new Error('当前联系设置不允许发送，请检查联系安全设置。');
    if (
      (
        await this
          .sql`SELECT id FROM contact_settings WHERE id='global' AND emergency_stop`
      )[0]
    )
      throw new Error('当前联系设置已紧急停止。');
    const [health] = await this
      .sql`SELECT status, authoritative, checked_at FROM account_health WHERE boss_account_id=${fresh.bossAccountId}`;
    if (
      !health?.authoritative ||
      health.status !== 'healthy' ||
      Date.now() - new Date(health.checked_at).getTime() > 1_800_000
    )
      throw new Error('BOSS 连接尚未完成实时验证。');
  }

  private async expireOutgoing(accountId: string) {
    for (const table of [
      'communication_messages',
      'communication_wechat_actions',
    ]) {
      const created =
        table === 'communication_messages' ? 'received_at' : 'created_at';
      await this.sql.unsafe(
        `UPDATE ${table} SET status='uncertain', error='发送结果尚未确认，请先在 BOSS 核对，避免重复发送。' WHERE boss_account_id=$1 AND status='sending' AND started_at < now()-interval '2 minutes'`,
        [accountId],
      );
      await this.sql.unsafe(
        `UPDATE ${table} SET status='failed', error='未能开始发送，请重试。' WHERE boss_account_id=$1 AND status='queued' AND ${created} < now()-interval '2 minutes'`,
        [accountId],
      );
    }
  }
  async createOutgoing(
    principal: SessionPrincipal,
    id: string,
    body: string,
    requestId: string,
    delivery?: RecruitmentMessageContext,
  ): Promise<CommunicationMessage> {
    const target = await this.target(principal, id);
    await this.expireOutgoing(target.bossAccountId);
    const text = chatMessageBodySchema.parse(body);
    return this.sql.begin(async (tx) => {
      // Serialize enqueue on this account, including retries from another tab.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${target.bossAccountId}, 37))`;
      const [existing] =
        await tx`SELECT * FROM communication_messages WHERE sender_id = ${principal.userId} AND client_request_id = ${requestId}`;
      if (existing) {
        if (existing.conversation_id !== id || existing.body !== text)
          throw new Error(
            'Idempotency-Key is already used for another message.',
          );
        const [context] =
          await tx`SELECT case_id,kind,record_id,record_version FROM recruitment_deliveries WHERE message_id=${existing.id}`;
        if (
          Boolean(context) !== Boolean(delivery) ||
          (context &&
            delivery &&
            (context.case_id !== delivery.caseId ||
              context.kind !== delivery.kind ||
              context.record_id !== delivery.recordId ||
              context.record_version !== delivery.version))
        )
          throw new Error('Idempotency-Key 已用于其他邀请。');
        return this.message(existing);
      }
      if (delivery) {
        recruitmentMessageContextSchema.parse(delivery);
        await tx`SELECT id FROM recruitment_cases WHERE id=${delivery.caseId} FOR UPDATE`;
        const { LifecycleRepository } =
          await import('./lifecycle-repository.js');
        const preview = await new LifecycleRepository(
          tx as unknown as Database,
        ).delivery(principal, delivery.caseId, delivery);
        if (preview.conversationId !== id || preview.body !== text)
          throw new Error('邀请内容或对象已变化，请重新生成邀请。');
      }
      await tx`UPDATE communication_messages SET status = 'uncertain', error = '发送结果尚未确认，请先在 BOSS 核对，避免重复发送。'
        WHERE boss_account_id = ${target.bossAccountId} AND status = 'sending' AND started_at < now() - interval '2 minutes'`;
      await tx`UPDATE communication_messages SET status = 'failed', error = '未能开始发送，请重试。'
        WHERE boss_account_id = ${target.bossAccountId} AND status = 'queued' AND received_at < now() - interval '2 minutes'`;
      if (
        (
          await tx`SELECT id FROM communication_messages WHERE boss_account_id = ${target.bossAccountId} AND status IN ('queued','sending')`
        )[0]
      )
        throw new Error('已有消息正在发送，请稍后再试。');
      if (
        (
          await tx`SELECT id FROM communication_messages WHERE conversation_id = ${id} AND status = 'uncertain' AND body = ${text}`
        )[0]
      )
        throw new Error('这条消息的发送结果待确认，请先在 BOSS 核对。');
      if (
        (
          await tx`SELECT id FROM communication_wechat_actions WHERE boss_account_id=${target.bossAccountId} AND status IN ('queued','sending')`
        )[0]
      )
        throw new Error('微信交换正在处理，请稍后再试。');
      const [row] = await tx`
        INSERT INTO communication_messages (id, conversation_id, candidate_id, boss_account_id, geek_id, direction, body, status, sender_id, client_request_id, candidate_position_state_id)
        VALUES (${randomUUID()}, ${id}, ${target.candidateId}, ${target.bossAccountId}, ${target.geekId}, 'outbound', ${text}, 'queued', ${principal.userId}, ${requestId}, ${target.stateId}) RETURNING *
      `;
      if (delivery) {
        await tx`INSERT INTO recruitment_deliveries(message_id,case_id,kind,record_id,record_version) VALUES(${row!.id},${delivery.caseId},${delivery.kind},${delivery.recordId},${delivery.version})`;
        if (delivery.kind === 'offer')
          await tx`UPDATE recruitment_offers SET delivery_message_id=${row!.id} WHERE id=${delivery.recordId}`;
        else
          await tx`UPDATE recruitment_interviews SET invitation_message_id=${row!.id} WHERE id=${delivery.recordId}`;
      }
      return this.message(row!);
    });
  }

  async outgoing(id: string) {
    const [row] = await this
      .sql`SELECT m.*, u.department_id, u.email, u.display_name, u.role, u.status AS user_status
      FROM communication_messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ${id}`;
    if (!row || row.direction !== 'outbound' || !row.client_request_id)
      throw new Error('消息不存在。');
    const principal: SessionPrincipal = {
      userId: row.sender_id,
      departmentId: row.department_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
    };
    return { row, principal, active: row.user_status === 'active' };
  }

  async validateOutgoingBusinessContext(
    principal: SessionPrincipal,
    id: string,
  ) {
    const [context] = await this
      .sql`SELECT d.*,m.body,m.conversation_id FROM recruitment_deliveries d JOIN communication_messages m ON m.id=d.message_id WHERE d.message_id=${id}`;
    if (!context) return;
    const { LifecycleRepository } = await import('./lifecycle-repository.js');
    const preview = await new LifecycleRepository(this.sql).delivery(
      principal,
      context.case_id,
      {
        kind: context.kind,
        recordId: context.record_id,
        version: context.record_version,
      },
      id,
    );
    if (
      preview.body !== context.body ||
      preview.conversationId !== context.conversation_id
    )
      throw new Error('邀请内容或对象已变化，本次未发送。');
  }

  async claimOutgoing(id: string): Promise<boolean> {
    return Boolean(
      (
        await this
          .sql`UPDATE communication_messages SET status = 'sending', started_at = now() WHERE id = ${id} AND status = 'queued' RETURNING id`
      )[0],
    );
  }

  async failOutgoing(id: string, uncertain: boolean): Promise<void> {
    await this
      .sql`UPDATE communication_messages SET status = ${uncertain ? 'uncertain' : 'failed'},
      error = ${uncertain ? '发送结果尚未确认，请先在 BOSS 核对，避免重复发送。' : '本次未发送，请检查连接或联系设置后重试。'}
      WHERE id = ${id} AND status IN ('queued','sending')`;
  }

  async failNotStarted(id: string): Promise<void> {
    await this
      .sql`UPDATE communication_messages SET status = 'failed', error = 'BOSS 正在忙，本次未发送，请稍后重试。'
      WHERE id = ${id} AND status = 'queued'`;
  }

  async finishOutgoing(
    id: string,
    receipt: {
      candidateId: string;
      providerConversationId: string;
      serverMid: string;
      acceptedAt: string;
      bodySha256: string;
    },
  ): Promise<void> {
    const { row } = await this.outgoing(id);
    if (
      receipt.candidateId !== row.geek_id ||
      receipt.bodySha256 !==
        createHash('sha256').update(row.body).digest('hex') ||
      !receipt.serverMid ||
      !receipt.providerConversationId ||
      !Number.isFinite(Date.parse(receipt.acceptedAt))
    )
      throw new Error('消息回执不一致。');
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${row.boss_account_id}, 37))`;
      const [thread] =
        await tx`SELECT provider_conversation_id FROM communication_threads WHERE id=${row.conversation_id} FOR UPDATE`;
      if (
        !thread ||
        (thread.provider_conversation_id &&
          thread.provider_conversation_id !== receipt.providerConversationId)
      )
        throw new Error('消息回执所属会话不一致。');
      await tx`UPDATE communication_threads SET provider_conversation_id=${receipt.providerConversationId} WHERE id=${row.conversation_id}`;
      // A refresh may have already copied the acknowledged bubble from BOSS.
      await tx`DELETE FROM communication_messages WHERE boss_account_id = ${row.boss_account_id} AND geek_id = ${row.geek_id}
        AND provider_message_id = ${receipt.serverMid} AND sender_id IS NULL`;
      const changed =
        await tx`UPDATE communication_messages SET status = 'sent', error = NULL, provider_message_id = ${receipt.serverMid},
        provider_conversation_id = ${receipt.providerConversationId}, sent_at = ${receipt.acceptedAt}, receipt = ${tx.json(receipt)}
        WHERE id = ${id} AND status IN ('sending','uncertain') RETURNING id`;
      if (!changed.length) return;
      const [delivery] =
        await tx`SELECT * FROM recruitment_deliveries WHERE message_id=${id}`;
      if (delivery) {
        await tx`UPDATE recruitment_cases SET version=version+1,updated_at=now() WHERE id=${delivery.case_id}`;
        if (delivery.kind === 'offer')
          await tx`UPDATE recruitment_offers SET status='sent',version=version+1,updated_at=now() WHERE id=${delivery.record_id} AND version=${delivery.record_version} AND status='approved' AND delivery_message_id=${id}`;
        await tx`INSERT INTO recruitment_case_events(id,case_id,actor_id,kind,body) VALUES(${randomUUID()},${delivery.case_id},${row.sender_id},'invitation.sent',${delivery.kind === 'offer' ? '录用邀请已取得 BOSS 发送回执，等待候选人答复。' : '面试邀请已取得 BOSS 发送回执，等待候选人确认。'})`;
      }
      await tx`INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
        VALUES (${randomUUID()}, ${row.sender_id}, 'communication.message.sent', 'communication_message', ${id},
          ${tx.json({ conversationId: row.conversation_id, candidateId: row.candidate_id, serverMid: receipt.serverMid, bodySha256: receipt.bodySha256 })})`;
    });
  }
  async quickReplies(
    principal: SessionPrincipal,
  ): Promise<CommunicationQuickReply[]> {
    allowedRole(principal);
    const rows = await this
      .sql`SELECT id, body, updated_at FROM communication_quick_replies WHERE user_id=${principal.userId} ORDER BY updated_at DESC, id`;
    return rows.map((r) => ({
      id: r.id,
      body: r.body,
      updatedAt: iso(r.updated_at),
    }));
  }

  async saveQuickReply(
    principal: SessionPrincipal,
    body: string,
    id?: string,
  ): Promise<CommunicationQuickReply> {
    allowedRole(principal);
    const text = chatMessageBodySchema.parse(body);
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${principal.userId}, 39))`;
      if (
        !id &&
        (
          await tx`SELECT count(*)::int AS n FROM communication_quick_replies WHERE user_id=${principal.userId}`
        )[0]!.n >= 50
      )
        throw new Error('常用语最多保存 50 条，请先整理已有内容。');
      const rows = id
        ? await tx`UPDATE communication_quick_replies SET body=${text}, updated_at=now() WHERE id=${id} AND user_id=${principal.userId} RETURNING *`
        : await tx`INSERT INTO communication_quick_replies(id,user_id,body) VALUES(${randomUUID()},${principal.userId},${text}) RETURNING *`;
      if (!rows[0])
        throw new AuthorizationError('常用语不存在或没有访问权限。');
      return {
        id: rows[0].id,
        body: rows[0].body,
        updatedAt: iso(rows[0].updated_at),
      };
    });
  }

  async deleteQuickReply(
    principal: SessionPrincipal,
    id: string,
  ): Promise<void> {
    allowedRole(principal);
    await this
      .sql`DELETE FROM communication_quick_replies WHERE id=${id} AND user_id=${principal.userId}`;
  }

  private action(row: Record<string, any>): CommunicationWechatAction {
    return { id: row.id, status: row.status, error: row.error ?? null };
  }

  async createWechatAction(
    principal: SessionPrincipal,
    id: string,
    requestId: string,
    kind: 'wechat' | 'resume' | 'resume_accept' = 'wechat',
    messageId?: string,
  ): Promise<CommunicationWechatAction> {
    const target = await this.target(principal, id);
    await this.expireOutgoing(target.bossAccountId);
    const [offerMessage] = kind === 'resume_accept' ? await this.sql`SELECT provider_message_id FROM communication_messages WHERE id=${messageId ?? null}::uuid AND conversation_id=${id} AND direction='inbound'` : [];
    if (kind === 'resume_accept' && !offerMessage?.provider_message_id) throw new Error('附件申请消息不存在。');
    const providerMessageId = offerMessage?.provider_message_id ?? null;
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${target.bossAccountId}, 37))`;
      const [previous] =
        await tx`SELECT * FROM communication_wechat_actions WHERE sender_id=${principal.userId} AND client_request_id=${requestId}`;
      if (previous) {
        if (previous.conversation_id !== id || previous.action_kind !== kind || (previous.provider_message_id ?? null) !== providerMessageId)
          throw new Error('Idempotency-Key 已用于其他会话。');
        return this.action(previous);
      }
      const [unresolved] =
        await tx`SELECT * FROM communication_wechat_actions WHERE conversation_id=${id} AND action_kind=${kind} AND provider_message_id IS NOT DISTINCT FROM ${providerMessageId} AND status IN ('queued','sending','sent','uncertain') ORDER BY created_at DESC LIMIT 1`;
      if (unresolved) return this.action(unresolved);
      if (
        (
          await tx`SELECT id FROM communication_messages WHERE boss_account_id=${target.bossAccountId} AND status IN ('queued','sending')`
        )[0] ||
        (
          await tx`SELECT id FROM communication_wechat_actions WHERE boss_account_id=${target.bossAccountId} AND status IN ('queued','sending')`
        )[0]
      )
        throw new Error('已有消息或微信交换正在处理，请稍后再试。');
      const [native] =
        await tx`SELECT wechat, native_actions, synced_at FROM communication_threads WHERE id=${id}`;
      const capability =
        kind === 'resume_accept' ? {state:native?.native_actions?.resumeOffers?.[providerMessageId]?.state === 'pending' ? 'available' : 'unavailable',reason:'附件申请已处理或已失效，请刷新会话。'} : kind === 'resume' ? native?.native_actions?.resume : native?.wechat;
      if (
        capability?.state !== 'available' ||
        !native?.synced_at ||
        Date.now() - new Date(native.synced_at).getTime() > 60_000
      )
        throw new Error(
          capability?.reason || '请先同步当前会话的申请按钮状态。',
        );
      const [row] =
        await tx`INSERT INTO communication_wechat_actions(id, conversation_id, boss_account_id, geek_id, sender_id, client_request_id, status, action_kind, provider_message_id)
        VALUES(${randomUUID()},${id},${target.bossAccountId},${target.geekId},${principal.userId},${requestId},'queued',${kind},${providerMessageId}) RETURNING *`;
      return this.action(row!);
    });
  }

  async outgoingWechat(id: string) {
    const [row] = await this
      .sql`SELECT a.*,u.department_id,u.email,u.display_name,u.role,u.status AS user_status
      FROM communication_wechat_actions a JOIN users u ON u.id=a.sender_id WHERE a.id=${id}`;
    if (!row) throw new Error('微信交换请求不存在。');
    const principal: SessionPrincipal = {
      userId: row.sender_id,
      departmentId: row.department_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
    };
    return { row, principal, active: row.user_status === 'active' };
  }

  async claimWechat(id: string): Promise<boolean> {
    return Boolean(
      (
        await this
          .sql`UPDATE communication_wechat_actions SET status='sending',started_at=now() WHERE id=${id} AND status='queued' RETURNING id`
      )[0],
    );
  }

  async failWechat(
    id: string,
    uncertain: boolean,
    notStartedOnly = false,
  ): Promise<void> {
    await this
      .sql`UPDATE communication_wechat_actions SET status=${uncertain ? 'uncertain' : 'failed'},finished_at=now(),
      error=${uncertain ? '申请结果待确认，请核对最新消息与按钮状态，避免重复申请。' : '本次未发起申请，请检查连接与按钮状态后重试。'}
      WHERE id=${id} AND (status='queued' OR (${!notStartedOnly} AND status='sending'))`;
  }

  async finishWechat(id: string, value: BossWechatReceipt): Promise<void> {
    const receipt = bossWechatReceiptSchema.parse(value);
    const { row } = await this.outgoingWechat(id);
    if (receipt.geekId !== row.geek_id) throw new Error('微信交换对象不一致。');
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${row.boss_account_id}, 37))`;
      const [thread] =
        await tx`SELECT provider_conversation_id FROM communication_threads WHERE id=${row.conversation_id}`;
      if (thread?.provider_conversation_id !== receipt.providerConversationId)
        throw new Error('微信交换会话已变化。');
      const changed =
        await tx`UPDATE communication_wechat_actions SET status='sent',finished_at=${receipt.acceptedAt},error=NULL,receipt=${tx.json(receipt)}
        WHERE id=${id} AND status IN ('sending','uncertain') RETURNING id`;
      if (!changed.length) return;
      if (row.action_kind === 'resume_accept') {
        if (receipt.providerMessageId !== row.provider_message_id || receipt.evidence !== 'native_resume_received') throw new Error('简历接收回执不一致。');
        await tx`UPDATE communication_threads SET native_actions=jsonb_set(native_actions,ARRAY['resumeOffers',${row.provider_message_id},'state'], '"handled"'::jsonb) WHERE id=${row.conversation_id}`;
      } else if (row.action_kind === 'resume')
        await tx`UPDATE communication_threads SET native_actions=jsonb_set(native_actions,'{resume}',${tx.json({ state: 'pending', reason: '简历请求已发出，等待对方回复。' })}) WHERE id=${row.conversation_id}`;
      else
        await tx`UPDATE communication_threads SET wechat=${tx.json({ state: 'pending', reason: '微信交换已申请，等待对方确认。' })} WHERE id=${row.conversation_id}`;
      await tx`INSERT INTO audit_logs(id,actor_id,action,resource_type,resource_id,payload)
        VALUES(${randomUUID()},${row.sender_id},${row.action_kind === 'resume_accept' ? 'communication.resume.accepted' : row.action_kind === 'resume' ? 'communication.resume.requested' : 'communication.wechat.requested'},'communication_wechat_action',${id},${tx.json({ conversationId: row.conversation_id, evidence: receipt.evidence })})`;
    });
  }
}
