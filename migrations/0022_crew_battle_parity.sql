ALTER TABLE crew_battles ADD COLUMN target_accepted_at TEXT;
ALTER TABLE crew_battles ADD COLUMN target_contribution_usd REAL;
ALTER TABLE crew_battles ADD COLUMN payout_released INTEGER NOT NULL DEFAULT 0;
