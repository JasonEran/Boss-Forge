ALTER TABLE integration_outbox_events
  ADD COLUMN IF NOT EXISTS deduplication_key text;

CREATE UNIQUE INDEX IF NOT EXISTS integration_outbox_dedup_uidx
  ON integration_outbox_events (deduplication_key)
  WHERE deduplication_key IS NOT NULL;

ALTER TABLE contact_authorizations
  ADD COLUMN IF NOT EXISTS correlation_id uuid;

UPDATE contact_authorizations AS contact_auth
SET correlation_id = inbox.event_id
FROM integration_inbox_events inbox
WHERE contact_auth.correlation_id IS NULL
  AND inbox.event_type = 'candidate.contact.authorized.v1'
  AND inbox.payload ->> 'authorizationId' = contact_auth.id::text;

UPDATE contact_authorizations
SET correlation_id = id
WHERE correlation_id IS NULL;

ALTER TABLE contact_authorizations
  ALTER COLUMN correlation_id SET NOT NULL;
