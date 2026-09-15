-- Preserve one immutable screening result per task.  `latest_task_id` keeps its
-- historical name for API compatibility, but from this migration onward it is
-- the owning task of the state and must never be moved to a later task.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS new_candidate_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS repeat_candidate_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS wait_reason_code text,
  ADD COLUMN IF NOT EXISTS wait_reason text,
  ADD COLUMN IF NOT EXISTS next_run_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_progress_at timestamptz,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_candidate_mix_nonnegative_check;
ALTER TABLE tasks
  ADD CONSTRAINT tasks_candidate_mix_nonnegative_check
  CHECK (new_candidate_count >= 0 AND repeat_candidate_count >= 0);

CREATE TABLE IF NOT EXISTS task_commands (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL UNIQUE,
  command text NOT NULL CHECK (command IN ('cancel', 'retry')),
  expected_version integer NOT NULL CHECK (expected_version > 0),
  resulting_version integer NOT NULL CHECK (resulting_version > 0),
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_commands_task_idx
  ON task_commands (task_id, created_at DESC);

-- Preserve legacy positions without guessing their tenant.  A single-department
-- installation can be repaired deterministically; ambiguous installations stay
-- visible only to administrators and cannot start new work until assigned.
ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS assignment_status text NOT NULL DEFAULT 'needs_admin_assignment';
ALTER TABLE positions
  DROP CONSTRAINT IF EXISTS positions_assignment_status_check;
ALTER TABLE positions
  ADD CONSTRAINT positions_assignment_status_check
  CHECK (assignment_status IN ('assigned', 'needs_admin_assignment'));

DO $$
DECLARE
  only_department_id uuid;
BEGIN
  IF (SELECT COUNT(*) FROM departments) = 1 THEN
    SELECT id INTO only_department_id FROM departments LIMIT 1;
    UPDATE positions
    SET department_id = only_department_id
    WHERE department_id IS NULL;
  END IF;
END $$;

WITH sole_admin AS (
  SELECT department_id, MIN(id::text)::uuid AS id
  FROM users
  WHERE role = 'admin' AND status = 'active'
  GROUP BY department_id
  HAVING COUNT(*) = 1
)
UPDATE positions p
SET owner_user_id = sole_admin.id
FROM sole_admin
WHERE p.owner_user_id IS NULL
  AND p.department_id = sole_admin.department_id;

UPDATE positions
SET assignment_status = CASE
  WHEN department_id IS NOT NULL
    AND owner_user_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM users owner_user
      WHERE owner_user.id = positions.owner_user_id
        AND owner_user.department_id = positions.department_id
        AND owner_user.status = 'active'
    )
  THEN 'assigned'
  ELSE 'needs_admin_assignment'
END;

INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
SELECT gen_random_uuid(), 'system:migration:023',
  'position.assignment.required', 'position', p.id::text,
  jsonb_build_object(
    'reason', 'legacy_position_scope_is_ambiguous',
    'departmentAssigned', p.department_id IS NOT NULL,
    'ownerAssigned', p.owner_user_id IS NOT NULL
  )
FROM positions p
WHERE p.assignment_status = 'needs_admin_assignment';

CREATE OR REPLACE FUNCTION maintain_position_assignment_status()
RETURNS trigger AS $$
DECLARE
  valid_owner boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM users owner_user
    WHERE owner_user.id = NEW.owner_user_id
      AND owner_user.department_id = NEW.department_id
      AND owner_user.status = 'active'
  ) INTO valid_owner;
  NEW.assignment_status = CASE
    WHEN NEW.department_id IS NOT NULL AND NEW.owner_user_id IS NOT NULL AND valid_owner
      THEN 'assigned'
    ELSE 'needs_admin_assignment'
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS positions_maintain_assignment_status ON positions;
CREATE TRIGGER positions_maintain_assignment_status
BEFORE INSERT OR UPDATE OF department_id, owner_user_id ON positions
FOR EACH ROW EXECUTE FUNCTION maintain_position_assignment_status();

