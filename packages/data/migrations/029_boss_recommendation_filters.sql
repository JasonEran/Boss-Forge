-- NULL preserves the context of previously collected tasks. New collections
-- record the verified official filters before any resume is queued.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_boss_filters jsonb;
