ALTER TABLE crews ADD COLUMN invite_code TEXT;

CREATE UNIQUE INDEX idx_crews_invite_code ON crews(invite_code);
