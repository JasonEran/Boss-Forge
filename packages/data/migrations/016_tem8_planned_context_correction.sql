CREATE TEMP TABLE tem8_planned_context_corrections ON COMMIT DROP AS
SELECT DISTINCT
  cps.id AS state_id,
  cps.rule_decision AS previous_decision,
  cps.rule_confidence AS previous_confidence,
  EXISTS (
    SELECT 1
    FROM contact_intents ci
    WHERE ci.candidate_position_state_id = cps.id
      AND ci.status = 'processing'
  ) AS had_processing_contact
FROM candidate_position_states cps
JOIN rule_versions rv ON rv.id = cps.rule_version_id
JOIN match_evidence me ON me.candidate_position_state_id = cps.id
WHERE cps.rule_decision = 'matched'
  AND me.capability_id = 'language.english.tem8'
  AND me.evidence_status = 'positive'
  AND me.source_text ~ '(今年|明年|本月|下月|下个月|本周|下周|近期|年底|年内)[[:space:]]*([一二三四五六七八九十0-9]{1,3}[[:space:]]*月(份)?)?[[:space:]]*(参加|考试|考([^过]|$))'
  AND jsonb_typeof(rv.config -> 'requiredCapabilities') = 'array'
  AND jsonb_array_length(rv.config -> 'requiredCapabilities') = 1
  AND rv.config -> 'requiredCapabilities' -> 0 ->> 'capability' = 'tem8';

UPDATE match_evidence me
SET evidence_status = 'ambiguous',
  confidence = 0.6,
  dictionary_version = '2026.09.1',
  reason_codes = '["planned_or_in_progress"]'::jsonb
FROM tem8_planned_context_corrections correction
WHERE me.candidate_position_state_id = correction.state_id
  AND me.capability_id = 'language.english.tem8'
  AND me.evidence_status = 'positive';

UPDATE candidate_position_states cps
SET rule_decision = 'ambiguous',
  rule_confidence = LEAST(cps.rule_confidence, 0.6),
  review_status = CASE
    WHEN cps.review_status IN ('approved', 'rejected') THEN cps.review_status
    ELSE 'pending'
  END,
  contact_status = CASE
    WHEN cps.contact_status = 'queued' AND correction.had_processing_contact THEN 'uncertain'
    WHEN cps.contact_status = 'queued' THEN 'not_contacted'
    ELSE cps.contact_status
  END,
  version = cps.version + 1,
  updated_at = now()
FROM tem8_planned_context_corrections correction
WHERE cps.id = correction.state_id;

UPDATE contact_intents ci
SET status = CASE WHEN ci.status = 'processing' THEN 'uncertain' ELSE 'cancelled' END,
  finished_at = now(),
  last_error = 'Cancelled after TEM8 planned-exam context correction',
  version = ci.version + 1
FROM tem8_planned_context_corrections correction
WHERE ci.candidate_position_state_id = correction.state_id
  AND ci.status IN ('ready', 'processing');

INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
SELECT
  gen_random_uuid(),
  'system:migration:016',
  'candidate.rule_evaluation.corrected',
  'candidate_position_state',
  correction.state_id::text,
  jsonb_build_object(
    'reason', 'tem8_planned_exam_context',
    'previousDecision', correction.previous_decision,
    'previousConfidence', correction.previous_confidence,
    'decision', 'ambiguous',
    'confidence', 0.6,
    'dictionaryVersion', '2026.09.1'
  )
FROM tem8_planned_context_corrections correction;
