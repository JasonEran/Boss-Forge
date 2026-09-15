-- Preserve the actual BOSS job used for collection, including when the HR left
-- the optional job keyword empty. Later resume reads must restore that job.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_job_label text;
