 CREATE TABLE posts (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content             TEXT NOT NULL,
  media_urls          TEXT,
  achievement_category TEXT
                        CHECK (achievement_category IN (
                          'revenue_milestone', 'deal_closed', 'business_launched',
                          'investment', 'lifestyle_win', 'challenge_win', 'other'
                        )),
  tags                TEXT,
  stake_amount_cents  INTEGER NOT NULL DEFAULT 0,
  stake_status        TEXT NOT NULL DEFAULT 'none'
                        CHECK (stake_status IN ('none', 'staked', 'verified', 'disputed', 'forfeited')),
  stake_stripe_payment_intent TEXT,
  stake_verified_at   TEXT,
  stake_forfeited_at  TEXT,
  tips_received_cents INTEGER NOT NULL DEFAULT 0,
  tip_count           INTEGER NOT NULL DEFAULT 0,
  reaction_count      INTEGER NOT NULL DEFAULT 0,
  comment_count       INTEGER NOT NULL DEFAULT 0,
  flag_count          INTEGER NOT NULL DEFAULT 0,
  boosted_until       TEXT,
  boost_amount_cents  INTEGER,
  is_pinned           INTEGER NOT NULL DEFAULT 0,
  visibility          TEXT NOT NULL DEFAULT 'public'
                        CHECK (visibility IN ('public', 'members_only', 'league_only')),
  moderation_status   TEXT NOT NULL DEFAULT 'active'
                        CHECK (moderation_status IN ('active', 'under_review', 'removed')),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at          TEXT
);

CREATE INDEX idx_posts_user ON posts (user_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_posts_feed ON posts (created_at DESC, moderation_status) WHERE deleted_at IS NULL;
CREATE INDEX idx_posts_boosted ON posts (boosted_until DESC) WHERE deleted_at IS NULL AND boosted_until IS NOT NULL;
CREATE INDEX idx_posts_stake ON posts (stake_status) WHERE stake_status != 'none';
