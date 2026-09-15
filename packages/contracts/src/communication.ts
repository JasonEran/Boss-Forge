import { z } from 'zod';

export const COMMUNICATION_HISTORY_DAYS = 7;
export const COMMUNICATION_REFRESH_MS = 5_000;
export const COMMUNICATION_INBOX_LIMIT = 2_000;
export const communicationSince = (now = Date.now()) =>
  new Date(now - COMMUNICATION_HISTORY_DAYS * 86_400_000).toISOString();

export const bossChatTargetSchema = z
  .string()
  .regex(/^[A-Za-z0-9_~-]{8,160}$/u);
export const chatMessageBodySchema = z
  .string()
  .trim()
  .min(1, '请输入消息内容。')
  .max(500, '消息最多 500 字。');
export const bossWechatCapabilitySchema = z.object({
  state: z.enum(['available', 'unavailable', 'pending', 'exchanged']),
  reason: z.string().max(500),
});
export type BossWechatCapability = z.infer<typeof bossWechatCapabilitySchema>;
export const bossWechatReceiptSchema = z.object({
  geekId: bossChatTargetSchema,
  providerConversationId: z.string().min(1).max(512),
  acceptedAt: z.string().datetime(),
  evidence: z.enum(['native_pending', 'native_notice', 'native_card', 'native_resume_received']),
  providerMessageId: z.string().min(1).max(512).optional(),
});
export type BossWechatReceipt = z.infer<typeof bossWechatReceiptSchema>;
export const isBossAssetUrl = (value: string): boolean => {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      (!u.port || u.port === '443') &&
      ['zhipin.com', 'zhipincdn.com', 'bosszhipin.com'].some(
        (h) => u.hostname === h || u.hostname.endsWith('.' + h),
      )
    );
  } catch {
    return false;
  }
};
export const bossChatAssetSchema = z
  .object({
    kind: z.enum(['image', 'file']),
    url: z.string().url().max(8192).refine(isBossAssetUrl, '附件地址不受支持'),
    name: z.string().trim().min(1).max(200),
  })
  .strict();
export const bossSharedContactSchema = z
  .object({
    kind: z.enum(['wechat', 'phone']),
    value: z.string().trim().min(1).max(64),
    providerMessageId: z.string().min(1).max(512),
  })
  .strict();
