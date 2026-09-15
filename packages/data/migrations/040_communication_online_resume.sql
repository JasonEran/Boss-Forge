-- Online résumés from native inbox conversations do not create screening tasks.
CREATE TABLE communication_online_resumes (
  conversation_id uuid PRIMARY KEY REFERENCES communication_threads(id) ON DELETE CASCADE,
  boss_account_id text NOT NULL,
  geek_id text NOT NULL,
  snapshot jsonb NOT NULL,
  captured_at timestamptz NOT NULL
);
