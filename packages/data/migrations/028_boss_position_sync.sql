-- BOSS is the source of job identity; local rules and memberships keep their IDs.
ALTER TABLE positions ADD COLUMN boss_job_id text;
ALTER TABLE positions ADD COLUMN boss_job_name_unique boolean NOT NULL DEFAULT false;
ALTER TABLE positions ADD COLUMN boss_job_status text;
ALTER TABLE positions ADD COLUMN boss_synced_at timestamptz;
ALTER TABLE positions DROP CONSTRAINT positions_boss_account_id_name_key;
CREATE UNIQUE INDEX positions_legacy_name_unique ON positions (boss_account_id, name) WHERE boss_job_id IS NULL;
CREATE UNIQUE INDEX positions_boss_job_unique ON positions (boss_account_id, boss_job_id) WHERE boss_job_id IS NOT NULL;
ALTER TABLE tasks ADD COLUMN source_job_id text;
ALTER TABLE tasks ADD COLUMN source_job_name_unique boolean NOT NULL DEFAULT false;
ALTER TABLE tasks ADD COLUMN source_job_name text;

-- Both immediate and scheduled tasks freeze their source when created.
CREATE FUNCTION capture_task_boss_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT boss_job_id, boss_job_keyword, boss_job_name_unique INTO NEW.source_job_id, NEW.source_job_name, NEW.source_job_name_unique
  FROM positions WHERE id = NEW.position_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tasks_capture_boss_job BEFORE INSERT ON tasks
FOR EACH ROW EXECUTE FUNCTION capture_task_boss_job();
