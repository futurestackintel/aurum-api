-- Enforce one crew per user at the database level
CREATE UNIQUE INDEX IF NOT EXISTS idx_crew_members_user_id ON crew_members(user_id);