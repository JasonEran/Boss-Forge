ALTER TABLE candidate_position_states ADD COLUMN salary_screening jsonb;

CREATE TABLE recruitment_assessments (
  candidate_position_state_id uuid PRIMARY KEY REFERENCES candidate_position_states(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  rule_version_id uuid NOT NULL REFERENCES rule_versions(id),
  config jsonb NOT NULL,
  resume_text text NOT NULL,
  input_hash text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  result jsonb,
  error text,
  claim_token uuid,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recruitment_assessment_queue ON recruitment_assessments(created_at) WHERE status IN ('queued', 'processing');