CREATE OR REPLACE FUNCTION refresh_owned_position_assignment_status()
RETURNS trigger AS $$
BEGIN
  UPDATE positions p
  SET assignment_status = CASE
    WHEN p.department_id = NEW.department_id AND NEW.status = 'active'
      THEN 'assigned'
    ELSE 'needs_admin_assignment'
  END
  WHERE p.owner_user_id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_refresh_owned_position_assignment ON users;
CREATE TRIGGER users_refresh_owned_position_assignment
AFTER UPDATE OF department_id, status ON users
FOR EACH ROW EXECUTE FUNCTION refresh_owned_position_assignment_status();

CREATE OR REPLACE FUNCTION validate_global_user_email()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM users existing
    WHERE lower(existing.email) = lower(NEW.email)
      AND existing.id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'user email must be globally unique for unambiguous login';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_validate_global_email ON users;
CREATE TRIGGER users_validate_global_email
BEFORE INSERT OR UPDATE OF email ON users
FOR EACH ROW EXECUTE FUNCTION validate_global_user_email();

INSERT INTO operational_alerts (
  id, department_id, severity, alert_type, message, resource_type, resource_id
)
SELECT gen_random_uuid(), user_row.department_id, 'warning',
  'user_email_login_ambiguous',
  '该登录邮箱在多个部门重复，系统已拒绝模糊登录；请管理员为用户设置唯一邮箱。',
  'user', user_row.id::text
FROM users user_row
WHERE EXISTS (
  SELECT 1 FROM users duplicate
  WHERE duplicate.id <> user_row.id
    AND lower(duplicate.email) = lower(user_row.email)
)
  AND NOT EXISTS (
    SELECT 1 FROM operational_alerts existing
    WHERE existing.alert_type = 'user_email_login_ambiguous'
      AND existing.resource_type = 'user'
      AND existing.resource_id = user_row.id::text
      AND existing.status <> 'resolved'
  );

ALTER TABLE candidate_position_states
  ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS is_repeat boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS resume_screening_error_code text,
  ADD COLUMN IF NOT EXISTS resume_screening_next_attempt_at timestamptz;

-- Existing rows are the current position state.  Mark whether the candidate
-- had appeared in an earlier task before we restore missing historical rows.
UPDATE candidate_position_states cps
SET is_repeat = EXISTS (
  SELECT 1
  FROM candidate_snapshots earlier
  JOIN tasks earlier_task ON earlier_task.id = earlier.task_id
  JOIN tasks current_task ON current_task.id = cps.latest_task_id
  WHERE earlier.candidate_id = cps.candidate_id
    AND earlier_task.position_id = cps.position_id
    AND earlier.task_id <> cps.latest_task_id
    AND earlier_task.created_at < current_task.created_at
);

ALTER TABLE candidate_position_states
  DROP CONSTRAINT IF EXISTS candidate_position_states_position_id_candidate_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS candidate_states_task_candidate_uidx
  ON candidate_position_states (latest_task_id, candidate_id);

CREATE UNIQUE INDEX IF NOT EXISTS candidate_states_current_position_candidate_uidx
  ON candidate_position_states (position_id, candidate_id)
  WHERE is_current;

