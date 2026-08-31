ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS odoo_database_uuid text,
  ADD COLUMN IF NOT EXISTS odoo_job_id bigint,
  ADD COLUMN IF NOT EXISTS collaborator_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS auto_contact_after_review boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS contact_policy_version_id text;

CREATE UNIQUE INDEX IF NOT EXISTS positions_odoo_job_uidx
  ON positions (odoo_database_uuid, odoo_job_id)
  WHERE odoo_database_uuid IS NOT NULL AND odoo_job_id IS NOT NULL;

ALTER TABLE rule_versions
  ADD COLUMN IF NOT EXISTS external_version_id text,
  ADD COLUMN IF NOT EXISTS schema_version text NOT NULL DEFAULT '1.0';

CREATE UNIQUE INDEX IF NOT EXISTS rule_versions_external_uidx
  ON rule_versions (rule_set_id, external_version_id)
  WHERE external_version_id IS NOT NULL;

ALTER TABLE candidate_position_states
  ADD COLUMN IF NOT EXISTS odoo_database_uuid text,
  ADD COLUMN IF NOT EXISTS odoo_applicant_id bigint;

CREATE UNIQUE INDEX IF NOT EXISTS candidate_states_odoo_applicant_uidx
  ON candidate_position_states (odoo_database_uuid, odoo_applicant_id)
  WHERE odoo_database_uuid IS NOT NULL AND odoo_applicant_id IS NOT NULL;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS integration_correlation_id uuid,
  ADD COLUMN IF NOT EXISTS odoo_database_uuid text,
  ADD COLUMN IF NOT EXISTS odoo_run_id text;

CREATE UNIQUE INDEX IF NOT EXISTS tasks_odoo_run_uidx
  ON tasks (odoo_database_uuid, odoo_run_id)
  WHERE odoo_database_uuid IS NOT NULL AND odoo_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS integration_inbox_events (
  event_id uuid PRIMARY KEY,
  source_system text NOT NULL,
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 1,
  result jsonb,
  last_error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS integration_inbox_status_idx
  ON integration_inbox_events (status, received_at);

CREATE TABLE IF NOT EXISTS integration_outbox_events (
  event_id uuid PRIMARY KEY,
  deduplication_key text,
  target_system text NOT NULL DEFAULT 'odoo',
  correlation_id uuid NOT NULL,
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'dead_letter')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS integration_outbox_dedup_uidx
  ON integration_outbox_events (deduplication_key)
  WHERE deduplication_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS integration_outbox_claim_idx
  ON integration_outbox_events (status, available_at, created_at)
  WHERE status IN ('pending', 'failed');

CREATE TABLE IF NOT EXISTS external_object_maps (
  id uuid PRIMARY KEY,
  external_system text NOT NULL,
  external_database_uuid text NOT NULL,
  external_model text NOT NULL,
  external_id text NOT NULL,
  local_type text NOT NULL,
  local_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (external_system, external_database_uuid, external_model, external_id),
  UNIQUE (external_system, external_database_uuid, local_type, local_id)
);

CREATE TABLE IF NOT EXISTS contact_authorizations (
  id uuid PRIMARY KEY,
  correlation_id uuid NOT NULL,
  candidate_position_state_id uuid NOT NULL REFERENCES candidate_position_states(id),
  odoo_database_uuid text NOT NULL,
  odoo_applicant_id bigint NOT NULL,
  odoo_job_id bigint NOT NULL,
  review_version integer NOT NULL CHECK (review_version > 0),
  reviewer_id text NOT NULL,
  reviewed_at timestamptz NOT NULL,
  boss_account_id text NOT NULL,
  rule_version_external_id text NOT NULL,
  template_version_external_id text NOT NULL,
  rendered_message text NOT NULL CHECK (char_length(rendered_message) BETWEEN 1 AND 500),
  transport_mode text NOT NULL DEFAULT 'fake' CHECK (transport_mode IN ('fake', 'real')),
  authorization_expires_at timestamptz,
  do_not_contact boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'authorized'
    CHECK (status IN ('authorized', 'revoked', 'consumed', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  UNIQUE (odoo_database_uuid, odoo_applicant_id, review_version)
);

CREATE INDEX IF NOT EXISTS contact_authorizations_state_idx
  ON contact_authorizations (candidate_position_state_id, created_at DESC);

ALTER TABLE contact_intents
  ADD COLUMN IF NOT EXISTS authorization_id uuid REFERENCES contact_authorizations(id),
  ADD COLUMN IF NOT EXISTS transport_mode text NOT NULL DEFAULT 'fake';

ALTER TABLE contact_intents
  DROP CONSTRAINT IF EXISTS contact_intents_transport_mode_check;

ALTER TABLE contact_intents
  ADD CONSTRAINT contact_intents_transport_mode_check
  CHECK (transport_mode IN ('fake', 'real'));

CREATE UNIQUE INDEX IF NOT EXISTS contact_intents_authorization_uidx
  ON contact_intents (authorization_id)
  WHERE authorization_id IS NOT NULL;
