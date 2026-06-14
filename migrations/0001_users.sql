CREATE TABLE users (
  id                  TEXT PRIMARY KEY,
  clerk_id            TEXT NOT NULL UNIQUE,
  username            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name        TEXT NOT NULL,
  email               TEXT NOT NULL UNIQUE COLLATE NOCASE,
  avatar_url          TEXT,
  bio                 TEXT,
  tier                TEXT NOT NULL DEFAULT 'explorer'
                        CHECK (tier IN ('explorer', 'contender', 'sovereign')),
  league              TEXT NOT NULL DEFAULT 'bronze'
                        CHECK (league IN ('bronze', 'silver', 'gold', 'sovereign')),
  aurum_score         INTEGER NOT NULL DEFAULT 0,
  score_last_calc_at  TEXT,
  streak_current      INTEGER NOT NULL DEFAULT 0,
  streak_longest      INTEGER NOT NULL DEFAULT 0,
  streak_last_post_at TEXT,
  total_tips_sent_cents     INTEGER NOT NULL DEFAULT 0,
  total_tips_received_cents INTEGER NOT NULL DEFAULT 0,
  total_challenges_won      INTEGER NOT NULL DEFAULT 0,
  stealth_mode        INTEGER NOT NULL DEFAULT 0 CHECK (stealth_mode IN (0, 1)),
  stealth_username    TEXT UNIQUE,
  is_verified         INTEGER NOT NULL DEFAULT 0 CHECK (is_verified IN (0, 1)),
  is_founding_member  INTEGER NOT NULL DEFAULT 0 CHECK (is_founding_member IN (0, 1)),
  is_suspended        INTEGER NOT NULL DEFAULT 0 CHECK (is_suspended IN (0, 1)),
  suspension_reason   TEXT,
  stripe_customer_id  TEXT UNIQUE,
  kyc_status          TEXT NOT NULL DEFAULT 'none'
                        CHECK (kyc_status IN ('none', 'pending', 'approved', 'rejected')),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at          TEXT
);

CREATE INDEX idx_users_league_score ON users (league, aurum_score DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_tier ON users (tier) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_clerk_id ON users (clerk_id);
CREATE INDEX idx_users_tips_sent ON users (total_tips_sent_cents DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_challenges_won ON users (total_challenges_won DESC) WHERE deleted_at IS NULL; 
