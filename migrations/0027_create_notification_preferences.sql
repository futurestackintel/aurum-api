CREATE TABLE IF NOT EXISTS notification_preferences (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  tips_received       INTEGER NOT NULL DEFAULT 1,
  challenge_updates   INTEGER NOT NULL DEFAULT 1,
  duel_challenges     INTEGER NOT NULL DEFAULT 1,
  league_promotions   INTEGER NOT NULL DEFAULT 1,
  badge_awards        INTEGER NOT NULL DEFAULT 1,
  weekly_summary      INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
