CREATE TABLE IF NOT EXISTS crew_governance_history (
  id TEXT PRIMARY KEY,
  crew_id TEXT NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  target_user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN ('role_appointed', 'role_removed', 'role_changed')),
  previous_role TEXT NOT NULL,
  new_role TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_crew_governance_history_crew_created
ON crew_governance_history(crew_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crew_one_captain
ON crew_members(crew_id) WHERE role = 'captain';

CREATE UNIQUE INDEX IF NOT EXISTS idx_crew_one_vice_captain
ON crew_members(crew_id) WHERE role = 'vice_captain';

CREATE UNIQUE INDEX IF NOT EXISTS idx_crew_one_treasurer
ON crew_members(crew_id) WHERE role = 'treasurer';
