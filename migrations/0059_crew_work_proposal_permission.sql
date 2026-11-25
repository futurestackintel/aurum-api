-- Add the approved Vice Captain permission for submitting
-- Work proposals without granting full Captain authority.

CREATE TABLE crew_role_delegations_new (
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
      'moderate_discussions',
      'submit_work_proposals'
    )
  ),
  granted_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (crew_id, vice_captain_user_id, permission)
);

INSERT INTO crew_role_delegations_new (
  id,
  crew_id,
  vice_captain_user_id,
  permission,
  granted_by_user_id,
  created_at
)
SELECT
  id,
  crew_id,
  vice_captain_user_id,
  permission,
  granted_by_user_id,
  created_at
FROM crew_role_delegations;

DROP TABLE crew_role_delegations;

ALTER TABLE crew_role_delegations_new
RENAME TO crew_role_delegations;

CREATE INDEX idx_crew_role_delegations_lookup
ON crew_role_delegations(
  crew_id,
  vice_captain_user_id,
  permission
);
