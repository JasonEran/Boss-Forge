import { z } from "zod";

const nonEmptyText = z.string().trim().min(1);
const nullableText = z.string().trim().min(1).nullable();
const positiveInteger = z.number().int().positive();
const isoDateTime = z.string().datetime({ offset: true });

export const OdooContactPolicySnapshotSchema = z
  .object({
    policyVersionId: nonEmptyText,
    autoContactAfterReview: z.boolean(),
    dailyLimit: z.number().int().nonnegative(),
    allowedStartMinute: z.number().int().min(0).max(1_439),
    allowedEndMinute: z.number().int().min(1).max(1_440),
    crossPositionCooldownHours: z.number().int().nonnegative(),
    authorizationTtlHours: z.number().int().positive(),
    stopOnUncertain: z.boolean()
  })
  .superRefine((policy, context) => {
    if (policy.allowedStartMinute >= policy.allowedEndMinute) {
      context.addIssue({
        code: "custom",
        path: ["allowedEndMinute"],
        message: "allowedEndMinute must be greater than allowedStartMinute."
      });
    }
  });

const envelopeFields = {
  eventId: z.string().uuid(),
  aggregateType: nonEmptyText,
  aggregateId: nonEmptyText,
  aggregateVersion: positiveInteger,
  occurredAt: isoDateTime
};

export const OdooJobConfigPublishedEventSchema = z.object({
  ...envelopeFields,
  eventType: z.literal("job.config.published.v1"),
  payload: z.object({
    odooDatabaseUuid: nonEmptyText,
    odooCompanyId: positiveInteger,
    odooJobId: positiveInteger,
    name: nonEmptyText,
    bossAccountId: nonEmptyText,
    bossJobKeyword: nullableText,
    ownerId: nonEmptyText,
    collaboratorIds: z.array(nonEmptyText).default([]),
    active: z.boolean(),
    rule: z.object({
      versionId: nonEmptyText,
      version: positiveInteger,
      schemaVersion: nonEmptyText,
      dictionaryVersion: nonEmptyText,
      config: z.record(z.string(), z.unknown())
    }),
    contactPolicy: OdooContactPolicySnapshotSchema
  })
});

export const OdooScreeningRunRequestedEventSchema = z.object({
  ...envelopeFields,
  eventType: z.literal("screening.run.requested.v1"),
  payload: z.object({
    requestId: z.string().uuid(),
    odooDatabaseUuid: nonEmptyText,
    odooCompanyId: positiveInteger,
    odooJobId: positiveInteger,
    requestedById: nonEmptyText,
    execution: z.object({
      mode: z.enum(["immediate", "scheduled"]),
      source: z.enum(["recommend", "search"]),
      searchKeyword: nullableText,
      scheduledFor: isoDateTime.nullable()
    }),
    rule: z.object({
      versionId: nonEmptyText,
      version: positiveInteger,
      schemaVersion: nonEmptyText,
      dictionaryVersion: nonEmptyText,
      config: z.record(z.string(), z.unknown())
    })
  })
}).superRefine((event, context) => {
  if (event.aggregateId !== event.payload.requestId) {
    context.addIssue({
      code: "custom",
      path: ["aggregateId"],
      message: "aggregateId must equal payload.requestId."
    });
  }
  if (event.payload.execution.source === "search" && !event.payload.execution.searchKeyword) {
    context.addIssue({
      code: "custom",
      path: ["payload", "execution", "searchKeyword"],
      message: "searchKeyword is required when source is search."
    });
  }
});

export const OdooScreeningRunCancelledEventSchema = z.object({
  ...envelopeFields,
  eventType: z.literal("screening.run.cancelled.v1"),
  payload: z.object({
    requestId: z.string().uuid(),
    odooDatabaseUuid: nonEmptyText,
    odooJobId: positiveInteger,
    cancelledById: nonEmptyText,
    cancelledAt: isoDateTime
  })
}).superRefine((event, context) => {
  if (event.aggregateId !== event.payload.requestId) {
    context.addIssue({
      code: "custom",
      path: ["aggregateId"],
      message: "aggregateId must equal payload.requestId."
    });
  }
});

export const OdooContactAuthorizedEventSchema = z.object({
  ...envelopeFields,
  eventType: z.literal("candidate.contact.authorized.v1"),
  payload: z.object({
    authorizationId: z.string().uuid(),
    candidateStateId: z.string().uuid(),
    odooDatabaseUuid: nonEmptyText,
    odooApplicantId: positiveInteger,
    odooJobId: positiveInteger,
    reviewerId: nonEmptyText,
    reviewedAt: isoDateTime,
    reviewVersion: positiveInteger,
    bossAccountId: nonEmptyText,
    ruleVersionId: nonEmptyText,
    templateVersionId: nonEmptyText,
    contactPolicyVersionId: nonEmptyText,
    renderedMessage: z.string().trim().min(1).max(500),
    transportMode: z.enum(["fake", "real"]).default("fake"),
    authorizationExpiresAt: isoDateTime,
    doNotContact: z.boolean().default(false)
  })
}).superRefine((event, context) => {
  if (event.aggregateId !== event.payload.authorizationId) {
    context.addIssue({
      code: "custom",
      path: ["aggregateId"],
      message: "aggregateId must equal payload.authorizationId."
    });
  }
  if (event.aggregateVersion !== event.payload.reviewVersion) {
    context.addIssue({
      code: "custom",
      path: ["aggregateVersion"],
      message: "aggregateVersion must equal payload.reviewVersion."
    });
  }
  if (Date.parse(event.payload.authorizationExpiresAt) <= Date.parse(event.payload.reviewedAt)) {
    context.addIssue({
      code: "custom",
      path: ["payload", "authorizationExpiresAt"],
      message: "authorizationExpiresAt must be later than reviewedAt."
    });
  }
});

