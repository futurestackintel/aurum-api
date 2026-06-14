CREATE TABLE post_reactions (
  id          TEXT PRIMARY KEY,
  post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction    TEXT NOT NULL CHECK (reaction IN ('fire', 'crown', 'rocket', 'diamond', 'respect')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (post_id, user_id)
);

CREATE INDEX idx_reactions_post ON post_reactions (post_id);
CREATE INDEX idx_reactions_user ON post_reactions (user_id);

CREATE TABLE post_comments (
  id                TEXT PRIMARY KEY,
  post_id           TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_comment_id TEXT REFERENCES post_comments(id) ON DELETE CASCADE,
  content           TEXT NOT NULL,
  moderation_status TEXT NOT NULL DEFAULT 'active'
                      CHECK (moderation_status IN ('active', 'under_review', 'removed')),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at        TEXT
);

CREATE INDEX idx_comments_post ON post_comments (post_id, created_at ASC) WHERE deleted_at IS NULL;
CREATE INDEX idx_comments_user ON post_comments (user_id) WHERE deleted_at IS NULL;

CREATE TABLE notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL
                CHECK (type IN (
                  'tip_received', 'challenge_won', 'challenge_joined', 'challenge_ending_soon',
                  'duel_received', 'duel_accepted', 'duel_result',
                  'post_reacted', 'post_tipped', 'post_commented',
                  'badge_awarded', 'league_promoted', 'league_demoted',
                  'stake_verified', 'stake_disputed', 'stake_forfeited',
                  'room_invited', 'subscription_renewal', 'system_alert'
                )),
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  action_url  TEXT,
  metadata    TEXT,
  is_read     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  read_at     TEXT
);

CREATE INDEX idx_notifications_user_unread ON notifications (user_id, created_at DESC) WHERE is_read = 0;
CREATE INDEX idx_notifications_user_all ON notifications (user_id, created_at DESC);

CREATE TABLE moderation_flags (
  id            TEXT PRIMARY KEY,
  reporter_id   TEXT NOT NULL REFERENCES users(id),
  target_type   TEXT NOT NULL CHECK (target_type IN ('post', 'comment', 'user', 'challenge', 'room_post')),
  target_id     TEXT NOT NULL,
  reason        TEXT NOT NULL
                  CHECK (reason IN (
                    'fake_achievement', 'harassment', 'spam', 'inappropriate_content',
                    'fraud', 'impersonation', 'other'
                  )),
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'reviewed', 'actioned', 'dismissed')),
  reviewed_by   TEXT REFERENCES users(id),
  reviewed_at   TEXT,
  action_taken  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_flags_status ON moderation_flags (status, created_at) WHERE status = 'pending';
CREATE INDEX idx_flags_target ON moderation_flags (target_type, target_id);
CREATE INDEX idx_flags_reporter ON moderation_flags (reporter_id); 
