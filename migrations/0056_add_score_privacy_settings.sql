-- Stage 2 schema reconciliation:
-- Ensure score privacy columns exist in fresh databases.
-- Production already has these columns, and migration 0056 is already applied there.

ALTER TABLE users ADD COLUMN hide_aurum_score INTEGER NOT NULL DEFAULT 0
  CHECK (hide_aurum_score IN (0, 1));

ALTER TABLE users ADD COLUMN hide_league INTEGER NOT NULL DEFAULT 0
  CHECK (hide_league IN (0, 1));

CREATE TRIGGER IF NOT EXISTS users_score_privacy_insert_guard
BEFORE INSERT ON users
WHEN
  NEW.hide_aurum_score IS NULL
  OR NEW.hide_aurum_score NOT IN (0, 1)
  OR NEW.hide_league IS NULL
  OR NEW.hide_league NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'Invalid score privacy setting');
END;

CREATE TRIGGER IF NOT EXISTS users_score_privacy_update_guard
BEFORE UPDATE OF hide_aurum_score, hide_league ON users
WHEN
  NEW.hide_aurum_score IS NULL
  OR NEW.hide_aurum_score NOT IN (0, 1)
  OR NEW.hide_league IS NULL
  OR NEW.hide_league NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'Invalid score privacy setting');
END;
