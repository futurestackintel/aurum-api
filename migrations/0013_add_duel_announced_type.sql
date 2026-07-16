CREATE TABLE notifications_new (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL
                CHECK (type IN (
                  'tip_received', 'challenge_won', 'challenge_joined', 'challenge_ending_soon',
                  'duel_received', 'duel_accepted', 'duel_result', 'duel_announced',
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

INSERT INTO notifications_new
SELECT id, user_id, type, title, body, action_url, metadata, is_read, created_at, read_at
FROM notifications;

DROP TABLE notifications;

ALTER TABLE notifications_new RENAME TO notifications;
