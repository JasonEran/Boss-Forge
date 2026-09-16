-- Raise screening candidate_limit past the old 200 product cap.
-- Application still enforces a high practical safety ceiling (100_000).
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_candidate_limit_check;
ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_candidate_limit_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_candidate_limit_check
  CHECK (candidate_limit >= 1 AND candidate_limit <= 100000);

ALTER TABLE schedules
  ADD CONSTRAINT schedules_candidate_limit_check
  CHECK (candidate_limit >= 1 AND candidate_limit <= 100000);
