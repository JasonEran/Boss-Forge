ALTER TABLE contact_controls
  ADD COLUMN IF NOT EXISTS policy jsonb NOT NULL DEFAULT '{"dailyLimit":50,"hourlyLimit":10,"cooldownMinutes":30,"startMinute":540,"endMinute":1080}'::jsonb,
  ADD COLUMN IF NOT EXISTS emergency_stop boolean NOT NULL DEFAULT false;

ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS semantic_mode text NOT NULL DEFAULT 'shadow'
    CHECK (semantic_mode IN ('off', 'shadow', 'active')),
  ADD COLUMN IF NOT EXISTS semantic_active_catalog_version_id uuid REFERENCES semantic_catalog_versions(id);

CREATE TABLE IF NOT EXISTS data_retention_policies (
  department_id uuid PRIMARY KEY REFERENCES departments(id) ON DELETE CASCADE,
  retention_days integer NOT NULL DEFAULT 730 CHECK (retention_days BETWEEN 30 AND 3650),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS data_export_jobs (
  id uuid PRIMARY KEY,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id),
  format text NOT NULL CHECK (format IN ('json', 'csv')),
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  row_count integer NOT NULL DEFAULT 0,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE OR REPLACE FUNCTION prevent_published_rule_mutation()
RETURNS trigger AS $$
BEGIN
  IF OLD.lifecycle_status = 'published' AND (
    NEW.config IS DISTINCT FROM OLD.config OR
    NEW.dictionary_version IS DISTINCT FROM OLD.dictionary_version OR
    NEW.version IS DISTINCT FROM OLD.version
  ) THEN
    RAISE EXCEPTION 'published rule versions are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rule_versions_published_immutable ON rule_versions;
CREATE TRIGGER rule_versions_published_immutable
BEFORE UPDATE ON rule_versions
FOR EACH ROW EXECUTE FUNCTION prevent_published_rule_mutation();

CREATE INDEX IF NOT EXISTS work_items_department_status_idx
  ON work_items (department_id, status, due_at);
CREATE INDEX IF NOT EXISTS inbound_messages_state_sent_idx
  ON inbound_messages (candidate_position_state_id, sent_at DESC);
