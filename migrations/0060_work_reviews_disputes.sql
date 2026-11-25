-- ============================================================
-- AURUM STAGE 4: WORK REVIEWS AND DISPUTES
-- Reviews are immutable. Dispute messages are append-only.
-- Admin resolution records a decision only; it performs
-- NO wallet, ledger, escrow, refund or settlement operation.
-- ============================================================

-- ------------------------------------------------------------
-- 1. WORK REVIEWS
-- One review in each direction per engagement.
-- A Crew is reviewed as a Crew, not as its Captain.
-- ------------------------------------------------------------

CREATE TABLE work_reviews (
  id TEXT PRIMARY KEY,

  engagement_id TEXT NOT NULL
    REFERENCES work_engagements(id) ON DELETE RESTRICT,

  reviewer_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,

  direction TEXT NOT NULL
    CHECK (direction IN (
      'client_to_provider',
      'provider_to_client'
    )),

  reviewee_type TEXT NOT NULL
    CHECK (reviewee_type IN ('user', 'crew')),

  reviewee_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  reviewee_crew_id TEXT REFERENCES crews(id) ON DELETE RESTRICT,

  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review_text TEXT,

  created_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  ),

  UNIQUE(engagement_id, direction),

  CHECK (
    (reviewee_type = 'user'
      AND reviewee_user_id IS NOT NULL
      AND reviewee_crew_id IS NULL)
    OR
    (reviewee_type = 'crew'
      AND reviewee_crew_id IS NOT NULL
      AND reviewee_user_id IS NULL)
  ),

  CHECK (
    review_text IS NULL OR LENGTH(review_text) <= 3000
  )
);

CREATE INDEX idx_work_reviews_reviewee_user
ON work_reviews(reviewee_user_id, created_at DESC);

CREATE INDEX idx_work_reviews_reviewee_crew
ON work_reviews(reviewee_crew_id, created_at DESC);

CREATE INDEX idx_work_reviews_engagement
ON work_reviews(engagement_id);


-- Reviews cannot be edited or deleted after submission.
CREATE TRIGGER work_reviews_prevent_update
BEFORE UPDATE ON work_reviews
BEGIN
  SELECT RAISE(ABORT, 'Work reviews are immutable');
END;

CREATE TRIGGER work_reviews_prevent_delete
BEFORE DELETE ON work_reviews
BEGIN
  SELECT RAISE(ABORT, 'Work reviews are immutable');
END;


-- ------------------------------------------------------------
-- 2. WORK DISPUTES
-- One formal dispute per engagement.
-- ------------------------------------------------------------

CREATE TABLE work_disputes (
  id TEXT PRIMARY KEY,

  engagement_id TEXT NOT NULL UNIQUE
    REFERENCES work_engagements(id) ON DELETE RESTRICT,

  opened_by_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,

  category TEXT NOT NULL,
  description TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN (
      'open',
      'under_review',
      'resolved',
      'closed'
    )),

  resolution_summary TEXT,
  resolved_by_admin_id TEXT REFERENCES users(id) ON DELETE RESTRICT,

  created_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  ),

  updated_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  ),

  resolved_at TEXT,

  CHECK (LENGTH(category) BETWEEN 2 AND 80),
  CHECK (LENGTH(description) BETWEEN 10 AND 12000),
  CHECK (
    resolution_summary IS NULL
    OR LENGTH(resolution_summary) <= 12000
  ),

  CHECK (
    (status IN ('open', 'under_review')
      AND resolved_at IS NULL
      AND resolved_by_admin_id IS NULL
      AND resolution_summary IS NULL)
    OR
    (status IN ('resolved', 'closed')
      AND resolved_at IS NOT NULL
      AND resolved_by_admin_id IS NOT NULL
      AND resolution_summary IS NOT NULL)
  )
);

CREATE INDEX idx_work_disputes_status
ON work_disputes(status, created_at DESC);

CREATE INDEX idx_work_disputes_opener
ON work_disputes(opened_by_user_id, created_at DESC);


-- ------------------------------------------------------------
-- 3. DISPUTE DISCUSSION
-- Messages are append-only. No file uploads or arbitrary
-- external attachment URLs are accepted in this release.
-- ------------------------------------------------------------

CREATE TABLE work_dispute_messages (
  id TEXT PRIMARY KEY,

  dispute_id TEXT NOT NULL
    REFERENCES work_disputes(id) ON DELETE RESTRICT,

  author_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,

  message TEXT NOT NULL
    CHECK (LENGTH(message) BETWEEN 2 AND 12000),

  author_type TEXT NOT NULL DEFAULT 'participant'
    CHECK (author_type IN ('participant', 'platform_admin')),

  created_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  )
);

CREATE INDEX idx_work_dispute_messages
ON work_dispute_messages(dispute_id, created_at ASC);

CREATE TRIGGER work_dispute_messages_prevent_update
BEFORE UPDATE ON work_dispute_messages
BEGIN
  SELECT RAISE(ABORT, 'Dispute messages are immutable');
END;

CREATE TRIGGER work_dispute_messages_prevent_delete
BEFORE DELETE ON work_dispute_messages
BEGIN
  SELECT RAISE(ABORT, 'Dispute messages are immutable');
END;
