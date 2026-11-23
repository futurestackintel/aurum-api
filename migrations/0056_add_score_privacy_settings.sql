-- Stage 2 test/schema reconciliation:
-- Add the existing score and league visibility preferences.

ALTER TABLE users
ADD COLUMN hide_aurum_score INTEGER NOT NULL DEFAULT 0
CHECK (hide_aurum_score IN (0, 1));

ALTER TABLE users
ADD COLUMN hide_league INTEGER NOT NULL DEFAULT 0
CHECK (hide_league IN (0, 1));
