-- Park unfinished resume work left behind by task cancellations from older
-- releases. Final screening results and their evidence remain unchanged.
WITH repair_targets AS MATERIALIZED (
  SELECT cps.id, cps.latest_task_id,
    cps.resume_screening_status AS previous_status
  FROM candidate_position_states cps
  JOIN tasks task ON task.id = cps.latest_task_id
  WHERE task.status = 'cancelled'
    AND cps.resume_screening_status IN ('queued', 'processing')
  FOR UPDATE OF cps
), repaired AS (
  UPDATE candidate_position_states cps
  SET resume_screening_status = 'not_requested',
    resume_screening_attempts = 0,
    resume_screening_claimed_by = NULL,
    resume_screening_claimed_at = NULL,
    resume_screening_error = NULL,
    resume_screening_error_code = NULL,
    resume_screening_next_attempt_at = NULL,
    version = cps.version + 1,
    updated_at = now()
  FROM repair_targets target
  WHERE cps.id = target.id
  RETURNING cps.id, cps.latest_task_id
)
INSERT INTO audit_logs (
  id, actor_id, action, resource_type, resource_id, payload
)
SELECT
  gen_random_uuid(),
  'system:migration:025',
  'candidate.resume_screening.cancelled_state_repaired',
  'candidate_position_state',
  repaired.id::text,
  jsonb_build_object(
    'taskId', repaired.latest_task_id,
    'previousResumeScreeningStatus', target.previous_status,
    'resultingResumeScreeningStatus', 'not_requested'
  )
FROM repaired
JOIN repair_targets target ON target.id = repaired.id;
