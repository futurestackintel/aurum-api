-- ============================================================
-- AURUM STAGE 4: WORK FOUNDATION
-- Core marketplace, applications, engagements and delivery.
--
-- Financial settlement, escrow, platform fees, reviews and
-- dispute-resolution rules are intentionally excluded.
-- All monetary values are integer minor units.
-- ============================================================

-- ------------------------------------------------------------
-- 1. WORK OPPORTUNITIES
-- ------------------------------------------------------------

CREATE TABLE work_opportunities (
  id TEXT PRIMARY KEY,
  client_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT,
  skills TEXT,

  applicant_eligibility TEXT NOT NULL DEFAULT 'individuals'
    CHECK (applicant_eligibility IN ('individuals', 'crews', 'both')),

  pricing_model TEXT NOT NULL
    CHECK (pricing_model IN ('fixed', 'hourly')),

  currency TEXT NOT NULL
    CHECK (
      LENGTH(currency) = 3
      AND currency = UPPER(currency)
    ),

  fixed_budget_minor INTEGER,
  hourly_rate_minor INTEGER,
  spending_limit_minor INTEGER,

  multi_hire_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (multi_hire_enabled IN (0, 1)),

  hire_capacity INTEGER NOT NULL DEFAULT 1
    CHECK (hire_capacity BETWEEN 1 AND 100),

  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN (
      'draft',
      'open',
      'paused',
      'filled',
      'cancelled',
      'closed'
    )),

  created_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  ),

  updated_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  ),

  published_at TEXT,

  CHECK (
    (pricing_model = 'fixed'
      AND fixed_budget_minor IS NOT NULL
      AND fixed_budget_minor > 0
      AND hourly_rate_minor IS NULL
      AND spending_limit_minor IS NULL)
    OR
    (pricing_model = 'hourly'
      AND hourly_rate_minor IS NOT NULL
      AND hourly_rate_minor > 0
      AND spending_limit_minor IS NOT NULL
      AND spending_limit_minor > 0
      AND fixed_budget_minor IS NULL)
  ),

  CHECK (
    (multi_hire_enabled = 0 AND hire_capacity = 1)
    OR
    (multi_hire_enabled = 1 AND hire_capacity >= 1)
  )
);

CREATE INDEX idx_work_opportunities_discovery
ON work_opportunities(status, created_at DESC);

CREATE INDEX idx_work_opportunities_client
ON work_opportunities(client_user_id, created_at DESC);


-- ------------------------------------------------------------
-- 2. WORK APPLICATIONS
-- An application belongs to either one individual or one Crew.
-- ------------------------------------------------------------

CREATE TABLE work_applications (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL
    REFERENCES work_opportunities(id) ON DELETE RESTRICT,

  applicant_type TEXT NOT NULL
    CHECK (applicant_type IN ('individual', 'crew')),

applicant_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
applicant_crew_id TEXT REFERENCES crews(id) ON DELETE RESTRICT,

submitted_by_user_id TEXT NOT NULL
  REFERENCES users(id) ON DELETE RESTRICT,

cover_message TEXT NOT NULL,
  proposed_fixed_amount_minor INTEGER,
  proposed_hourly_rate_minor INTEGER,

  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN (
      'submitted',
      'under_review',
      'shortlisted',
      'accepted',
      'rejected',
      'withdrawn'
    )),

  created_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  ),

  updated_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  ),

  CHECK (
    (applicant_type = 'individual'
      AND applicant_user_id IS NOT NULL
      AND applicant_crew_id IS NULL)
    OR
    (applicant_type = 'crew'
      AND applicant_crew_id IS NOT NULL
      AND applicant_user_id IS NULL)
  ),

  CHECK (
    (proposed_fixed_amount_minor IS NULL
      OR proposed_fixed_amount_minor > 0)
    AND
    (proposed_hourly_rate_minor IS NULL
      OR proposed_hourly_rate_minor > 0)
  ),

  UNIQUE(opportunity_id, applicant_user_id),
  UNIQUE(opportunity_id, applicant_crew_id)
);

CREATE INDEX idx_work_applications_opportunity
ON work_applications(opportunity_id, status, created_at DESC);

CREATE INDEX idx_work_applications_user
ON work_applications(applicant_user_id, created_at DESC);

CREATE INDEX idx_work_applications_crew
ON work_applications(applicant_crew_id, created_at DESC);


-- ------------------------------------------------------------
-- 3. CREW APPLICATION MEMBER PROPOSALS
-- Records which Crew members are proposed for the engagement.
-- ------------------------------------------------------------

