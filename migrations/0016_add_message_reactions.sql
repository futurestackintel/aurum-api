CREATE TABLE message_reactions (
  id TEXT PRIMARY KEY,
  message_type TEXT NOT NULL CHECK (message_type IN ('crew', 'dm')),
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  emoji TEXT NOT NULL CHECK (emoji IN ('🔥', '👑', '💰', '⚔️', '😂', '🖤')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (message_type, message_id, user_id)
);

CREATE INDEX idx_message_reactions_lookup ON message_reactions (message_type, message_id);