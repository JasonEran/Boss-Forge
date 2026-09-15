-- The legacy evaluation gate scored a flattened alias list rather than the
-- production criterion/model path. Preserve all catalogs and observations,
-- but fail closed by making semantic output shadow-only until separately
-- accepted against a representative, criterion-scoped gold set.
INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
SELECT gen_random_uuid(), 'system:migration:024', 'semantic.mode.downgraded',
  'position', id::text,
  jsonb_build_object(
    'from', 'active',
    'to', 'shadow',
    'reason', 'semantic_active_decisions_not_product_accepted'
  )
FROM positions
WHERE semantic_mode = 'active';

UPDATE positions
SET semantic_mode = 'shadow', updated_at = now()
WHERE semantic_mode = 'active';

ALTER TABLE positions
  DROP CONSTRAINT IF EXISTS positions_semantic_mode_check;
ALTER TABLE positions
  ADD CONSTRAINT positions_semantic_mode_check
  CHECK (semantic_mode IN ('off', 'shadow'));

