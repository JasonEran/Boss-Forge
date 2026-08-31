ALTER TABLE candidate_position_states
  DROP CONSTRAINT IF EXISTS candidate_position_states_contact_status_check;

ALTER TABLE candidate_position_states
  ADD CONSTRAINT candidate_position_states_contact_status_check
  CHECK (contact_status IN (
    'not_contacted', 'queued', 'sent', 'simulated', 'failed', 'uncertain'
  ));

ALTER TABLE contact_intents
  DROP CONSTRAINT IF EXISTS contact_intents_status_check;

ALTER TABLE contact_intents
  ADD CONSTRAINT contact_intents_status_check
  CHECK (status IN (
    'ready', 'processing', 'sent', 'simulated', 'failed', 'uncertain', 'cancelled'
  ));

ALTER TABLE contact_attempts
  DROP CONSTRAINT IF EXISTS contact_attempts_result_check;

ALTER TABLE contact_attempts
  ADD CONSTRAINT contact_attempts_result_check
  CHECK (result IN ('processing', 'sent', 'simulated', 'failed', 'uncertain'));
