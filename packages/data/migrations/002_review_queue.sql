ALTER TABLE candidate_position_states
  DROP CONSTRAINT IF EXISTS candidate_position_states_review_status_check;

ALTER TABLE candidate_position_states
  ADD CONSTRAINT candidate_position_states_review_status_check
  CHECK (review_status IN ('pending', 'approved', 'rejected', 'not_required'));

UPDATE candidate_position_states
SET review_status = 'not_required', updated_at = now()
WHERE rule_decision = 'not_matched' AND review_status = 'pending';
