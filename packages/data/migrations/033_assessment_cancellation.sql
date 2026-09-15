ALTER TABLE recruitment_assessments DROP CONSTRAINT recruitment_assessments_status_check;
ALTER TABLE recruitment_assessments ADD CONSTRAINT recruitment_assessments_status_check CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled'));
