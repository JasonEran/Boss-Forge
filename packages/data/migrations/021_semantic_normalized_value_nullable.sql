-- Unknown semantic evaluations intentionally use NULL as their normalized value.
-- Keep the database contract aligned with SemanticJsonValue, which includes null.
ALTER TABLE semantic_evaluations
  ALTER COLUMN normalized_value DROP NOT NULL;
