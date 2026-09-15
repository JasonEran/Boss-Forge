CREATE UNIQUE INDEX IF NOT EXISTS message_templates_position_uidx
  ON message_templates (position_id)
  WHERE position_id IS NOT NULL;

ALTER TABLE template_versions
  DROP CONSTRAINT IF EXISTS template_versions_body_length_check;

ALTER TABLE template_versions
  ADD CONSTRAINT template_versions_body_length_check
  CHECK (char_length(body) BETWEEN 1 AND 500);
