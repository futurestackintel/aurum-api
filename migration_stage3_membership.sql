CREATE TABLE crew_join_requests (
  id TEXT PRIMARY KEY,
  crew_id TEXT NOT NULL REFERENCES crews(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('invite','request')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  responded_at TEXT
);