ALTER TABLE candidate_position_states
  ADD COLUMN IF NOT EXISTS resume_screening_status text NOT NULL DEFAULT 'not_requested',
  ADD COLUMN IF NOT EXISTS current_english_level text,
  ADD COLUMN IF NOT EXISTS resume_screenshot_path text,
  ADD COLUMN IF NOT EXISTS resume_text_hash text,
  ADD COLUMN IF NOT EXISTS resume_screened_at timestamptz,
  ADD COLUMN IF NOT EXISTS resume_screening_error text,
  ADD COLUMN IF NOT EXISTS resume_screening_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS resume_screening_claimed_by text,
  ADD COLUMN IF NOT EXISTS resume_screening_claimed_at timestamptz;

ALTER TABLE candidate_position_states
  DROP CONSTRAINT IF EXISTS candidate_position_states_resume_screening_status_check;

ALTER TABLE candidate_position_states
  ADD CONSTRAINT candidate_position_states_resume_screening_status_check
  CHECK (
    resume_screening_status IN (
      'not_requested', 'queued', 'processing', 'screened', 'no_text', 'failed'
    )
  );

CREATE INDEX IF NOT EXISTS candidate_resume_screening_claim_idx
  ON candidate_position_states (resume_screening_status, updated_at)
  WHERE resume_screening_status = 'queued';

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks
  ADD CONSTRAINT tasks_status_check
  CHECK (
    status IN (
      'queued', 'running', 'screening', 'waiting_review', 'completed', 'failed', 'cancelled'
    )
  );
