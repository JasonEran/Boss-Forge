ALTER TABLE candidate_position_states
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS reviews (
  id uuid PRIMARY KEY,
  candidate_position_state_id uuid NOT NULL REFERENCES candidate_position_states(id),
  idempotency_key text NOT NULL UNIQUE,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  note text NOT NULL DEFAULT '',
  correction_code text,
  reviewer_id text NOT NULL,
  previous_status text NOT NULL,
  resulting_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reviews_state_idx
  ON reviews (candidate_position_state_id, created_at DESC);
