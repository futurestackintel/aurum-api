-- Restore the foundational crew tables required by subsequent migrations.
-- Keep this migration before 0019_crew_members_unique_user.sql.

CREATE TABLE IF NOT EXISTS crews (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  creator_id TEXT NOT NULL REFERENCES users(id),
  description TEXT,
  member_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  ),
  open_funding INTEGER NOT NULL DEFAULT 0,
  is_locked INTEGER NOT NULL DEFAULT 0,
  rules TEXT,
  is_frozen INTEGER NOT NULL DEFAULT 0,
  freeze_reason TEXT,
  frozen_by TEXT REFERENCES users(id),
  frozen_at TEXT
);

CREATE TABLE IF NOT EXISTS crew_members (
  id TEXT PRIMARY KEY,
  crew_id TEXT NOT NULL REFERENCES crews(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member',
  joined_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  ),
  UNIQUE(crew_id, user_id)
);
