-- Stage 2 schema reconciliation:
-- Score privacy columns already exist in production.
-- Enforce valid boolean values without attempting to add them again.

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
