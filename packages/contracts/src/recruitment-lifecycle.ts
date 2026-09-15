import { z } from 'zod';

const text = z.string().trim().min(1).max(1000);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      Number.isFinite(Date.parse(v)) && new Date(v).toISOString().startsWith(v),
    '日期无效',
  );
export const recruitmentDeliverySchema = z
  .object({
    kind: z.enum(['interview', 'offer']),
    recordId: z.string().uuid(),
    version: z.number().int().positive(),
  })
  .strict();
export type RecruitmentDelivery = z.infer<typeof recruitmentDeliverySchema>;
export const recruitmentMessageContextSchema = recruitmentDeliverySchema.extend(
  { caseId: z.string().uuid() },
);
export type RecruitmentMessageContext = z.infer<
  typeof recruitmentMessageContextSchema
>;
export const lifecycleRequestIdSchema = z.string().uuid();
export const lifecycleOffsetSchema = z.coerce
  .number()
  .int()
  .min(0)
  .max(1_000_000);
export const isLifecycleInputError = (error: unknown) =>
  error instanceof z.ZodError;
export const recruitmentInterviewActionSchema = z
  .object({
    action: z.enum(['confirm', 'cancel', 'complete', 'no_show', 'feedback']),
    version: z.number().int().positive().optional(),
    note: z.string().max(1000).optional(),
    recommendation: z.enum(['yes', 'mixed', 'no']).optional(),
    score: z.number().int().min(1).max(5).optional(),
    body: z.string().max(1000).optional(),
  })
  .strict();
export const recruitmentOnboardingActionSchema = z
  .object({
    action: z.enum(['add', 'item', 'confirm']),
    itemId: z.string().uuid().optional(),
    title: z.string().trim().min(1).max(200).optional(),
    required: z.boolean().optional(),
    completed: z.boolean().optional(),
    note: z.string().trim().max(1000).optional(),
    actualStartDate: date.optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.action !== 'item' ||
      (Boolean(v.itemId) && typeof v.completed === 'boolean'),
    '请指定入职清单项目及完成状态',
  );
export type RecruitmentInterviewAction = z.infer<
  typeof recruitmentInterviewActionSchema
>;
export type RecruitmentOnboardingAction = z.infer<
  typeof recruitmentOnboardingActionSchema
>;
export const recruitmentCaseInputSchema = z
  .object({
    conversationId: z.string().uuid().optional(),
    stateId: z.string().uuid().optional(),
    positionId: z.string().uuid(),
    ownerId: z.string().uuid(),
  })
  .strict()
  .refine(
    (v) => Boolean(v.conversationId) !== Boolean(v.stateId),
    '请选择一个候选人来源',
  );
export const recruitmentCaseUpdateSchema = z
  .object({
    version: z.number().int().positive(),
    ownerId: z.string().uuid().optional(),
    nextFollowupAt: z.string().datetime().nullable().optional(),
    followupNote: z.string().trim().max(1000).optional(),
    review: z.enum(['approved', 'rejected']).optional(),
    close: z.enum(['rejected', 'withdrawn', 'no_show']).optional(),
    note: text.optional(),
  })
  .strict();
export const recruitmentInterviewInputSchema = z
  .object({
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    location: z.string().trim().min(1).max(160),
    interviewerIds: z.array(z.string().uuid()).min(1).max(10),
  })
  .strict()
  .refine(
    (v) => Date.parse(v.endsAt) > Date.parse(v.startsAt),
    '结束时间必须晚于开始时间',
  );
export const recruitmentOfferInputSchema = z
  .object({
    salaryMonthly: z.number().positive().max(10_000_000),
    salaryMonths: z.number().int().min(1).max(24),
    startDate: date,
    expiresAt: z.string().datetime(),
    terms: z.string().trim().max(250).default(''),
  })
  .strict();
export const recruitmentOfferActionSchema = z
  .object({
    version: z.number().int().positive(),
    action: z.enum([
      'submit',
      'approve',
      'return',
      'accept',
      'decline',
      'withdraw',
      'revise',
    ]),
    changes: recruitmentOfferInputSchema.optional(),
    note: text.optional(),
    responseMessageId: z.string().uuid().optional(),
  })
  .strict();
export const lifecycleStageLabels: Record<string, string> = {
  review: '待审核',
  communicating: '沟通中',
  interview: '面试中',
  offer: '录用中',
  hired: '已入职',
  rejected: '已淘汰',
  withdrawn: '已退出',
  no_show: '未入职',
};
export type LifecycleCase = {
  id: string;
  candidateId: string;
  candidateName: string;
  positionId: string;
  positionName: string;
  conversationId: string | null;
  sourceStateId: string | null;
  ownerId: string;
  ownerName: string;
  stage: string;
  reviewStatus: string;
  closeReason: string;
  nextFollowupAt: string | null;
  followupNote: string;
  version: number;
  updatedAt: string;
};
export type LifecycleInterview = {
  id: string;
  startsAt: string;
  endsAt: string;
  location: string;
  interviewerIds: string[];
  status: string;
  version: number;
  confirmationNote: string;
  invitationStatus: string | null;
  feedback: {
    reviewerId: string;
    reviewerName: string;
    recommendation: string;
    score: number;
    body: string;
  }[];
};
export type LifecycleOffer = {
  id: string;
  salaryMonthly: number;
  salaryMonths: number;
  startDate: string;
  expiresAt: string;
  terms: string;
  status: string;
  version: number;
  responseNote: string;
  deliveryStatus: string | null;
};
export type LifecycleDetail = {
  application: LifecycleCase;
  events: { id: string; actorName: string; body: string; createdAt: string }[];
  interviews: LifecycleInterview[];
  offers: LifecycleOffer[];
  onboardingItems: {
    id: string;
    title: string;
    required: boolean;
    completedAt: string | null;
    note: string;
  }[];
  onboarding: { actualStartDate: string | null; note: string } | null;
};
export type LifecycleWorkspace = {
  applications: LifecycleCase[];
  total: number;
  positions: { id: string; name: string }[];
  users: { id: string; name: string; role: string }[];
  reminders: {
    id: string;
    caseId: string;
    candidateName: string;
    title: string;
    dueAt: string;
  }[];
};
