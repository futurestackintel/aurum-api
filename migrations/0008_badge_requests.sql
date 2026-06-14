-- Migration 0008: Badge Requests (verification workflow staging table)
-- Depends on: users table (0001), badges table (0006)

CREATE TABLE IF NOT EXISTS badge_requests (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_type   TEXT NOT NULL
                 CHECK (badge_type IN (
                   'verified_builder', 'verified_founder',
                   'verified_millionaire', 'sovereign_elite'
                 )),
  evidence_url TEXT NOT NULL,
  notes        TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'rejected')),
  admin_id     TEXT,
  reason       TEXT,
  submitted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  decided_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_badge_req_user   ON badge_requests (user_id);
CREATE INDEX IF NOT EXISTS idx_badge_req_status ON badge_requests (status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_badge_req_type   ON badge_requests (badge_type);