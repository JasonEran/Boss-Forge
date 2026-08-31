CREATE TABLE IF NOT EXISTS contact_policy_snapshots (
  id uuid PRIMARY KEY,
  position_id uuid NOT NULL REFERENCES positions(id),
  external_version_id text NOT NULL,
  auto_contact_after_review boolean NOT NULL,
  daily_limit integer NOT NULL CHECK (daily_limit >= 0),
  allowed_start_minute integer NOT NULL
    CHECK (allowed_start_minute BETWEEN 0 AND 1439),
  allowed_end_minute integer NOT NULL
    CHECK (allowed_end_minute BETWEEN 1 AND 1440),
  cross_position_cooldown_hours integer NOT NULL
    CHECK (cross_position_cooldown_hours >= 0),
  authorization_ttl_hours integer NOT NULL CHECK (authorization_ttl_hours > 0),
  stop_on_uncertain boolean NOT NULL,
  snapshot jsonb NOT NULL,
  source_event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (position_id, external_version_id),
  CHECK (allowed_start_minute < allowed_end_minute)
);

ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS contact_policy_snapshot_id uuid
    REFERENCES contact_policy_snapshots(id);

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS contact_policy_snapshot_id uuid
    REFERENCES contact_policy_snapshots(id);

ALTER TABLE contact_authorizations
  ADD COLUMN IF NOT EXISTS contact_policy_snapshot_id uuid
    REFERENCES contact_policy_snapshots(id),
  ADD COLUMN IF NOT EXISTS policy_snapshot jsonb;

ALTER TABLE contact_intents
  ADD COLUMN IF NOT EXISTS contact_policy_snapshot_id uuid
    REFERENCES contact_policy_snapshots(id);

ALTER TABLE quota_counters
  ADD COLUMN IF NOT EXISTS reserved integer NOT NULL DEFAULT 0;

ALTER TABLE quota_counters
  DROP CONSTRAINT IF EXISTS quota_counters_reserved_nonnegative;

ALTER TABLE quota_counters
  ADD CONSTRAINT quota_counters_reserved_nonnegative CHECK (reserved >= 0);

CREATE TABLE IF NOT EXISTS contact_quota_reservations (
  contact_intent_id uuid PRIMARY KEY REFERENCES contact_intents(id),
  quota_day date NOT NULL,
  account_scope_id text NOT NULL,
  position_scope_id text NOT NULL,
  task_scope_id text NOT NULL,
  status text NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'consumed', 'released')),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS contact_quota_reservations_status_idx
  ON contact_quota_reservations (status, reserved_at);