export type BossChatAsset = z.infer<typeof bossChatAssetSchema>;
export type BossSharedContact = z.infer<typeof bossSharedContactSchema>;
export const bossResumeOfferSchema = z.object({ state: z.enum(['pending', 'handled']) });
export const bossChatMessageSchema = z.object({
  providerMessageId: z.string().min(1).max(512),
  direction: z.enum(['inbound', 'outbound', 'system']),
  kind: z.enum(['text', 'image', 'file', 'card', 'system']),
  body: z.string().max(10000),
  assets: z.array(bossChatAssetSchema).max(10).optional(),
  resumeOffer: bossResumeOfferSchema.optional(),
  resumeAttachment: z.boolean().optional(),
  sentAt: z.string().datetime(),
  delivery: z.enum(['sent', 'pending', 'failed']),
});
export const bossChatSnapshotSchema = z.object({
  geekId: bossChatTargetSchema,
  providerConversationId: z.string().min(1).max(512),
  fetchedAt: z.string().datetime(),
  messages: z.array(bossChatMessageSchema).max(500),
  historyLimited: z.boolean(),
  wechat: bossWechatCapabilitySchema.optional(),
  resume: bossWechatCapabilitySchema.optional(),
  attachmentAvailable: z.boolean().optional(),
  contacts: z.array(bossSharedContactSchema).max(20).optional(),
});
export const bossChatInboxSchema = z.object({
  fetchedAt: z.string().datetime(),
  conversations: z
    .array(
      z.object({
        geekId: bossChatTargetSchema,
        unreadCount: z.number().int().min(0).max(9999),
        preview: z.string().max(1000),
        timeLabel: z.string().max(100),
        lastMessageAt: z.string().datetime().optional(),
        candidateName: z.string().trim().min(1).max(200).optional(),
        bossJobId: z.string().max(256).optional(),
        positionName: z.string().max(256).optional(),
        providerConversationId: z.string().max(512).optional(),
      }),
    )
    .max(COMMUNICATION_INBOX_LIMIT),
  windowStart: z.string().datetime().optional(),
  coverageLimited: z.boolean().optional(),
  scannedCount: z.number().int().nonnegative().optional(),
});
export type BossChatSnapshot = z.infer<typeof bossChatSnapshotSchema>;
export type BossChatInbox = z.infer<typeof bossChatInboxSchema>;
export type CommunicationMessage = {
  resumeOffer?: { state: 'pending' | 'handled'; action?: CommunicationWechatAction };
  resumeAttachment?: boolean;
  assets?: { index: number; kind: 'image' | 'file'; name: string }[];
  id: string;
  direction: 'inbound' | 'outbound' | 'system';
  kind: 'text' | 'image' | 'file' | 'card' | 'system';
  body: string;
  sentAt: string;
  receivedAt: string;
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'uncertain';
  error: string | null;
};
export type CommunicationConversation = {
  id: string;
  candidateName: string;
  positionName: string;
  positionId: string | null;
  lastMessage: string;
  lastMessageAt: string;
  unreadCount: number;
  syncedAt: string | null;
  canReply: boolean;
  replyBlockedReason: string | null;
  inboxSyncedAt?: string | null;
};
export type CommunicationWechatAction = {
  id: string;
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'uncertain';
  error: string | null;
};
export type CommunicationThread = {
  conversation: CommunicationConversation;
  messages: CommunicationMessage[];
  hasOlder: boolean;
  before: string | null;
  historyLimited: boolean;
  wechat?: BossWechatCapability;
  wechatAction?: CommunicationWechatAction | null;
  resume?: BossWechatCapability;
  resumeAction?: CommunicationWechatAction | null;
  attachmentAvailable?: boolean;
  contacts?: BossSharedContact[];
};
export type CommunicationQuickReply = {
  id: string;
  body: string;
  updatedAt: string;
};

/** Internal browser-control result. Paths are never accepted from HTTP clients. */
export const bossChatOnlineResumeSchema = z.object({
  geekId: bossChatTargetSchema,
  capturedAt: z.string().datetime(),
  screenshotPath: z.string().min(1).max(2048),
  text: z.string().max(100000),
  textStatus: z.enum(['pending', 'processing', 'ready', 'unavailable', 'skipped']),
  analysisVersion: z.number().int().nonnegative().optional(),
  analysisError: z.string().max(500).nullable().optional(),
});
export type BossChatOnlineResume = z.infer<typeof bossChatOnlineResumeSchema>;
export type CommunicationRequirement = {
  id: string; label: string; group: string;
  status: 'positive' | 'negative' | 'unknown';
  evidence: string[]; explanation: string; question: string;
};
export type CommunicationCandidateContext = {
  conversationId: string; positionId: string | null; positionName: string;
  ruleVersion: number | null;
  resume: { captureId: string; capturedAt: string; text: string; textStatus: 'pending' | 'processing' | 'ready' | 'unavailable' | 'skipped'; analysisVersion?: number; analysisError?: string | null; complete: boolean; parts: { index: number; width: number; height: number }[] } | null;
  requirements: CommunicationRequirement[];
  qualification?: { status: CommunicationRequirement["status"] | "unconfigured"; reason: string };
};

/** A file captured from the native attachment viewer; never supplied by HTTP clients. */
export const bossChatAttachmentSchema = z.object({
  geekId: bossChatTargetSchema,
  filePath: z.string().min(1).max(2048),
  name: z.string().min(1).max(200),
  contentType: z.enum(['application/pdf', 'image/png', 'image/jpeg']),
  size: z.number().int().positive().max(20 * 1024 * 1024),
});
export type BossChatAttachment = z.infer<typeof bossChatAttachmentSchema>;
