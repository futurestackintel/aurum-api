CREATE TABLE crew_messages (
  id TEXT PRIMARY KEY,
  crew_id TEXT NOT NULL REFERENCES crews(id),
  sender_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  deleted_by TEXT REFERENCES users(id)
);

CREATE INDEX idx_crew_messages_crew_created ON crew_messages(crew_id, created_at);