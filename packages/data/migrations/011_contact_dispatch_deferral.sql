ALTER TABLE contact_attempts
  DROP CONSTRAINT IF EXISTS contact_attempts_result_check;

ALTER TABLE contact_attempts
  ADD CONSTRAINT contact_attempts_result_check
  CHECK (result IN (
    'processing', 'deferred', 'sent', 'simulated', 'failed', 'uncertain'
  ));

ALTER TABLE contact_intents
  ADD COLUMN IF NOT EXISTS deferred_until timestamptz,
  ADD COLUMN IF NOT EXISTS deferred_reason text;
