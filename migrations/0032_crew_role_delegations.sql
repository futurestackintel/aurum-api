
CREATE TABLE IF NOT EXISTS crew_role_delegations (
  id TEXT PRIMARY KEY,
  crew_id TEXT NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
  vice_captain_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK (
    permission IN (
      'manage_invites',
      'manage_join_requests',
      'remove_members',
      'manage_crew_lock',
      'edit_crew_rules',
      'moderate_discussions'
    )
  ),
  granted_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (crew_id, vice_captain_user_id, permission)
);

CREATE INDEX IF NOT EXISTS idx_crew_role_delegations_lookup
ON crew_role_delegations(crew_id, vice_captain_user_id, permission);
