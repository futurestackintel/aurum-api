 CREATE TABLE leaderboard_snapshots (
  id          TEXT PRIMARY KEY,
  board_type  TEXT NOT NULL
                CHECK (board_type IN ('most_generous', 'highest_earner', 'most_wins', 'aurum_score')),
  league      TEXT CHECK (league IN ('bronze', 'silver', 'gold', 'sovereign', 'all')),
  period      TEXT NOT NULL
                CHECK (period IN ('daily', 'weekly', 'monthly', 'alltime')),
  period_key  TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id),
  rank        INTEGER NOT NULL,
  score       INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url  TEXT,
  league_at_snapshot TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_leaderboard_board_period ON leaderboard_snapshots (board_type, period, period_key, rank ASC);
CREATE INDEX idx_leaderboard_user ON leaderboard_snapshots (user_id, period);

CREATE TABLE aurum_score_events (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL
                CHECK (event_type IN (
                  'achievement_verified', 'challenge_won', 'tip_sent',
                  'tip_received', 'reaction_received', 'streak_maintained',
                  'badge_earned', 'account_age_bonus', 'stake_forfeited_penalty'
                )),
  delta       INTEGER NOT NULL,
  score_after INTEGER NOT NULL,
  reference_id TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_score_events_user ON aurum_score_events (user_id, created_at DESC);
CREATE INDEX idx_score_events_type ON aurum_score_events (event_type, created_at DESC);

CREATE TABLE boost_tokens (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users(id),
  post_id               TEXT NOT NULL REFERENCES posts(id),
  amount_paid_cents     INTEGER NOT NULL,
  stripe_payment_intent TEXT NOT NULL UNIQUE,
  boost_duration_hours  INTEGER NOT NULL DEFAULT 24,
  boosted_from          TEXT NOT NULL,
  boosted_until         TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'expired', 'cancelled')),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_boost_user ON boost_tokens (user_id);
CREATE INDEX idx_boost_active ON boost_tokens (boosted_until) WHERE status = 'active';

CREATE TABLE waitlist (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  referrer    TEXT,
  position    INTEGER,
  is_invited  INTEGER NOT NULL DEFAULT 0,
  invited_at  TEXT,
  source      TEXT CHECK (source IN ('landing', 'twitter', 'reddit', 'referral', 'direct')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_waitlist_position ON waitlist (position ASC) WHERE is_invited = 0;

CREATE TABLE platform_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  description TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE subscriptions (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_sub_id       TEXT NOT NULL UNIQUE,
  stripe_price_id     TEXT NOT NULL,
  tier                TEXT NOT NULL CHECK (tier IN ('contender', 'sovereign')),
  status              TEXT NOT NULL
                        CHECK (status IN ('active', 'past_due', 'canceled', 'trialing')),
  current_period_start TEXT NOT NULL,
  current_period_end   TEXT NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_subscriptions_user ON subscriptions (user_id);
CREATE INDEX idx_subscriptions_status ON subscriptions (status);

INSERT INTO platform_config (key, value, description) VALUES
  ('platform_fee_pct',        '5',     'Percentage taken from tips and pools'),
  ('founding_member_fee',     '2000',  'Founding member one-time fee in cents'),
  ('founding_member_cap',     '100',   'Max founding members allowed'),
  ('min_stake_cents',         '500',   'Minimum stake per post in cents'),
  ('max_stake_cents',         '100000','Maximum stake per post in cents'),
  ('min_tip_cents',           '100',   'Minimum tip amount in cents'),
  ('max_tip_cents',           '100000','Maximum tip amount in cents'),
  ('min_challenge_fee_cents', '500',   'Minimum challenge entry fee in cents'),
  ('maintenance_mode',        '0',     'Set to 1 to block non-admin traffic'),
  ('leaderboard_public',      '1',     'Set to 0 to hide from non-members');
