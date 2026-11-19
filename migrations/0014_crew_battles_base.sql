-- Restore the foundational crew battles table.
-- Later migrations add battle parity and payer fields.

CREATE TABLE IF NOT EXISTS crew_battles (
  id TEXT PRIMARY KEY,
  challenger_crew_id TEXT NOT NULL REFERENCES crews(id),
  target_crew_id TEXT NOT NULL REFERENCES crews(id),
  title TEXT NOT NULL,
  prize_pool_usd REAL NOT NULL DEFAULT 0,
  entry_contribution_usd REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','active','resolved','cancelled')),
  winner_crew_id TEXT REFERENCES crews(id),
  ends_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  )
);
