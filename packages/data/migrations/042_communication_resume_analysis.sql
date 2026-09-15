-- Image delivery and text/qualification processing have independent lifetimes.
ALTER TABLE communication_online_resumes
  ADD COLUMN analysis_claim_id uuid,
  ADD COLUMN analysis_claimed_at timestamptz;
CREATE INDEX communication_resume_analysis_pending_idx
  ON communication_online_resumes (boss_account_id, captured_at)
  WHERE snapshot->>'textStatus' IN ('pending','processing');
