DROP INDEX IF EXISTS message_templates_position_uidx;
CREATE UNIQUE INDEX message_templates_position_name_uidx ON message_templates(position_id, name) WHERE position_id IS NOT NULL;
ALTER TABLE contact_intents ADD COLUMN interval_seconds integer NOT NULL DEFAULT 60 CHECK (interval_seconds BETWEEN 60 AND 600);