-- Restore candidates that disappeared from historical task views when the old
-- upsert moved their single position state to a newer task.  A prior OCR/rule
-- result cannot be reconstructed safely from a list-card snapshot, so these
-- rows are deliberately transparent and require an explicit recheck.
WITH missing AS (
  SELECT DISTINCT ON (cs.task_id, cs.candidate_id)
    cs.task_id,
    cs.candidate_id,
    cs.id AS snapshot_id,
    t.position_id,
    t.rule_version_id,
    t.created_at
  FROM candidate_snapshots cs
  JOIN tasks t ON t.id = cs.task_id
  LEFT JOIN candidate_position_states existing
    ON existing.latest_task_id = cs.task_id
   AND existing.candidate_id = cs.candidate_id
  WHERE existing.id IS NULL
  ORDER BY cs.task_id, cs.candidate_id, cs.collected_at DESC, cs.id DESC
)
INSERT INTO candidate_position_states (
  id, position_id, candidate_id, latest_task_id, latest_snapshot_id,
  rule_version_id, rule_decision, rule_confidence, review_status,
  contact_status, resume_screening_status, resume_screening_error,
  resume_screening_error_code, is_current, is_repeat, stage_key,
  stage_updated_at, version, updated_at
)
SELECT
  gen_random_uuid(), missing.position_id, missing.candidate_id,
  missing.task_id, missing.snapshot_id, missing.rule_version_id,
  'insufficient', 0, 'pending', 'not_contacted', 'failed',
  '历史任务候选人归属已恢复；旧规则证据无法完整重建，请人工重新精筛。',
  'historical_result_needs_recheck', false,
  EXISTS (
    SELECT 1
    FROM candidate_snapshots earlier
    JOIN tasks earlier_task ON earlier_task.id = earlier.task_id
    WHERE earlier.candidate_id = missing.candidate_id
      AND earlier_task.position_id = missing.position_id
      AND earlier.task_id <> missing.task_id
      AND earlier_task.created_at < missing.created_at
  ),
  'screening', now(), 1, now()
FROM missing;

-- Contact intents have always carried their authorizing task. If the legacy
-- mutable state was later moved to another task, reconnect the intent to the
-- restored state for its original task instead of copying contact history into
-- the new screening result.
WITH contact_targets AS (
  SELECT ci.id AS intent_id, target_state.id AS target_state_id
  FROM contact_intents ci
  JOIN candidate_position_states source_state
    ON source_state.id = ci.candidate_position_state_id
  JOIN candidate_position_states target_state
    ON target_state.latest_task_id = ci.task_id
   AND target_state.candidate_id = source_state.candidate_id
   AND target_state.position_id = source_state.position_id
  WHERE source_state.latest_task_id <> ci.task_id
)
UPDATE contact_intents ci
SET candidate_position_state_id = contact_targets.target_state_id
FROM contact_targets
WHERE ci.id = contact_targets.intent_id;

-- Reviews predate an explicit task_id. Associate each review with the newest
-- snapshot that already existed when the review was recorded. This preserves
-- the human decision on its historical task without leaking it into a later
-- task result.
WITH review_targets AS (
  SELECT review.id AS review_id, target.id AS target_state_id
  FROM reviews review
  JOIN candidate_position_states source
    ON source.id = review.candidate_position_state_id
  JOIN LATERAL (
    SELECT possible.id
    FROM candidate_position_states possible
    JOIN candidate_snapshots snapshot ON snapshot.id = possible.latest_snapshot_id
    WHERE possible.position_id = source.position_id
      AND possible.candidate_id = source.candidate_id
      AND snapshot.collected_at <= review.created_at
    ORDER BY snapshot.collected_at DESC, possible.updated_at DESC
    LIMIT 1
  ) target ON true
  WHERE target.id <> source.id
)
UPDATE reviews review
SET candidate_position_state_id = review_targets.target_state_id
FROM review_targets
WHERE review.id = review_targets.review_id;

-- Rebuild task-local projections only for candidates that now have multiple
-- task states. Histories decide which task owns the outcome; a later task
-- without its own decision starts pending/not_contacted.
WITH duplicated_states AS (
  SELECT state.id
  FROM candidate_position_states state
  WHERE EXISTS (
    SELECT 1 FROM candidate_position_states other
    WHERE other.position_id = state.position_id
      AND other.candidate_id = state.candidate_id
      AND other.id <> state.id
  )
), latest_review AS (
  SELECT DISTINCT ON (candidate_position_state_id)
    candidate_position_state_id, decision
  FROM reviews
  ORDER BY candidate_position_state_id, created_at DESC, id DESC
), latest_intent AS (
  SELECT DISTINCT ON (candidate_position_state_id)
    candidate_position_state_id,
    CASE status
      WHEN 'ready' THEN 'queued'
      WHEN 'processing' THEN 'queued'
      WHEN 'sent' THEN 'sent'
      WHEN 'simulated' THEN 'simulated'
      WHEN 'failed' THEN 'failed'
      WHEN 'uncertain' THEN 'uncertain'
      ELSE 'not_contacted'
    END AS contact_status
  FROM contact_intents
  ORDER BY candidate_position_state_id, created_at DESC, id DESC
)
UPDATE candidate_position_states state
SET review_status = COALESCE(
      latest_review.decision,
      CASE WHEN state.rule_decision = 'not_matched' THEN 'not_required' ELSE 'pending' END
    ),
  contact_status = COALESCE(latest_intent.contact_status, 'not_contacted'),
  version = state.version + 1,
  updated_at = now()
