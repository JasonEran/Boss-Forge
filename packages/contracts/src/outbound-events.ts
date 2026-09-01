export const bossForgeOutboundEventTypes = [
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
] as const;

export type BossForgeOutboundEvent = {
  eventId: string;
  eventType: (typeof bossForgeOutboundEventTypes)[number];
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  occurredAt: string;
  correlationId: string;
  payload: Record<string, unknown>;
};
