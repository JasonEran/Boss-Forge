-- A fresh installation defaults to 09:00–21:00. Existing configured hours
-- are changed through the audited administrator control API.
ALTER TABLE contact_settings ALTER COLUMN allowed_end_minute SET DEFAULT 1260;
UPDATE contact_settings SET allowed_end_minute = 1260, version = version + 1, updated_at = now()
WHERE id = 'global' AND updated_by = 'system:migration'
  AND allowed_start_minute = 540 AND allowed_end_minute = 1080;

CREATE FUNCTION inherit_position_contact_control() RETURNS trigger AS $$
BEGIN
  INSERT INTO contact_controls (
    id, scope_type, scope_id, enabled, approval_required, policy,
    emergency_stop, updated_by, approved_by, approved_at
  )
  SELECT gen_random_uuid(), 'task', NEW.id::text, enabled, approval_required, policy,
    emergency_stop, updated_by, approved_by, approved_at
  FROM contact_controls
  WHERE scope_type = 'position' AND scope_id = NEW.position_id::text
  ON CONFLICT (scope_type, scope_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tasks_inherit_position_contact_control
AFTER INSERT ON tasks
FOR EACH ROW EXECUTE FUNCTION inherit_position_contact_control();
