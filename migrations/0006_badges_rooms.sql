 CREATE TABLE badges (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_type    TEXT NOT NULL
                  CHECK (badge_type IN (
                    'verified_builder', 'verified_founder', 'verified_millionaire',
                    'sovereign_elite', 'founding_member', 'streak_30', 'streak_90',
                    'top_donor', 'challenge_champion', 'first_win'
                  )),
  awarded_by    TEXT CHECK (awarded_by IN ('system', 'admin', 'verification')),
  evidence_url  TEXT,
  is_public     INTEGER NOT NULL DEFAULT 1,
  verified_at   TEXT,
  revoked_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (user_id, badge_type)
);

CREATE INDEX idx_badges_user ON badges (user_id) WHERE revoked_at IS NULL;

CREATE TABLE elite_rooms (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  category      TEXT NOT NULL
                  CHECK (category IN (
                    'saas_founders', 'investors', 'crypto_builders',
                    'ecommerce_operators', 'real_estate', 'general'
                  )),
  created_by    TEXT NOT NULL REFERENCES users(id),
  invite_only   INTEGER NOT NULL DEFAULT 1,
  member_count  INTEGER NOT NULL DEFAULT 0,
  max_members   INTEGER DEFAULT 500,
  avatar_url    TEXT,
  banner_url    TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_rooms_category ON elite_rooms (category) WHERE is_active = 1;
CREATE INDEX idx_rooms_creator ON elite_rooms (created_by);

CREATE TABLE elite_room_members (
  id          TEXT PRIMARY KEY,
  room_id     TEXT NOT NULL REFERENCES elite_rooms(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member'
                CHECK (role IN ('owner', 'moderator', 'member')),
  invited_by  TEXT REFERENCES users(id),
  joined_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (room_id, user_id)
);

CREATE INDEX idx_room_members_room ON elite_room_members (room_id);
CREATE INDEX idx_room_members_user ON elite_room_members (user_id);

CREATE TABLE room_posts (
  id                TEXT PRIMARY KEY,
  room_id           TEXT NOT NULL REFERENCES elite_rooms(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content           TEXT NOT NULL,
  media_urls        TEXT,
  tips_received_cents INTEGER NOT NULL DEFAULT 0,
  reaction_count    INTEGER NOT NULL DEFAULT 0,
  moderation_status TEXT NOT NULL DEFAULT 'active'
                      CHECK (moderation_status IN ('active', 'under_review', 'removed')),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at        TEXT
);

CREATE INDEX idx_room_posts_room ON room_posts (room_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE challenger_duels (
  id                TEXT PRIMARY KEY,
  challenger_id     TEXT NOT NULL REFERENCES users(id),
  challenged_id     TEXT NOT NULL REFERENCES users(id),
  title             TEXT NOT NULL,
  description       TEXT,
  duel_type         TEXT NOT NULL
                      CHECK (duel_type IN ('revenue', 'deals', 'growth', 'savings', 'custom')),
  wager_amount_cents INTEGER NOT NULL DEFAULT 0,
  winner_tip_stripe_intent TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'accepted', 'declined', 'active', 'completed', 'cancelled')),
  winner_id         TEXT REFERENCES users(id),
  ends_at           TEXT,
  challenger_proof_url TEXT,
  challenged_proof_url TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_duels_challenger ON challenger_duels (challenger_id);
CREATE INDEX idx_duels_challenged ON challenger_duels (challenged_id);
CREATE INDEX idx_duels_active ON challenger_duels (status, ends_at) WHERE status = 'active';
