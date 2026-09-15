-- A greeting click and a message send are separate irreversible BOSS writes.
-- Keep them as separate intents so neither action can silently trigger the other.
ALTER TABLE contact_intents
  ADD COLUMN IF NOT EXISTS action_kind text NOT NULL DEFAULT 'message';

ALTER TABLE contact_intents
  ADD COLUMN IF NOT EXISTS provider_greeting_id text;

ALTER TABLE contact_intents
  ADD COLUMN IF NOT EXISTS provider_job_id text;

ALTER TABLE contact_intents
  ALTER COLUMN template_version_id DROP NOT NULL;

ALTER TABLE contact_intents
  DROP CONSTRAINT IF EXISTS contact_intents_action_kind_check;

ALTER TABLE contact_intents
  ADD CONSTRAINT contact_intents_action_kind_check
  CHECK (action_kind IN ('greet', 'message'));

ALTER TABLE contact_intents
  DROP CONSTRAINT IF EXISTS contact_intents_action_content_check;

ALTER TABLE contact_intents
  ADD CONSTRAINT contact_intents_action_content_check
  CHECK (
    (action_kind = 'message' AND template_version_id IS NOT NULL
      AND provider_job_id IS NULL AND provider_greeting_id IS NULL)
    OR
    (action_kind = 'greet' AND template_version_id IS NULL
      AND provider_job_id IS NOT NULL
      AND length(btrim(provider_job_id)) > 0
      AND provider_greeting_id IS NOT NULL
      AND length(btrim(provider_greeting_id)) > 0)
  );

-- The previous candidate-only index made a completed greeting block the
-- separately approved message action. Idempotency and active-state exclusion
-- now apply independently to each irreversible action.
DROP INDEX IF EXISTS contact_intents_active_candidate_uidx;

CREATE UNIQUE INDEX contact_intents_active_candidate_action_uidx
  ON contact_intents (candidate_position_state_id, action_kind)
  WHERE status IN ('ready', 'processing', 'sent', 'uncertain');

CREATE INDEX contact_intents_action_status_idx
  ON contact_intents (action_kind, status, created_at DESC);
