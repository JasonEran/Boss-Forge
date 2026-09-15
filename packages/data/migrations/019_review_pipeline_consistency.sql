UPDATE candidate_position_states
SET stage_key = CASE
    WHEN review_status = 'rejected' THEN 'rejected'
    WHEN review_status = 'approved' AND stage_key IN ('screening', 'review') THEN 'approved'
    ELSE stage_key
  END,
  stage_updated_at = now(),
  updated_at = now()
WHERE (review_status = 'rejected' AND stage_key <> 'rejected')
  OR (review_status = 'approved' AND stage_key IN ('screening', 'review'));

ALTER TABLE candidate_position_states
  DROP CONSTRAINT IF EXISTS candidate_review_stage_consistency_check;

ALTER TABLE candidate_position_states
  ADD CONSTRAINT candidate_review_stage_consistency_check
  CHECK (review_status <> 'rejected' OR stage_key = 'rejected');
