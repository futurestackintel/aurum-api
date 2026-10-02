-- expires_at was already created by 0009_wallet_and_fixes.sql.
-- Keep this migration name because deployed D1 databases record it as applied.
-- A no-op keeps clean installs from adding the same column twice.
SELECT 1;
