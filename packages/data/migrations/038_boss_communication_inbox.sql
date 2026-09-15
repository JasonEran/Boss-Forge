-- BOSS inbox conversations can exist before a candidate is screened in this platform.
-- Preserve candidate IDs for existing URLs, messages and read markers.
INSERT INTO communication_threads (candidate_id, boss_account_id, geek_id)
SELECT DISTINCT ON (candidate_id) candidate_id, boss_account_id, geek_id
FROM communication_messages
ON CONFLICT DO NOTHING;

ALTER TABLE communication_threads ADD COLUMN id uuid;
UPDATE communication_threads SET id = candidate_id;
ALTER TABLE communication_threads DROP CONSTRAINT communication_threads_pkey;
ALTER TABLE communication_threads ALTER COLUMN candidate_id DROP NOT NULL;
ALTER TABLE communication_threads ADD PRIMARY KEY (id);
ALTER TABLE communication_threads ADD UNIQUE (candidate_id);
ALTER TABLE communication_threads ADD COLUMN candidate_name text NOT NULL DEFAULT '';
ALTER TABLE communication_threads ADD COLUMN boss_job_id text;
ALTER TABLE communication_threads ADD COLUMN position_name text NOT NULL DEFAULT '';
ALTER TABLE communication_threads ADD COLUMN wechat jsonb;
UPDATE communication_threads t SET candidate_name = c.display_name FROM candidates c WHERE c.id = t.candidate_id;

ALTER TABLE communication_messages ADD COLUMN conversation_id uuid REFERENCES communication_threads(id) ON DELETE CASCADE;
UPDATE communication_messages SET conversation_id = candidate_id;
ALTER TABLE communication_messages ALTER COLUMN conversation_id SET NOT NULL;
ALTER TABLE communication_messages ALTER COLUMN candidate_id DROP NOT NULL;
CREATE INDEX communication_messages_conversation_time ON communication_messages(conversation_id, sent_at DESC, id DESC);

ALTER TABLE communication_reads ADD COLUMN conversation_id uuid REFERENCES communication_threads(id) ON DELETE CASCADE;
UPDATE communication_reads SET conversation_id = candidate_id;
ALTER TABLE communication_reads DROP CONSTRAINT communication_reads_pkey;
ALTER TABLE communication_reads ALTER COLUMN candidate_id DROP NOT NULL;
ALTER TABLE communication_reads ADD PRIMARY KEY(conversation_id, user_id);

CREATE TABLE communication_quick_replies (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 500),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX communication_quick_replies_owner ON communication_quick_replies(user_id, updated_at DESC);

CREATE TABLE communication_wechat_actions (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES communication_threads(id) ON DELETE CASCADE,
  boss_account_id text NOT NULL,
  geek_id text NOT NULL,
  sender_id uuid NOT NULL REFERENCES users(id),
  client_request_id uuid NOT NULL,
  status text NOT NULL CHECK(status IN ('queued','sending','sent','failed','uncertain')),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  receipt jsonb,
  UNIQUE(sender_id, client_request_id)
);
CREATE UNIQUE INDEX communication_wechat_active ON communication_wechat_actions(boss_account_id)
  WHERE status IN ('queued','sending');
CREATE INDEX communication_wechat_conversation ON communication_wechat_actions(conversation_id, created_at DESC);
