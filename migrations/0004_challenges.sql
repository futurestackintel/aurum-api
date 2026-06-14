CREATE TABLE challenges (
  id                    TEXT PRIMARY KEY,
  creator_id            TEXT NOT NULL REFERENCES users(id),
  title                 TEXT NOT NULL,
  description           TEXT NOT NULL,
  rules                 TEXT,
  challenge_type        TEXT NOT NULL
                          CHECK (challenge_type IN (
                            'revenue', 'deals_closed', 'growth', 'savings',
                            'custom', 'charity_brawl'
                          )),
  verification_method   TEXT NOT NULL
                          CHECK (verification_method IN ('proof_upload', 'honor_system', 'admin_verified')),
  entry_fee_cents       INTEGER NOT NULL DEFAULT 0,
  pool_total_cents      INTEGER NOT NULL DEFAULT 0,
  platform_fee_cents    INTEGER NOT NULL DEFAULT 0,
  charity_amount_cents  INTEGER NOT NULL DEFAULT 0,
  charity_name          TEXT,
  winner_id             TEXT REFERENCES users(id),
  min_tier              TEXT DEFAULT 'explorer'
                          CHECK (min_tier IN ('explorer', 'contender', 'sovereign')),
  max_participants      INTEGER,
  participant_count     INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'open', 'active', 'voting', 'completed', 'cancelled')),
  starts_at             TEXT NOT NULL,
  ends_at               TEXT NOT NULL,
  winner_announced_at   TEXT,
  is_featured           INTEGER NOT NULL DEFAULT 0,
  moderation_status     TEXT NOT NULL DEFAULT 'pending'
                          CHECK (moderation_status IN ('pending', 'approved', 'rejected')),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at            TEXT
);

CREATE INDEX idx_challenges_status ON challenges (status, starts_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_challenges_creator ON challenges (creator_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_challenges_featured ON challenges (is_featured, ends_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_challenges_ends_at ON challenges (ends_at) WHERE status IN ('open', 'active');

CREATE TABLE challenge_entries (
  id                    TEXT PRIMARY KEY,
  challenge_id          TEXT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  user_id               TEXT NOT NULL REFERENCES users(id),
  entry_fee_paid_cents  INTEGER NOT NULL DEFAULT 0,
  stripe_payment_intent TEXT,
  achievement_value     INTEGER,
  achievement_proof_urls TEXT,
  proof_description     TEXT,
  submitted_at          TEXT,
  score                 INTEGER,
  rank                  INTEGER,
  is_winner             INTEGER NOT NULL DEFAULT 0,
  upvotes               INTEGER NOT NULL DEFAULT 0,
  downvotes             INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'entered'
                          CHECK (status IN ('entered', 'submitted', 'verified', 'disqualified', 'won')),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (challenge_id, user_id)
);

CREATE INDEX idx_entries_challenge ON challenge_entries (challenge_id, score DESC);
CREATE INDEX idx_entries_user ON challenge_entries (user_id, created_at DESC);
CREATE INDEX idx_entries_winner ON challenge_entries (challenge_id) WHERE is_winner = 1;

CREATE TABLE treasury_ledger (
  id                    TEXT PRIMARY KEY,
  challenge_id          TEXT NOT NULL REFERENCES challenges(id),
  total_held_cents      INTEGER NOT NULL DEFAULT 0,
  platform_fee_cents    INTEGER NOT NULL DEFAULT 0,
  winner_payout_cents   INTEGER NOT NULL DEFAULT 0,
  charity_payout_cents  INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'holding'
                          CHECK (status IN ('holding', 'releasing', 'released', 'refunded')),
  stripe_transfer_id    TEXT,
  released_at           TEXT,
  refunded_at           TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_treasury_challenge ON treasury_ledger (challenge_id);
CREATE INDEX idx_treasury_status ON treasury_ledger (status) WHERE status = 'holding'; 