FROM duplicated_states duplicated
LEFT JOIN latest_review ON latest_review.candidate_position_state_id = duplicated.id
LEFT JOIN latest_intent ON latest_intent.candidate_position_state_id = duplicated.id
WHERE state.id = duplicated.id;

INSERT INTO operational_alerts (
  id, department_id, severity, alert_type, message, resource_type, resource_id
)
SELECT gen_random_uuid(), p.department_id, 'warning',
  'resume_screening_failed',
  '历史任务候选人归属已恢复，但旧筛选证据无法完整重建，请人工重新精筛。',
  'candidate_position_state', cps.id::text
FROM candidate_position_states cps
JOIN positions p ON p.id = cps.position_id
WHERE cps.resume_screening_error_code = 'historical_result_needs_recheck'
  AND NOT EXISTS (
    SELECT 1 FROM operational_alerts existing
    WHERE existing.alert_type = 'resume_screening_failed'
      AND existing.resource_type = 'candidate_position_state'
      AND existing.resource_id = cps.id::text
      AND existing.status <> 'resolved'
  );

-- Reset first so a task whose legacy candidate_count was stale cannot retain a
-- phantom total merely because it has no surviving state rows.
UPDATE tasks
SET candidate_count = 0, new_candidate_count = 0, repeat_candidate_count = 0;

UPDATE tasks t
SET candidate_count = counts.total,
  new_candidate_count = counts.new_count,
  repeat_candidate_count = counts.repeat_count
FROM (
  SELECT latest_task_id AS task_id,
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE NOT is_repeat)::int AS new_count,
    COUNT(*) FILTER (WHERE is_repeat)::int AS repeat_count
  FROM candidate_position_states
  GROUP BY latest_task_id
) counts
WHERE t.id = counts.task_id;

-- Evidence is now explicitly bound to the snapshot and rule version that
-- produced it, rather than inheriting whichever state happened to be latest.
ALTER TABLE match_evidence
  ADD COLUMN IF NOT EXISTS source_snapshot_id uuid REFERENCES candidate_snapshots(id),
  ADD COLUMN IF NOT EXISTS rule_version_id uuid REFERENCES rule_versions(id);

UPDATE match_evidence me
SET source_snapshot_id = cps.latest_snapshot_id,
  rule_version_id = cps.rule_version_id
FROM candidate_position_states cps
WHERE cps.id = me.candidate_position_state_id
  AND (me.source_snapshot_id IS NULL OR me.rule_version_id IS NULL);

ALTER TABLE match_evidence
  ALTER COLUMN source_snapshot_id SET NOT NULL,
  ALTER COLUMN rule_version_id SET NOT NULL;

-- Semantic mode "off" still records an explainable ignored result.  The old
-- constraint rejected that valid runtime value and rolled back screening.
ALTER TABLE semantic_evaluations
  DROP CONSTRAINT IF EXISTS semantic_evaluations_runtime_mode_check;
ALTER TABLE semantic_evaluations
  ADD CONSTRAINT semantic_evaluations_runtime_mode_check
  CHECK (runtime_mode IN ('off', 'shadow', 'active'));

CREATE OR REPLACE FUNCTION validate_task_rule_ownership()
RETURNS trigger AS $$
DECLARE
  rule_position_id uuid;
  rule_status text;
  position_assignment_status text;
  position_owner_valid boolean;
