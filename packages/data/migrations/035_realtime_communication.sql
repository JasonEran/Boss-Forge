CREATE TABLE communication_threads (
  candidate_id uuid PRIMARY KEY REFERENCES candidates(id) ON DELETE CASCADE,
  boss_account_id text NOT NULL,
  geek_id text NOT NULL,
  provider_conversation_id text,
  unread_count integer NOT NULL DEFAULT 0,
  preview text NOT NULL DEFAULT '',
  synced_at timestamptz,
  inbox_synced_at timestamptz,
  history_limited boolean NOT NULL DEFAULT true,
  UNIQUE (boss_account_id, geek_id)
);

CREATE TABLE communication_messages (
  id uuid PRIMARY KEY,
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  boss_account_id text NOT NULL,
  geek_id text NOT NULL,
  provider_message_id text,
  provider_conversation_id text,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound','system')),
  kind text NOT NULL DEFAULT 'text' CHECK (kind IN ('text','image','file','card','system')),
  body text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','sending','sent','failed','uncertain')),
  sender_id uuid REFERENCES users(id),
  client_request_id uuid,
  candidate_position_state_id uuid REFERENCES candidate_position_states(id),
  sent_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  error text,
  receipt jsonb,
  UNIQUE (sender_id, client_request_id),
  UNIQUE (boss_account_id, geek_id, provider_message_id)
);
CREATE INDEX communication_messages_thread_time ON communication_messages (candidate_id, sent_at DESC, id DESC);
CREATE UNIQUE INDEX communication_messages_active_send ON communication_messages (boss_account_id)
  WHERE status IN ('queued','sending');

CREATE TABLE communication_reads (
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_through timestamptz NOT NULL,
  PRIMARY KEY (candidate_id, user_id)
);
