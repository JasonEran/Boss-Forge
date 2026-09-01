CREATE TABLE IF NOT EXISTS departments (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  department_id uuid NOT NULL REFERENCES departments(id),
  email text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'recruiting_lead', 'recruiter', 'interviewer')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  password_salt text,
  password_hash text,
  external_subject text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (department_id, email),
  UNIQUE (external_subject)
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_sessions_active_idx
  ON user_sessions (token_hash, expires_at) WHERE revoked_at IS NULL;

ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES departments(id),
  ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id);

CREATE TABLE IF NOT EXISTS position_members (
  position_id uuid NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_role text NOT NULL CHECK (member_role IN ('owner', 'recruiter', 'interviewer', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (position_id, user_id)
);

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id uuid PRIMARY KEY,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  stage_key text NOT NULL,
  label text NOT NULL,
  stage_order integer NOT NULL,
  terminal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (department_id, stage_key),
  UNIQUE (department_id, stage_order)
);

ALTER TABLE candidate_position_states
  ADD COLUMN IF NOT EXISTS stage_key text NOT NULL DEFAULT 'screening',
  ADD COLUMN IF NOT EXISTS stage_updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS rejection_reason text;

CREATE INDEX IF NOT EXISTS candidate_stage_idx
  ON candidate_position_states (position_id, stage_key, stage_updated_at DESC);

CREATE TABLE IF NOT EXISTS candidate_activities (
  id uuid PRIMARY KEY,
  candidate_position_state_id uuid NOT NULL REFERENCES candidate_position_states(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id),
  activity_type text NOT NULL,
  summary text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS candidate_activities_state_idx
  ON candidate_activities (candidate_position_state_id, created_at DESC);

CREATE TABLE IF NOT EXISTS candidate_notes (
  id uuid PRIMARY KEY,
  candidate_position_state_id uuid NOT NULL REFERENCES candidate_position_states(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL,
  mentioned_user_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS candidate_attachments (
  id uuid PRIMARY KEY,
  candidate_position_state_id uuid NOT NULL REFERENCES candidate_position_states(id) ON DELETE CASCADE,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  file_name text NOT NULL,
  mime_type text NOT NULL,
  storage_path text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS work_items (
  id uuid PRIMARY KEY,
  department_id uuid NOT NULL REFERENCES departments(id),
  position_id uuid REFERENCES positions(id) ON DELETE CASCADE,
  candidate_position_state_id uuid REFERENCES candidate_position_states(id) ON DELETE CASCADE,
  assigned_to uuid NOT NULL REFERENCES users(id),
  created_by uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  due_at timestamptz,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS work_items_assignee_idx
  ON work_items (assigned_to, status, due_at);

CREATE TABLE IF NOT EXISTS interviews (
  id uuid PRIMARY KEY,
  candidate_position_state_id uuid NOT NULL REFERENCES candidate_position_states(id) ON DELETE CASCADE,
  scheduled_by uuid NOT NULL REFERENCES users(id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  location text,
  meeting_url text,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS interview_participants (
  interview_id uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  PRIMARY KEY (interview_id, user_id)
);

CREATE TABLE IF NOT EXISTS interview_feedback (
  id uuid PRIMARY KEY,
  interview_id uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  reviewer_user_id uuid NOT NULL REFERENCES users(id),
  recommendation text NOT NULL CHECK (recommendation IN ('strong_yes', 'yes', 'mixed', 'no', 'strong_no')),
  score integer NOT NULL CHECK (score BETWEEN 1 AND 5),
  strengths text NOT NULL DEFAULT '',
  concerns text NOT NULL DEFAULT '',
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (interview_id, reviewer_user_id)
);

CREATE TABLE IF NOT EXISTS do_not_contact (
  candidate_id uuid PRIMARY KEY REFERENCES candidates(id) ON DELETE CASCADE,
  reason text NOT NULL,
  source text NOT NULL,
  created_by uuid REFERENCES users(id),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE rule_versions
  ADD COLUMN IF NOT EXISTS lifecycle_status text NOT NULL DEFAULT 'published'
    CHECK (lifecycle_status IN ('draft', 'pending_approval', 'published', 'retired')),
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS retired_at timestamptz,
  ADD COLUMN IF NOT EXISTS parent_version_id uuid REFERENCES rule_versions(id);

UPDATE rule_versions SET published_at = COALESCE(published_at, created_at)
WHERE lifecycle_status = 'published';

CREATE TABLE IF NOT EXISTS rule_templates (
  id uuid PRIMARY KEY,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  active_version_id uuid,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (department_id, name)
);

CREATE TABLE IF NOT EXISTS rule_template_versions (
  id uuid PRIMARY KEY,
  template_id uuid NOT NULL REFERENCES rule_templates(id) ON DELETE CASCADE,
  version integer NOT NULL,
  config jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  created_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rule_templates_active_version_fk') THEN
    ALTER TABLE rule_templates ADD CONSTRAINT rule_templates_active_version_fk
      FOREIGN KEY (active_version_id) REFERENCES rule_template_versions(id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS rule_replay_runs (
  id uuid PRIMARY KEY,
  position_id uuid NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  baseline_rule_version_id uuid REFERENCES rule_versions(id),
  candidate_rule_version_id uuid NOT NULL REFERENCES rule_versions(id),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  sample_size integer NOT NULL DEFAULT 0,
  changed_count integer NOT NULL DEFAULT 0,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS semantic_catalogs (
  id uuid PRIMARY KEY,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  name text NOT NULL,
  active_version_id uuid,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (department_id, name)
);

CREATE TABLE IF NOT EXISTS semantic_catalog_versions (
  id uuid PRIMARY KEY,
  catalog_id uuid NOT NULL REFERENCES semantic_catalogs(id) ON DELETE CASCADE,
  version integer NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'pending_approval', 'published', 'retired')),
  prompt_template text NOT NULL,
  model_name text,
  entries jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (catalog_id, version)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'semantic_catalogs_active_version_fk') THEN
    ALTER TABLE semantic_catalogs ADD CONSTRAINT semantic_catalogs_active_version_fk
      FOREIGN KEY (active_version_id) REFERENCES semantic_catalog_versions(id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS semantic_evaluation_sets (
  id uuid PRIMARY KEY,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (department_id, name)
);

CREATE TABLE IF NOT EXISTS semantic_evaluation_cases (
  id uuid PRIMARY KEY,
  evaluation_set_id uuid NOT NULL REFERENCES semantic_evaluation_sets(id) ON DELETE CASCADE,
  criterion_id text NOT NULL,
  source_text text NOT NULL,
  expected_result text NOT NULL CHECK (expected_result IN ('matched', 'not_matched', 'unknown')),
  expected_value jsonb,
  source_review_id uuid REFERENCES reviews(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS semantic_evaluation_runs (
  id uuid PRIMARY KEY,
  evaluation_set_id uuid NOT NULL REFERENCES semantic_evaluation_sets(id) ON DELETE CASCADE,
  catalog_version_id uuid REFERENCES semantic_catalog_versions(id),
  model_version text,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS inbound_messages (
  id uuid PRIMARY KEY,
  candidate_position_state_id uuid NOT NULL REFERENCES candidate_position_states(id) ON DELETE CASCADE,
  external_message_id text,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  body text NOT NULL,
  sent_at timestamptz NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (external_message_id)
);

CREATE TABLE IF NOT EXISTS talent_tags (
  id uuid PRIMARY KEY,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text NOT NULL DEFAULT 'slate',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (department_id, name)
);

CREATE TABLE IF NOT EXISTS candidate_talent_tags (
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES talent_tags(id) ON DELETE CASCADE,
  added_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (candidate_id, tag_id)
);

CREATE TABLE IF NOT EXISTS account_health (
  boss_account_id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('healthy', 'degraded', 'blocked', 'unknown')),
  authoritative boolean NOT NULL DEFAULT false,
  reason text,
  checked_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS operational_alerts (
  id uuid PRIMARY KEY,
  department_id uuid REFERENCES departments(id) ON DELETE CASCADE,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  alert_type text NOT NULL,
  message text NOT NULL,
  resource_type text,
  resource_id text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  acknowledged_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE IF NOT EXISTS contact_controls (
  id uuid PRIMARY KEY,
  scope_type text NOT NULL CHECK (scope_type IN ('global', 'department', 'position', 'task')),
  scope_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  approval_required boolean NOT NULL DEFAULT true,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  updated_by uuid REFERENCES users(id),
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_type, scope_id)
);

CREATE TABLE IF NOT EXISTS contact_approval_requests (
  id uuid PRIMARY KEY,
  scope_type text NOT NULL CHECK (scope_type IN ('department', 'position', 'task')),
  scope_id text NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id),
  decided_by uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  justification text NOT NULL,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

CREATE INDEX IF NOT EXISTS contact_approval_pending_idx
  ON contact_approval_requests (status, created_at) WHERE status = 'pending';