BEGIN
  SELECT rs.position_id, rv.lifecycle_status
  INTO rule_position_id, rule_status
  FROM rule_versions rv
  JOIN rule_sets rs ON rs.id = rv.rule_set_id
  WHERE rv.id = NEW.rule_version_id;

  IF rule_position_id IS NULL OR rule_position_id <> NEW.position_id THEN
    RAISE EXCEPTION 'task rule version must belong to task position';
  END IF;
  IF rule_status <> 'published' THEN
    RAISE EXCEPTION 'task rule version must be published';
  END IF;
  SELECT p.assignment_status,
    EXISTS (
      SELECT 1 FROM users owner_user
      WHERE owner_user.id = p.owner_user_id
        AND owner_user.department_id = p.department_id
        AND owner_user.status = 'active'
    )
  INTO position_assignment_status, position_owner_valid
  FROM positions p WHERE p.id = NEW.position_id;
  IF position_assignment_status <> 'assigned' OR NOT position_owner_valid THEN
    RAISE EXCEPTION 'position requires department and owner assignment before creating tasks';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tasks_validate_rule_ownership ON tasks;
CREATE TRIGGER tasks_validate_rule_ownership
BEFORE INSERT OR UPDATE OF position_id, rule_version_id ON tasks
FOR EACH ROW EXECUTE FUNCTION validate_task_rule_ownership();

CREATE OR REPLACE FUNCTION validate_candidate_task_state_ownership()
RETURNS trigger AS $$
DECLARE
  owning_position_id uuid;
  owning_rule_version_id uuid;
  snapshot_task_id uuid;
  snapshot_candidate_id uuid;
BEGIN
  SELECT position_id, rule_version_id
  INTO owning_position_id, owning_rule_version_id
  FROM tasks WHERE id = NEW.latest_task_id;

  SELECT task_id, candidate_id
  INTO snapshot_task_id, snapshot_candidate_id
  FROM candidate_snapshots WHERE id = NEW.latest_snapshot_id;

  IF owning_position_id IS NULL
    OR owning_position_id <> NEW.position_id
    OR owning_rule_version_id <> NEW.rule_version_id THEN
    RAISE EXCEPTION 'candidate task state must use its task position and rule version';
  END IF;
  IF snapshot_task_id IS NULL
    OR snapshot_task_id <> NEW.latest_task_id
    OR snapshot_candidate_id <> NEW.candidate_id THEN
    RAISE EXCEPTION 'candidate task state must use a snapshot from the same task and candidate';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS candidate_states_validate_ownership ON candidate_position_states;
CREATE TRIGGER candidate_states_validate_ownership
BEFORE INSERT OR UPDATE OF position_id, candidate_id, latest_task_id,
  latest_snapshot_id, rule_version_id
ON candidate_position_states
FOR EACH ROW EXECUTE FUNCTION validate_candidate_task_state_ownership();

CREATE OR REPLACE FUNCTION validate_contact_intent_task_ownership()
RETURNS trigger AS $$
DECLARE
  state_task_id uuid;
BEGIN
  SELECT latest_task_id INTO state_task_id
  FROM candidate_position_states
  WHERE id = NEW.candidate_position_state_id;
  IF state_task_id IS NULL OR state_task_id <> NEW.task_id THEN
    RAISE EXCEPTION 'contact intent task must match its candidate task state';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS contact_intents_validate_task_ownership ON contact_intents;
CREATE TRIGGER contact_intents_validate_task_ownership
BEFORE INSERT OR UPDATE OF candidate_position_state_id, task_id ON contact_intents
FOR EACH ROW EXECUTE FUNCTION validate_contact_intent_task_ownership();

CREATE OR REPLACE FUNCTION validate_candidate_evidence_ownership()
RETURNS trigger AS $$
DECLARE
  state_snapshot_id uuid;
  state_rule_version_id uuid;
