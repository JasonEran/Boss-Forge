ALTER TABLE contact_settings ADD COLUMN internal_quotas_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE positions ADD COLUMN contact_dispatch_paused boolean NOT NULL DEFAULT false;

-- Only release queues deferred solely by our former quantity limits. All other
-- blocks and the immutable per-recipient confirmation remain authoritative.
UPDATE outbox_events oe SET available_at = now()
FROM contact_intents ci
WHERE oe.aggregate_id = ci.id AND oe.event_type = 'contact.requested' AND oe.status = 'pending'
  AND ci.status = 'ready'
  AND ci.deferred_reason ~ '^Contact dispatch preflight blocked: (account_daily_limit|position_daily_limit|task_limit)(,(account_daily_limit|position_daily_limit|task_limit))*$';
UPDATE contact_intents SET deferred_until = NULL, deferred_reason = NULL, last_error = NULL, version = version + 1
WHERE status = 'ready'
  AND deferred_reason ~ '^Contact dispatch preflight blocked: (account_daily_limit|position_daily_limit|task_limit)(,(account_daily_limit|position_daily_limit|task_limit))*$';
