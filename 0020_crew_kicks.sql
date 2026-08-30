CREATE TABLE crew_kicks (
  id TEXT PRIMARY KEY,
  crew_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kicked_at TEXT NOT NULL,
  FOREIGN KEY (crew_id) REFERENCES crews(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_crew_kicks_crew_user ON crew_kicks(crew_id, user_id);