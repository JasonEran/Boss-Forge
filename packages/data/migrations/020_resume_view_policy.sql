CREATE INDEX IF NOT EXISTS audit_resume_view_account_time_idx
  ON audit_logs ((payload ->> 'bossAccountId'), created_at DESC)
  WHERE action = 'candidate.resume_viewed';
