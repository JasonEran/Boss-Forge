ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS odoo_config_aggregate_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS odoo_config_snapshot jsonb;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS odoo_request_aggregate_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS odoo_request_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS claim_attempts integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS tasks_account_claim_lease_idx
  ON tasks (status, claimed_at, created_at)
  WHERE status IN ('queued', 'running');

ALTER TABLE candidate_position_states
  ADD COLUMN IF NOT EXISTS odoo_review_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS odoo_review_snapshot jsonb;