CREATE TABLE work_application_crew_members (
  id TEXT PRIMARY KEY,

  application_id TEXT NOT NULL
    REFERENCES work_applications(id) ON DELETE RESTRICT,

  crew_id TEXT NOT NULL REFERENCES crews(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  proposed_role TEXT NOT NULL,

  membership_confirmed_at TEXT,

  role_accepted INTEGER NOT NULL DEFAULT 0
    CHECK (role_accepted IN (0, 1)),

  role_accepted_at TEXT,

  created_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  ),

  UNIQUE(application_id, user_id),

  CHECK (
    (role_accepted = 0 AND role_accepted_at IS NULL)
    OR
    (role_accepted = 1 AND role_accepted_at IS NOT NULL)
  )
);

CREATE INDEX idx_work_application_crew_members
ON work_application_crew_members(application_id, crew_id);


-- ------------------------------------------------------------
-- 4. CREW APPLICATION GOVERNANCE APPROVALS
-- Individual votes are retained for an auditable decision.
-- Captain approval is independently mandatory.
-- ------------------------------------------------------------

CREATE TABLE work_crew_application_approvals (
  id TEXT PRIMARY KEY,

  application_id TEXT NOT NULL
    REFERENCES work_applications(id) ON DELETE RESTRICT,

  crew_id TEXT NOT NULL REFERENCES crews(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  vote TEXT NOT NULL
    CHECK (vote IN ('approve', 'reject')),

  is_captain_approval INTEGER NOT NULL DEFAULT 0
    CHECK (is_captain_approval IN (0, 1)),

  eligible_member_snapshot INTEGER NOT NULL
  CHECK (eligible_member_snapshot IN (0, 1)),

eligible_member_count_snapshot INTEGER NOT NULL
  CHECK (eligible_member_count_snapshot > 0),

created_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  ),

  UNIQUE(application_id, user_id)
);

CREATE INDEX idx_work_crew_application_approvals
ON work_crew_application_approvals(application_id, crew_id);


-- ------------------------------------------------------------
-- 5. WORK ENGAGEMENTS
-- Each successful hire receives a separate engagement.
-- No payment-hold or escrow assumptions are made here.
-- ------------------------------------------------------------

CREATE TABLE work_engagements (
  id TEXT PRIMARY KEY,

  opportunity_id TEXT NOT NULL
    REFERENCES work_opportunities(id) ON DELETE RESTRICT,

  application_id TEXT NOT NULL UNIQUE
    REFERENCES work_applications(id) ON DELETE RESTRICT,

  client_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,

  provider_type TEXT NOT NULL
    CHECK (provider_type IN ('individual', 'crew')),

  provider_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  provider_crew_id TEXT REFERENCES crews(id) ON DELETE RESTRICT,

  pricing_model TEXT NOT NULL
    CHECK (pricing_model IN ('fixed', 'hourly')),

  currency TEXT NOT NULL
    CHECK (
      LENGTH(currency) = 3
      AND currency = UPPER(currency)
    ),

  agreed_fixed_amount_minor INTEGER,
  agreed_hourly_rate_minor INTEGER,
  agreed_spending_limit_minor INTEGER,

  status TEXT NOT NULL DEFAULT 'pending_acceptance'
    CHECK (status IN (
      'pending_acceptance',
      'active',
      'submitted',
      'revision_requested',
      'completed',
      'cancelled',
      'disputed'
    )),

  activated_at TEXT,
  completed_at TEXT,

  created_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  ),

  updated_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  ),

  CHECK (
    (provider_type = 'individual'
      AND provider_user_id IS NOT NULL
      AND provider_crew_id IS NULL)
    OR
    (provider_type = 'crew'
      AND provider_crew_id IS NOT NULL
      AND provider_user_id IS NULL)
  ),

  CHECK (
    (pricing_model = 'fixed'
      AND agreed_fixed_amount_minor IS NOT NULL
      AND agreed_fixed_amount_minor > 0
      AND agreed_hourly_rate_minor IS NULL
      AND agreed_spending_limit_minor IS NULL)
    OR
    (pricing_model = 'hourly'
      AND agreed_hourly_rate_minor IS NOT NULL
      AND agreed_hourly_rate_minor > 0
      AND agreed_spending_limit_minor IS NOT NULL
      AND agreed_spending_limit_minor > 0
      AND agreed_fixed_amount_minor IS NULL)
  )
);

CREATE INDEX idx_work_engagements_client
ON work_engagements(client_user_id, created_at DESC);

CREATE INDEX idx_work_engagements_user
ON work_engagements(provider_user_id, created_at DESC);

