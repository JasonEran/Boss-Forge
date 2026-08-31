CREATE TABLE IF NOT EXISTS positions (
  id uuid PRIMARY KEY,
  boss_account_id text NOT NULL,
  name text NOT NULL,
  boss_job_keyword text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'closed')),
  owner_name text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (boss_account_id, name)
);

CREATE TABLE IF NOT EXISTS rule_sets (
  id uuid PRIMARY KEY,
  position_id uuid NOT NULL UNIQUE REFERENCES positions(id),
  name text NOT NULL,
  active_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rule_versions (
  id uuid PRIMARY KEY,
  rule_set_id uuid NOT NULL REFERENCES rule_sets(id),
  version integer NOT NULL,
  config jsonb NOT NULL,
  dictionary_version text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_set_id, version)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rule_sets_active_version_fk'
  ) THEN
    ALTER TABLE rule_sets
      ADD CONSTRAINT rule_sets_active_version_fk
      FOREIGN KEY (active_version_id) REFERENCES rule_versions(id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  position_id uuid NOT NULL REFERENCES positions(id),
  rule_version_id uuid NOT NULL REFERENCES rule_versions(id),
  execution_mode text NOT NULL CHECK (execution_mode IN ('immediate', 'scheduled')),
  source text NOT NULL CHECK (source IN ('recommend', 'search')),
  search_keyword text,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'waiting_review', 'completed', 'failed', 'cancelled')),
  created_by text NOT NULL,
  claimed_by text,
  candidate_count integer NOT NULL DEFAULT 0,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS tasks_claim_idx ON tasks (status, created_at);
CREATE INDEX IF NOT EXISTS tasks_position_idx ON tasks (position_id, created_at DESC);

CREATE TABLE IF NOT EXISTS candidates (
  id uuid PRIMARY KEY,
  fingerprint text NOT NULL UNIQUE,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS candidate_snapshots (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  candidate_id uuid NOT NULL REFERENCES candidates(id),
  source_reference text NOT NULL,
  source text NOT NULL,
  raw_fields jsonb NOT NULL,
  source_evidence jsonb NOT NULL,
  raw_text text NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, source_reference)
);

CREATE TABLE IF NOT EXISTS candidate_position_states (
  id uuid PRIMARY KEY,
  position_id uuid NOT NULL REFERENCES positions(id),
  candidate_id uuid NOT NULL REFERENCES candidates(id),
  latest_task_id uuid NOT NULL REFERENCES tasks(id),
  latest_snapshot_id uuid NOT NULL REFERENCES candidate_snapshots(id),
  rule_version_id uuid NOT NULL REFERENCES rule_versions(id),
  rule_decision text NOT NULL CHECK (rule_decision IN ('matched', 'not_matched', 'ambiguous', 'insufficient')),
  rule_confidence double precision NOT NULL CHECK (rule_confidence >= 0 AND rule_confidence <= 1),
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected')),
  contact_status text NOT NULL DEFAULT 'not_contacted' CHECK (contact_status IN ('not_contacted', 'queued', 'sent', 'failed', 'uncertain')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (position_id, candidate_id)
);

CREATE INDEX IF NOT EXISTS candidate_review_idx
  ON candidate_position_states (position_id, review_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS match_evidence (
  id uuid PRIMARY KEY,
  candidate_position_state_id uuid NOT NULL REFERENCES candidate_position_states(id) ON DELETE CASCADE,
  capability_id text NOT NULL,
  canonical_label text NOT NULL,
  dictionary_version text NOT NULL,
  source_text text NOT NULL,
  normalized_alias text NOT NULL,
  evidence_status text NOT NULL,
  confidence double precision NOT NULL,
  reason_codes jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY,
  actor_id text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_resource_idx
  ON audit_logs (resource_type, resource_id, created_at DESC);