export const OdooCandidateReviewCompletedEventSchema = z.object({
  ...envelopeFields,
  eventType: z.literal("candidate.review.completed.v1"),
  payload: z.object({
    candidateStateId: z.string().uuid(),
    odooDatabaseUuid: nonEmptyText,
    odooApplicantId: positiveInteger,
    odooJobId: positiveInteger,
    decision: z.enum(["approved", "rejected"]),
    reviewerId: nonEmptyText,
    reviewedAt: isoDateTime,
    reviewVersion: positiveInteger
  })
}).superRefine((event, context) => {
  if (event.aggregateId !== event.payload.candidateStateId) {
    context.addIssue({
      code: "custom",
      path: ["aggregateId"],
      message: "aggregateId must equal payload.candidateStateId."
    });
  }
  if (event.aggregateVersion !== event.payload.reviewVersion) {
    context.addIssue({
      code: "custom",
      path: ["aggregateVersion"],
      message: "aggregateVersion must equal payload.reviewVersion."
    });
  }
});

export const OdooInboundEventSchema = z.union([
  OdooJobConfigPublishedEventSchema,
  OdooScreeningRunRequestedEventSchema,
  OdooScreeningRunCancelledEventSchema,
  OdooCandidateReviewCompletedEventSchema,
  OdooContactAuthorizedEventSchema
]);

export type OdooJobConfigPublishedEvent = z.infer<typeof OdooJobConfigPublishedEventSchema>;
export type OdooContactPolicySnapshot = z.infer<typeof OdooContactPolicySnapshotSchema>;
export type OdooScreeningRunRequestedEvent = z.infer<
  typeof OdooScreeningRunRequestedEventSchema
>;
export type OdooScreeningRunCancelledEvent = z.infer<
  typeof OdooScreeningRunCancelledEventSchema
>;
export type OdooCandidateReviewCompletedEvent = z.infer<
  typeof OdooCandidateReviewCompletedEventSchema
>;
export type OdooContactAuthorizedEvent = z.infer<typeof OdooContactAuthorizedEventSchema>;
export type OdooInboundEvent = z.infer<typeof OdooInboundEventSchema>;

export const BossForgeOutboundEventSchema = z.object({
  ...envelopeFields,
  eventType: z.enum([
    "screening.run.started.v1",
    "candidate.collected.v1",
    "candidate.screened.v1",
    "candidate.screening_failed.v1",
    "screening.run.completed.v1",
    "contact.queued.v1",
    "contact.sent.v1",
    "contact.simulated.v1",
    "contact.failed.v1",
    "contact.uncertain.v1",
    "candidate.reply.received.v1",
    "boss.account.health_changed.v1"
  ]),
  correlationId: z.string().uuid(),
  payload: z.record(z.string(), z.unknown())
}).superRefine((event, context) => {
  if (!event.eventType.startsWith("contact.")) return;
  const route = z.object({
    contactIntentId: z.string().uuid(),
    authorizationId: z.string().uuid(),
    candidateStateId: z.string().uuid(),
    odooDatabaseUuid: nonEmptyText,
    odooApplicantId: positiveInteger,
    odooJobId: positiveInteger,
    bossAccountId: nonEmptyText,
    contactPolicyVersionId: nonEmptyText,
    transportMode: z.enum(["fake", "real"])
  }).safeParse(event.payload);
  if (!route.success) {
    for (const issue of route.error.issues) {
      context.addIssue({
        code: "custom",
        path: ["payload", ...issue.path],
        message: issue.message
      });
    }
    return;
  }
  if (event.aggregateId !== route.data.contactIntentId) {
    context.addIssue({
      code: "custom",
      path: ["aggregateId"],
      message: "contact aggregateId must equal payload.contactIntentId."
    });
  }
  if (event.eventType === "contact.simulated.v1" && route.data.transportMode !== "fake") {
    context.addIssue({
      code: "custom",
      path: ["payload", "transportMode"],
      message: "contact.simulated.v1 requires fake transportMode."
    });
  }
  if (event.eventType === "contact.sent.v1" && route.data.transportMode !== "real") {
    context.addIssue({
      code: "custom",
      path: ["payload", "transportMode"],
      message: "contact.sent.v1 requires real transportMode."
    });
  }
});

export type BossForgeOutboundEvent = z.infer<typeof BossForgeOutboundEventSchema>;

export function parseOdooInboundEvent(value: unknown): OdooInboundEvent {
  return OdooInboundEventSchema.parse(value);
}
