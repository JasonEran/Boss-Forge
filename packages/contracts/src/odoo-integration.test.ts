import { describe, expect, it } from "vitest";
import {
  BossForgeOutboundEventSchema,
  OdooCandidateReviewCompletedEventSchema,
  OdooContactPolicySnapshotSchema,
  OdooContactAuthorizedEventSchema,
  OdooInboundEventSchema,
  OdooJobConfigPublishedEventSchema,
  OdooScreeningRunCancelledEventSchema,
  OdooScreeningRunRequestedEventSchema
} from "./odoo-integration.js";

const envelope = {
  eventId: "d8263cb1-9d52-4896-8052-898743e11517",
  aggregateType: "screening.run",
  aggregateId: "28fd0fc5-d13a-49aa-bf43-ed2079d351ae",
  aggregateVersion: 1,
  occurredAt: "2026-08-31T08:00:00+08:00"
};

describe("Odoo integration contracts", () => {
  it("accepts the complete immutable contact-policy snapshot", () => {
    expect(
      OdooContactPolicySnapshotSchema.parse({
        policyVersionId: "odoo-policy-7",
        autoContactAfterReview: true,
        dailyLimit: 20,
        allowedStartMinute: 9 * 60,
        allowedEndMinute: 18 * 60,
        crossPositionCooldownHours: 72,
        authorizationTtlHours: 24,
        stopOnUncertain: true
      }).dailyLimit
    ).toBe(20);
  });

  it("rejects an invalid contact-policy time window", () => {
    expect(
      OdooContactPolicySnapshotSchema.safeParse({
        policyVersionId: "odoo-policy-7",
        autoContactAfterReview: true,
        dailyLimit: 20,
        allowedStartMinute: 18 * 60,
        allowedEndMinute: 9 * 60,
        crossPositionCooldownHours: 72,
        authorizationTtlHours: 24,
        stopOnUncertain: true
      }).success
    ).toBe(false);
  });

  it("requires a full policy snapshot when publishing a job", () => {
    const result = OdooJobConfigPublishedEventSchema.parse({
      ...envelope,
      aggregateType: "hr.job",
      aggregateId: "42",
      eventType: "job.config.published.v1",
      payload: {
        odooDatabaseUuid: "odoo-intranet-01",
        odooCompanyId: 1,
        odooJobId: 42,
        name: "跨境电商运营",
        bossAccountId: "boss-account-01",
        bossJobKeyword: null,
        ownerId: "odoo:user:18",
        collaboratorIds: [],
        active: true,
        rule: {
          versionId: "odoo-rule-7",
          version: 7,
          schemaVersion: "1.0",
          dictionaryVersion: "2026.08.3",
          config: {}
        },
        contactPolicy: {
          policyVersionId: "odoo-policy-7",
          autoContactAfterReview: true,
          dailyLimit: 20,
          allowedStartMinute: 540,
          allowedEndMinute: 1080,
          crossPositionCooldownHours: 72,
          authorizationTtlHours: 24,
          stopOnUncertain: true
        }
      }
    });
    expect(result.payload.contactPolicy.policyVersionId).toBe("odoo-policy-7");
  });

  it("accepts a versioned immediate screening request", () => {
    const result = OdooScreeningRunRequestedEventSchema.parse({
      ...envelope,
      eventType: "screening.run.requested.v1",
      payload: {
        requestId: envelope.aggregateId,
        odooDatabaseUuid: "odoo-intranet-01",
        odooCompanyId: 1,
        odooJobId: 42,
        requestedById: "odoo:user:18",
        execution: {
          mode: "immediate",
          source: "recommend",
          searchKeyword: null,
          scheduledFor: null
        },
        rule: {
          versionId: "odoo-rule-7",
          version: 7,
          schemaVersion: "1.0",
          dictionaryVersion: "2026.08.3",
          config: { requiredCapabilities: [{ capability: "tem8", minimumConfidence: 0.86 }] }
        }
      }
    });
    expect(result.payload.odooJobId).toBe(42);
  });

  it("requires a keyword for search requests", () => {
    const result = OdooScreeningRunRequestedEventSchema.safeParse({
      ...envelope,
      eventType: "screening.run.requested.v1",
      payload: {
        requestId: envelope.aggregateId,
        odooDatabaseUuid: "odoo-intranet-01",
        odooCompanyId: 1,
        odooJobId: 42,
        requestedById: "odoo:user:18",
        execution: {
          mode: "immediate",
          source: "search",
          searchKeyword: null,
          scheduledFor: null
        },
        rule: {
          versionId: "odoo-rule-7",
          version: 7,
          schemaVersion: "1.0",
          dictionaryVersion: "2026.08.3",
          config: {}
        }
      }
    });
    expect(result.success).toBe(false);
  });

  it("rejects a screening request whose aggregate does not match the request", () => {
    const result = OdooScreeningRunRequestedEventSchema.safeParse({
      ...envelope,
      aggregateId: "d4df6a0c-2678-4c8d-b7b2-a46a676e2244",
      eventType: "screening.run.requested.v1",
      payload: {
        requestId: envelope.aggregateId,
        odooDatabaseUuid: "odoo-intranet-01",
        odooCompanyId: 1,
        odooJobId: 42,
        requestedById: "odoo:user:18",
        execution: {
          mode: "immediate",
          source: "recommend",
          searchKeyword: null,
          scheduledFor: null
        },
        rule: {
          versionId: "odoo-rule-7",
          version: 7,
          schemaVersion: "1.0",
          dictionaryVersion: "2026.08.3",
          config: {}
        }
      }
    });
    expect(result.success).toBe(false);
  });

  it("accepts a cancellation only for the same screening run", () => {
    const result = OdooScreeningRunCancelledEventSchema.parse({
      ...envelope,
      aggregateVersion: 2,
      eventType: "screening.run.cancelled.v1",
      payload: {
        requestId: envelope.aggregateId,
        odooDatabaseUuid: "odoo-intranet-01",
        odooJobId: 42,
        cancelledById: "odoo:user:18",
        cancelledAt: "2026-08-31T08:05:00+08:00"
      }
    });
    expect(result.payload.requestId).toBe(envelope.aggregateId);
  });

  it("rejects a mutable or mismatched contact authorization envelope", () => {
    const result = OdooContactAuthorizedEventSchema.safeParse({
      ...envelope,
      aggregateType: "contact.authorization",
      aggregateId: "bad-authorization-id",
      aggregateVersion: 3,
      eventType: "candidate.contact.authorized.v1",
      payload: {
        authorizationId: "37b56468-13e0-4d11-93ee-b66525eaa133",
        candidateStateId: "76cc5d56-6e8b-4663-881d-e9809b63bb39",
        odooDatabaseUuid: "odoo-intranet-01",
        odooApplicantId: 88,
        odooJobId: 42,
        reviewerId: "odoo:user:18",
        reviewedAt: "2026-08-31T08:00:00+08:00",
        reviewVersion: 2,
        bossAccountId: "boss-account-01",
        ruleVersionId: "odoo-rule-7",
        templateVersionId: "odoo-template-3",
        contactPolicyVersionId: "odoo-policy-7",
        renderedMessage: "你好，想和你沟通一下这个岗位。",
        transportMode: "fake",
        authorizationExpiresAt: "2026-09-01T08:00:00+08:00",
        doNotContact: false
      }
    });
    expect(result.success).toBe(false);
  });

  it("rejects an authorization without its immutable policy version", () => {
    const result = OdooContactAuthorizedEventSchema.safeParse({
      ...envelope,
      aggregateType: "contact.authorization",
      aggregateId: "37b56468-13e0-4d11-93ee-b66525eaa133",
      eventType: "candidate.contact.authorized.v1",
      payload: {
        authorizationId: "37b56468-13e0-4d11-93ee-b66525eaa133",
        candidateStateId: "76cc5d56-6e8b-4663-881d-e9809b63bb39",
        odooDatabaseUuid: "odoo-intranet-01",
        odooApplicantId: 88,
        odooJobId: 42,
        reviewerId: "odoo:user:18",
        reviewedAt: "2026-08-31T08:00:00+08:00",
        reviewVersion: 1,
        bossAccountId: "boss-account-01",
        ruleVersionId: "odoo-rule-7",
        templateVersionId: "odoo-template-3",
        renderedMessage: "你好，想和你沟通一下这个岗位。",
        transportMode: "fake",
        authorizationExpiresAt: "2026-09-01T08:00:00+08:00",
        doNotContact: false
      }
    });
    expect(result.success).toBe(false);
  });

  it("accepts a terminal candidate review with matching aggregate version", () => {
    const candidateStateId = "76cc5d56-6e8b-4663-881d-e9809b63bb39";
    const result = OdooCandidateReviewCompletedEventSchema.parse({
      ...envelope,
      aggregateType: "candidate_state",
      aggregateId: candidateStateId,
      aggregateVersion: 2,
      eventType: "candidate.review.completed.v1",
      payload: {
        candidateStateId,
        odooDatabaseUuid: "odoo-intranet-01",
        odooApplicantId: 88,
        odooJobId: 42,
        decision: "rejected",
        reviewerId: "odoo:user:18",
        reviewedAt: "2026-08-31T08:00:00+08:00",
        reviewVersion: 2
      }
    });
    expect(result.payload.decision).toBe("rejected");
  });

  it("fails closed for unknown event versions", () => {
    expect(
      OdooInboundEventSchema.safeParse({ ...envelope, eventType: "screening.run.requested.v2" })
        .success
    ).toBe(false);
  });

  it("accepts the isolated fake-contact completion event", () => {
    const result = BossForgeOutboundEventSchema.parse({
      ...envelope,
      aggregateType: "contact_intent",
      eventType: "contact.simulated.v1",
      correlationId: "db021370-47f4-4b90-8364-5bcd201cf19d",
      payload: {
        contactIntentId: envelope.aggregateId,
        authorizationId: "37b56468-13e0-4d11-93ee-b66525eaa133",
        candidateStateId: "76cc5d56-6e8b-4663-881d-e9809b63bb39",
        odooDatabaseUuid: "odoo-intranet-01",
        odooApplicantId: 88,
        odooJobId: 42,
        bossAccountId: "boss-account-01",
        contactPolicyVersionId: "odoo-policy-7",
        transportMode: "fake",
        status: "simulated"
      }
    });
    expect(result.eventType).toBe("contact.simulated.v1");
  });

  it("rejects contact completion without complete cross-database routing", () => {
    expect(
      BossForgeOutboundEventSchema.safeParse({
        ...envelope,
        aggregateType: "contact_intent",
        eventType: "contact.simulated.v1",
        correlationId: "db021370-47f4-4b90-8364-5bcd201cf19d",
        payload: {
          contactIntentId: envelope.aggregateId,
          transportMode: "fake",
          status: "simulated"
        }
      }).success
    ).toBe(false);
  });
});
