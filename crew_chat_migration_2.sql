CREATE TABLE crew_message_mentions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES crew_messages(id),
  mentioned_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_crew_message_mentions_user ON crew_message_mentions(mentioned_user_id, created_at);