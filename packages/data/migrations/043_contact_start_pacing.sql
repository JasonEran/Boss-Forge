-- Processing time counts towards the interval; per-account dispatch stays serial.
ALTER TABLE contact_intents DROP CONSTRAINT contact_intents_interval_seconds_check;
ALTER TABLE contact_intents ADD CONSTRAINT contact_intents_interval_seconds_check
  CHECK (interval_seconds BETWEEN 10 AND 600);
ALTER TABLE contact_intents ALTER COLUMN interval_seconds SET DEFAULT 10;
