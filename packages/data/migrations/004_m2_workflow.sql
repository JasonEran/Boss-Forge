CREATE TABLE IF NOT EXISTS schedules (
  id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  position_id uuid NOT NULL REFERENCES positions(id),
  rule_version_id uuid NOT NULL REFERENCES rule_versions(id),
  source text NOT NULL CHECK (source IN ('recommend', 'search')),
  search_keyword text,
  frequency text NOT NULL CHECK (frequency IN ('once', 'daily', 'weekdays', 'weekly')),
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  next_run_at timestamptz NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  last_materialized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS schedules_due_idx
  ON schedules (enabled, next_run_at) WHERE enabled = true;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS schedule_id uuid REFERENCES schedules(id);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS scheduled_for timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS tasks_schedule_run_uidx
  ON tasks (schedule_id, scheduled_for) WHERE schedule_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_templates (
  id uuid PRIMARY KEY,
  position_id uuid REFERENCES positions(id),
  name text NOT NULL,
  active_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS template_versions (
  id uuid PRIMARY KEY,
  template_id uuid NOT NULL REFERENCES message_templates(id),
  version integer NOT NULL,
  body text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'message_templates_active_version_fk'
  ) THEN
    ALTER TABLE message_templates
      ADD CONSTRAINT message_templates_active_version_fk
      FOREIGN KEY (active_version_id) REFERENCES template_versions(id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS contact_settings (
  id text PRIMARY KEY,
  emergency_stop boolean NOT NULL DEFAULT false,
  allowed_start_minute integer NOT NULL DEFAULT 540,
  allowed_end_minute integer NOT NULL DEFAULT 1080,
  account_daily_limit integer NOT NULL DEFAULT 20,
  position_daily_limit integer NOT NULL DEFAULT 10,
  task_limit integer NOT NULL DEFAULT 10,
  cross_position_cooldown_hours integer NOT NULL DEFAULT 72,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

INSERT INTO contact_settings (id, updated_by)
VALUES ('global', 'system:migration')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS contact_intents (
  id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  candidate_position_state_id uuid NOT NULL REFERENCES candidate_position_states(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  template_version_id uuid NOT NULL REFERENCES template_versions(id),
  rendered_message text NOT NULL,
  status text NOT NULL CHECK (status IN ('ready', 'processing', 'sent', 'simulated', 'failed', 'uncertain', 'cancelled')),
  policy_snapshot jsonb NOT NULL,
  created_by text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  last_error text
);

CREATE UNIQUE INDEX IF NOT EXISTS contact_intents_active_candidate_uidx
  ON contact_intents (candidate_position_state_id)
  WHERE status IN ('ready', 'processing', 'sent', 'uncertain');

CREATE TABLE IF NOT EXISTS contact_attempts (
  id uuid PRIMARY KEY,
  contact_intent_id uuid NOT NULL REFERENCES contact_intents(id),
  attempt_no integer NOT NULL,
  result text NOT NULL CHECK (result IN ('processing', 'sent', 'simulated', 'failed', 'uncertain')),
  transport text NOT NULL,
  external_message text,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (contact_intent_id, attempt_no)
);

CREATE TABLE IF NOT EXISTS quota_counters (
  id uuid PRIMARY KEY,
  scope_type text NOT NULL CHECK (scope_type IN ('account', 'position', 'task')),
  scope_id text NOT NULL,
  quota_day date NOT NULL,
  used integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_type, scope_id, quota_day)
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id uuid PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS outbox_claim_idx
  ON outbox_events (status, available_at, created_at);
