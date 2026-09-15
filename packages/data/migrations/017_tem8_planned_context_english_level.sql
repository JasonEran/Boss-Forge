CREATE TEMP TABLE tem8_planned_english_level_corrections ON COMMIT DROP AS
SELECT
  cps.id AS state_id,
  cps.current_english_level AS previous_english_level,
  NULLIF(
    (
      SELECT string_agg(level.value, ' / ' ORDER BY level.ordinality)
      FROM unnest(string_to_array(cps.current_english_level, ' / '))
        WITH ORDINALITY AS level(value, ordinality)
      WHERE level.value <> 'TEM-8（英语专业八级）'
    ),
    ''
  ) AS corrected_english_level
FROM candidate_position_states cps
WHERE cps.current_english_level IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM match_evidence me
    WHERE me.candidate_position_state_id = cps.id
      AND me.capability_id = 'language.english.tem8'
      AND me.evidence_status = 'ambiguous'
      AND me.dictionary_version = '2026.09.1'
      AND me.reason_codes ? 'planned_or_in_progress'
  )
  AND 'TEM-8（英语专业八级）' = ANY(string_to_array(cps.current_english_level, ' / '));

UPDATE candidate_position_states cps
SET current_english_level = correction.corrected_english_level,
  version = cps.version + 1,
  updated_at = now()
FROM tem8_planned_english_level_corrections correction
WHERE cps.id = correction.state_id;

INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
SELECT
  gen_random_uuid(),
  'system:migration:017',
  'candidate.english_level.corrected',
  'candidate_position_state',
  correction.state_id::text,
  jsonb_build_object(
    'reason', 'tem8_planned_exam_context',
    'previousEnglishLevel', correction.previous_english_level,
    'currentEnglishLevel', correction.corrected_english_level,
    'dictionaryVersion', '2026.09.1'
  )
FROM tem8_planned_english_level_corrections correction;
