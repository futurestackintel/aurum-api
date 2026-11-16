
-- Allow users to belong to multiple crews.
-- A user may have only one membership in any individual crew.

DROP INDEX IF EXISTS idx_crew_members_user_id;
DROP INDEX IF EXISTS idx_crew_members_user_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_crew_members_crew_user_unique
ON crew_members(crew_id, user_id);

CREATE INDEX IF NOT EXISTS idx_crew_members_user_lookup
ON crew_members(user_id);
