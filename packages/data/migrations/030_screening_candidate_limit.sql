-- Preserve historical counts. The limit controls new admission, not a rewrite
-- of already collected candidates. Oversized historical runs cannot be retried.
ALTER TABLE tasks ADD COLUMN candidate_limit integer NOT NULL DEFAULT 20
  CHECK (candidate_limit BETWEEN 1 AND 200);
ALTER TABLE schedules ADD COLUMN candidate_limit integer NOT NULL DEFAULT 20
  CHECK (candidate_limit BETWEEN 1 AND 200);
UPDATE tasks SET candidate_limit = LEAST(200, GREATEST(20, candidate_count));
