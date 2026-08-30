-- Enforce one crew per user at the database level
CREATE UNIQUE INDEX idx_crew_members_user_unique ON crew_members(user_id);