BEGIN
  SELECT latest_snapshot_id, rule_version_id
  INTO state_snapshot_id, state_rule_version_id
  FROM candidate_position_states
  WHERE id = NEW.candidate_position_state_id;

  IF state_snapshot_id IS NULL
    OR state_snapshot_id <> NEW.source_snapshot_id
    OR state_rule_version_id <> NEW.rule_version_id THEN
    RAISE EXCEPTION 'candidate evidence must match its state snapshot and rule version';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS match_evidence_validate_ownership ON match_evidence;
CREATE TRIGGER match_evidence_validate_ownership
BEFORE INSERT OR UPDATE OF candidate_position_state_id, source_snapshot_id,
  rule_version_id
ON match_evidence
FOR EACH ROW EXECUTE FUNCTION validate_candidate_evidence_ownership();

DROP TRIGGER IF EXISTS semantic_evidence_validate_ownership ON semantic_evaluations;
CREATE TRIGGER semantic_evidence_validate_ownership
BEFORE INSERT OR UPDATE OF candidate_position_state_id, source_snapshot_id,
  rule_version_id
ON semantic_evaluations
FOR EACH ROW EXECUTE FUNCTION validate_candidate_evidence_ownership();

CREATE OR REPLACE FUNCTION validate_active_rule_version()
RETURNS trigger AS $$
DECLARE
  active_rule_set_id uuid;
  active_status text;
BEGIN
  IF NEW.active_version_id IS NULL THEN RETURN NEW; END IF;
  SELECT rule_set_id, lifecycle_status
  INTO active_rule_set_id, active_status
  FROM rule_versions WHERE id = NEW.active_version_id;
  IF active_rule_set_id IS NULL OR active_rule_set_id <> NEW.id THEN
    RAISE EXCEPTION 'active rule version must belong to its rule set';
  END IF;
  IF active_status <> 'published' THEN
    RAISE EXCEPTION 'active rule version must be published';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rule_sets_validate_active_version ON rule_sets;
CREATE TRIGGER rule_sets_validate_active_version
BEFORE INSERT OR UPDATE OF active_version_id ON rule_sets
FOR EACH ROW EXECUTE FUNCTION validate_active_rule_version();

-- Repair pointers made stale before the constraint existed.  Retired/draft
-- versions remain in history, but cannot continue to look active in the UI.
INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
SELECT gen_random_uuid(), 'system:migration:023', 'rule.active_pointer.cleared',
  'rule_set', rs.id::text,
  jsonb_build_object(
    'activeVersionId', rs.active_version_id,
    'lifecycleStatus', rv.lifecycle_status,
    'reason', 'active_version_is_not_published_or_belongs_to_another_rule_set'
  )
FROM rule_sets rs
JOIN rule_versions rv ON rv.id = rs.active_version_id
WHERE rv.rule_set_id <> rs.id OR rv.lifecycle_status <> 'published';

UPDATE rule_sets rs
SET active_version_id = NULL
FROM rule_versions rv
WHERE rv.id = rs.active_version_id
  AND (rv.rule_set_id <> rs.id OR rv.lifecycle_status <> 'published');

CREATE OR REPLACE FUNCTION clear_inactive_rule_pointer()
RETURNS trigger AS $$
BEGIN
  IF NEW.lifecycle_status <> 'published' THEN
    UPDATE rule_sets SET active_version_id = NULL
    WHERE active_version_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rule_versions_clear_inactive_pointer ON rule_versions;
CREATE TRIGGER rule_versions_clear_inactive_pointer
AFTER UPDATE OF lifecycle_status ON rule_versions
FOR EACH ROW EXECUTE FUNCTION clear_inactive_rule_pointer();

CREATE INDEX IF NOT EXISTS candidate_resume_retry_due_idx
  ON candidate_position_states (
    resume_screening_status, resume_screening_next_attempt_at, updated_at
  )
  WHERE resume_screening_status = 'queued';

CREATE INDEX IF NOT EXISTS tasks_waiting_resume_idx
  ON tasks (status, next_run_at)
  WHERE status = 'screening';
