CREATE TABLE crew_wallets (
  id TEXT PRIMARY KEY,
  crew_id TEXT NOT NULL UNIQUE REFERENCES crews(id),
  balance_usd REAL NOT NULL DEFAULT 0,
  total_funded_usd REAL NOT NULL DEFAULT 0,
  total_spent_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE crew_wallet_transactions (
  id TEXT PRIMARY KEY,
  crew_id TEXT NOT NULL REFERENCES crews(id),
  crew_wallet_id TEXT NOT NULL REFERENCES crew_wallets(id),
  type TEXT NOT NULL CHECK (type IN ('battle_payout','member_contribution','spend','disband_split')),
  amount_usd REAL NOT NULL,
  balance_after_usd REAL,
  initiated_by TEXT REFERENCES users(id),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'executed' CHECK (status IN ('pending_cosign','executed','vetoed')),
  cosigned_by TEXT REFERENCES users(id),
  cosigned_at TEXT,
  reference TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

ALTER TABLE crews ADD COLUMN open_funding INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crews ADD COLUMN is_locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crews ADD COLUMN rules TEXT;

CREATE TABLE crew_mutes (
  id TEXT PRIMARY KEY,
  crew_id TEXT NOT NULL REFERENCES crews(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  muted_until TEXT NOT NULL,
  muted_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);