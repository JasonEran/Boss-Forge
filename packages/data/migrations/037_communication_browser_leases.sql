-- A visible communication page temporarily owns the browser. Closing a page
-- records a tombstone so an in-flight enter request cannot pause work again.
CREATE TABLE communication_browser_leases (
  id uuid PRIMARY KEY,
  boss_account_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX communication_browser_leases_active_idx
  ON communication_browser_leases (boss_account_id, expires_at)
  WHERE released_at IS NULL;
