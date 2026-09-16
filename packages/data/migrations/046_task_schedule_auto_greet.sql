-- Per-batch auto-greet for timed/immediate screening runs.
-- Task flag is the authority for chunk auto-greet (not only positions.auto_contact_after_review).
ALTER TABLE schedules
  ADD COLUMN IF NOT EXISTS auto_greet boolean NOT NULL DEFAULT false;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS auto_greet boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN schedules.auto_greet IS
  'When true, materialized tasks for this schedule auto-greet matched passers after each screening chunk.';
COMMENT ON COLUMN tasks.auto_greet IS
  'When true, auto-greet matched passers after each screening chunk for this task batch.';
