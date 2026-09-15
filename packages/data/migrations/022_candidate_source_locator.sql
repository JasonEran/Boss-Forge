ALTER TABLE candidate_snapshots
  ADD COLUMN IF NOT EXISTS source_locator jsonb;

CREATE INDEX IF NOT EXISTS candidate_snapshots_source_locator_idx
  ON candidate_snapshots ((source_locator ->> 'kind'), (source_locator ->> 'value'))
  WHERE source_locator IS NOT NULL;
