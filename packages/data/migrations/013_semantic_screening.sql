CREATE TABLE IF NOT EXISTS semantic_evaluations (
  id uuid PRIMARY KEY,
  candidate_position_state_id uuid NOT NULL
    REFERENCES candidate_position_states(id) ON DELETE CASCADE,
  source_snapshot_id uuid NOT NULL REFERENCES candidate_snapshots(id),
  rule_version_id uuid NOT NULL REFERENCES rule_versions(id),
  criterion_id text NOT NULL,
  fact_type text NOT NULL,
  execution_mode text NOT NULL
    CHECK (execution_mode IN ('normalized_entity', 'semantic_rubric')),
  result text NOT NULL CHECK (result IN ('matched', 'not_matched', 'unknown')),
  normalized_value jsonb NOT NULL,
  qualifier text,
  evidence jsonb NOT NULL,
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  extractor text NOT NULL CHECK (extractor IN ('alias', 'llm', 'none')),
  model_version text,
  prompt_version text NOT NULL,
  catalog_version text NOT NULL,
  rubric_version text,
  runtime_mode text NOT NULL CHECK (runtime_mode IN ('shadow', 'active')),
  reason_codes jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (candidate_position_state_id, criterion_id)
);

CREATE INDEX IF NOT EXISTS semantic_evaluations_state_idx
  ON semantic_evaluations (candidate_position_state_id, created_at);

CREATE INDEX IF NOT EXISTS semantic_evaluations_versions_idx
  ON semantic_evaluations (model_version, prompt_version, catalog_version);
