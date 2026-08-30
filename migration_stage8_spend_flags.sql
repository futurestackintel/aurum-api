CREATE TABLE crew_spend_flags (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES crew_wallet_transactions(id),
  flagged_by TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','dismissed','actioned')),
  admin_notes TEXT,
  resolved_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  resolved_at TEXT,
  UNIQUE(transaction_id, flagged_by)
);