CREATE INDEX idx_work_engagements_crew
ON work_engagements(provider_crew_id, created_at DESC);


-- ------------------------------------------------------------
-- 6. ENGAGEMENT PARTICIPANTS
-- Explicit acceptance is required for every selected member.
-- ------------------------------------------------------------

CREATE TABLE work_engagement_participants (
  id TEXT PRIMARY KEY,

  engagement_id TEXT NOT NULL
    REFERENCES work_engagements(id) ON DELETE RESTRICT,

  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  assigned_role TEXT NOT NULL,

  accepted_at TEXT,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined', 'removed')),

  created_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  ),

  UNIQUE(engagement_id, user_id),

  CHECK (
    (status = 'accepted' AND accepted_at IS NOT NULL)
    OR
    (status <> 'accepted')
  )
);

CREATE INDEX idx_work_engagement_participants
ON work_engagement_participants(engagement_id, status);

-- ------------------------------------------------------------
-- 4B. IMMUTABLE CREW APPLICATION VOTER SNAPSHOT
-- Captures eligible voters and their roles at proposal submission.
-- ------------------------------------------------------------

CREATE TABLE work_crew_application_voter_snapshot (
  id TEXT PRIMARY KEY,

  application_id TEXT NOT NULL
    REFERENCES work_applications(id) ON DELETE RESTRICT,

  crew_id TEXT NOT NULL
    REFERENCES crews(id) ON DELETE RESTRICT,

  user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,

  role_snapshot TEXT NOT NULL,

  created_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  ),

  UNIQUE(application_id, user_id)
);

CREATE INDEX idx_work_crew_voter_snapshot
ON work_crew_application_voter_snapshot(application_id, crew_id);


-- ------------------------------------------------------------
-- 7. FIXED-PRICE MILESTONES
-- ------------------------------------------------------------

CREATE TABLE work_milestones (
  id TEXT PRIMARY KEY,

  engagement_id TEXT NOT NULL
    REFERENCES work_engagements(id) ON DELETE RESTRICT,

  title TEXT NOT NULL,
  description TEXT,

  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),

  due_at TEXT,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending',
      'in_progress',
      'submitted',
      'revision_requested',
      'approved',
      'cancelled'
    )),

  position INTEGER NOT NULL DEFAULT 0,

  created_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  ),

  updated_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  )
);

CREATE INDEX idx_work_milestones_engagement
ON work_milestones(engagement_id, position);


-- ------------------------------------------------------------
-- 8. WORK SUBMISSIONS
-- ------------------------------------------------------------

CREATE TABLE work_submissions (
  id TEXT PRIMARY KEY,

  engagement_id TEXT NOT NULL
    REFERENCES work_engagements(id) ON DELETE RESTRICT,

  milestone_id TEXT REFERENCES work_milestones(id) ON DELETE RESTRICT,

  submitted_by_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,

  message TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN (
      'submitted',
      'revision_requested',
      'approved',
      'rejected'
    )),

  submitted_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  ),

  reviewed_at TEXT,
  reviewed_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX idx_work_submissions_engagement
ON work_submissions(engagement_id, submitted_at DESC);


-- ------------------------------------------------------------
-- 9. WORK SUBMISSION REVISIONS
-- Retains the revision history instead of overwriting submissions.
-- ------------------------------------------------------------

CREATE TABLE work_submission_revisions (
  id TEXT PRIMARY KEY,

  submission_id TEXT NOT NULL
    REFERENCES work_submissions(id) ON DELETE RESTRICT,

  author_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,

  message TEXT NOT NULL,

  created_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  )
);

CREATE INDEX idx_work_submission_revisions
ON work_submission_revisions(submission_id, created_at);


-- ------------------------------------------------------------
-- 10. HOURLY TIME ENTRIES
-- Provider-submitted records; no surveillance tracking.
-- ------------------------------------------------------------

CREATE TABLE work_time_entries (
  id TEXT PRIMARY KEY,

  engagement_id TEXT NOT NULL
    REFERENCES work_engagements(id) ON DELETE RESTRICT,

  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  description TEXT NOT NULL,

  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,

  duration_minutes INTEGER NOT NULL
    CHECK (duration_minutes > 0),

  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN (
      'submitted',
      'approved',
      'rejected',
      'disputed'
    )),

  submitted_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  ),

  reviewed_at TEXT,
  reviewed_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,

  CHECK (ended_at > started_at)
);

CREATE INDEX idx_work_time_entries_engagement
ON work_time_entries(engagement_id, submitted_at DESC);

CREATE INDEX idx_work_time_entries_user
ON work_time_entries(user_id, submitted_at DESC);
