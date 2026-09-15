-- Recruitment follow-up is independent of a screening run. Native conversations
-- can be filed without inventing tasks, resumes, scores, or review outcomes.
CREATE TABLE recruitment_cases (
  id uuid PRIMARY KEY,
  candidate_id uuid NOT NULL REFERENCES candidates(id),
  position_id uuid NOT NULL REFERENCES positions(id),
  conversation_id uuid REFERENCES communication_threads(id),
  source_state_id uuid REFERENCES candidate_position_states(id),
  owner_id uuid NOT NULL REFERENCES users(id),
  created_by uuid NOT NULL REFERENCES users(id),
  stage text NOT NULL DEFAULT 'review' CHECK(stage IN ('review','communicating','interview','offer','hired','rejected','withdrawn','no_show')),
  review_status text NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','approved','rejected')),
  close_reason text NOT NULL DEFAULT '',
  next_followup_at timestamptz,
  followup_note text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(candidate_id,position_id),
  CHECK(review_status='approved' OR stage IN ('review','rejected','withdrawn'))
);
CREATE INDEX recruitment_cases_work ON recruitment_cases(position_id,stage,next_followup_at);
CREATE INDEX recruitment_cases_conversation ON recruitment_cases(conversation_id);

CREATE TABLE recruitment_case_events (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE recruitment_interviews (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  location text NOT NULL,
  interviewer_ids uuid[] NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','confirmed','completed','cancelled','no_show')),
  invitation_message_id uuid REFERENCES communication_messages(id),
  confirmation_note text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(ends_at>starts_at)
);
CREATE TABLE recruitment_interview_feedback (
  interview_id uuid NOT NULL REFERENCES recruitment_interviews(id) ON DELETE CASCADE,
  reviewer_id uuid NOT NULL REFERENCES users(id),
  recommendation text NOT NULL CHECK(recommendation IN ('yes','mixed','no')),
  score integer NOT NULL CHECK(score BETWEEN 1 AND 5),
  body text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(interview_id,reviewer_id)
);

CREATE TABLE recruitment_offers (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  salary_monthly numeric(12,2) NOT NULL CHECK(salary_monthly>0),
  salary_months integer NOT NULL CHECK(salary_months BETWEEN 1 AND 24),
  start_date date NOT NULL,
  expires_at timestamptz NOT NULL,
  terms text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending_approval','approved','sent','accepted','declined','withdrawn')),
  created_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  response_note text NOT NULL DEFAULT '',
  response_message_id uuid REFERENCES communication_messages(id),
  delivery_message_id uuid REFERENCES communication_messages(id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX recruitment_offer_open ON recruitment_offers(case_id) WHERE status NOT IN ('declined','withdrawn');
CREATE TABLE recruitment_onboarding_items (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  title text NOT NULL,
  required boolean NOT NULL DEFAULT true,
  completed_at timestamptz,
  completed_by uuid REFERENCES users(id),
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE recruitment_onboarding (
  case_id uuid PRIMARY KEY REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  actual_start_date date,
  note text NOT NULL DEFAULT '',
  confirmed_by uuid REFERENCES users(id),
  confirmed_at timestamptz
);
CREATE TABLE recruitment_deliveries (
  message_id uuid PRIMARY KEY REFERENCES communication_messages(id),
  case_id uuid NOT NULL REFERENCES recruitment_cases(id),
  kind text NOT NULL CHECK(kind IN ('interview','offer')),
  record_id uuid NOT NULL,
  record_version integer NOT NULL
);

ALTER TABLE communication_messages ADD COLUMN assets jsonb NOT NULL DEFAULT '[]';
ALTER TABLE communication_threads ADD COLUMN contact_details jsonb NOT NULL DEFAULT '{}';
ALTER TABLE communication_threads ADD COLUMN native_actions jsonb NOT NULL DEFAULT '{}';
ALTER TABLE communication_wechat_actions ADD COLUMN action_kind text NOT NULL DEFAULT 'wechat' CHECK(action_kind IN ('wechat','resume'));

CREATE INDEX recruitment_case_events_history ON recruitment_case_events(case_id,created_at DESC);
CREATE INDEX recruitment_interviews_case ON recruitment_interviews(case_id,starts_at DESC);
CREATE INDEX recruitment_interviews_attendees ON recruitment_interviews USING gin(interviewer_ids);
CREATE INDEX recruitment_offers_case ON recruitment_offers(case_id,created_at DESC);
CREATE INDEX recruitment_onboarding_items_case ON recruitment_onboarding_items(case_id);
CREATE INDEX communication_native_action_history ON communication_wechat_actions(conversation_id,action_kind,created_at DESC);
