-- Restores the base crew chat and direct-message schemas.
-- Later migrations add reply, reaction and pin-related features.
-- IF NOT EXISTS protects databases where these tables already exist.

CREATE TABLE IF NOT EXISTS crew_messages (
  id TEXT PRIMARY KEY,
  crew_id TEXT NOT NULL REFERENCES crews(id),
  sender_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  deleted_by TEXT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_crew_messages_crew_created
  ON crew_messages(crew_id, created_at);

CREATE TABLE IF NOT EXISTS crew_message_mentions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES crew_messages(id),
  mentioned_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_crew_message_mentions_user
  ON crew_message_mentions(mentioned_user_id, created_at);

CREATE TABLE IF NOT EXISTS dm_channels (
  id TEXT PRIMARY KEY,
  user_a_id TEXT NOT NULL REFERENCES users(id),
  user_b_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_a_id, user_b_id)
);

CREATE TABLE IF NOT EXISTS dm_messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES dm_channels(id),
  sender_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
