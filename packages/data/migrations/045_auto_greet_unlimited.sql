-- Persist auto-greet and remove contact time/quantity rhythm limits.
UPDATE positions
SET auto_contact_after_review = true,
    updated_at = now(),
    version = version + 1
WHERE auto_contact_after_review IS DISTINCT FROM true;

UPDATE contact_settings
SET internal_quotas_enabled = false,
    allowed_start_minute = 0,
    allowed_end_minute = 1440,
    account_daily_limit = 100000,
    position_daily_limit = 100000,
    task_limit = 100000,
    cross_position_cooldown_hours = 0,
    updated_by = 'system:migration-045',
    version = version + 1,
    updated_at = now()
WHERE id = 'global';

-- Enable contact controls so chunk auto-greet can enqueue intents.
INSERT INTO contact_controls (
  id, scope_type, scope_id, enabled, approval_required, policy,
  emergency_stop, updated_by, approved_by, approved_at
)
VALUES (
  gen_random_uuid(), 'global', 'global', true, false,
  '{"dailyLimit":100000,"hourlyLimit":100000,"cooldownMinutes":0,"startMinute":0,"endMinute":1440}'::jsonb,
  false, 'system:migration-045', 'system:migration-045', now()
)
ON CONFLICT (scope_type, scope_id) DO UPDATE SET
  enabled = true,
  approval_required = false,
  emergency_stop = false,
  policy = EXCLUDED.policy,
  updated_by = EXCLUDED.updated_by,
  approved_by = EXCLUDED.approved_by,
  approved_at = EXCLUDED.approved_at,
  version = contact_controls.version + 1,
  updated_at = now();

INSERT INTO contact_controls (
  id, scope_type, scope_id, enabled, approval_required, policy,
  emergency_stop, updated_by, approved_by, approved_at
)
SELECT gen_random_uuid(), 'department', d.id::text, true, false,
  '{"dailyLimit":100000,"hourlyLimit":100000,"cooldownMinutes":0,"startMinute":0,"endMinute":1440}'::jsonb,
  false, 'system:migration-045', 'system:migration-045', now()
FROM departments d
ON CONFLICT (scope_type, scope_id) DO UPDATE SET
  enabled = true,
  approval_required = false,
  emergency_stop = false,
  policy = EXCLUDED.policy,
  updated_by = EXCLUDED.updated_by,
  approved_by = EXCLUDED.approved_by,
  approved_at = EXCLUDED.approved_at,
  version = contact_controls.version + 1,
  updated_at = now();

INSERT INTO contact_controls (
  id, scope_type, scope_id, enabled, approval_required, policy,
  emergency_stop, updated_by, approved_by, approved_at
)
SELECT gen_random_uuid(), 'position', p.id::text, true, false,
  '{"dailyLimit":100000,"hourlyLimit":100000,"cooldownMinutes":0,"startMinute":0,"endMinute":1440}'::jsonb,
  false, 'system:migration-045', 'system:migration-045', now()
FROM positions p
ON CONFLICT (scope_type, scope_id) DO UPDATE SET
  enabled = true,
  approval_required = false,
  emergency_stop = false,
  policy = EXCLUDED.policy,
  updated_by = EXCLUDED.updated_by,
  approved_by = EXCLUDED.approved_by,
  approved_at = EXCLUDED.approved_at,
  version = contact_controls.version + 1,
  updated_at = now();

-- Backfill task controls for already-created tasks (trigger covers new inserts).
INSERT INTO contact_controls (
  id, scope_type, scope_id, enabled, approval_required, policy,
  emergency_stop, updated_by, approved_by, approved_at
)
SELECT gen_random_uuid(), 'task', task.id::text, parent.enabled, parent.approval_required,
  parent.policy, parent.emergency_stop, parent.updated_by, parent.approved_by, parent.approved_at
FROM tasks task
JOIN contact_controls parent
  ON parent.scope_type = 'position' AND parent.scope_id = task.position_id::text
ON CONFLICT (scope_type, scope_id) DO UPDATE SET
  enabled = EXCLUDED.enabled,
  approval_required = EXCLUDED.approval_required,
  emergency_stop = EXCLUDED.emergency_stop,
  policy = EXCLUDED.policy,
  updated_by = EXCLUDED.updated_by,
  approved_by = EXCLUDED.approved_by,
  approved_at = EXCLUDED.approved_at,
  version = contact_controls.version + 1,
  updated_at = now();
