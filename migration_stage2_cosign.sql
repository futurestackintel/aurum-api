ALTER TABLE crew_wallet_transactions ADD COLUMN required_cosigns INTEGER NOT NULL DEFAULT 1;

CREATE TABLE crew_wallet_cosigns (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES crew_wallet_transactions(id),
  moderator_id TEXT NOT NULL REFERENCES users(id),
  signed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE(transaction_id, moderator_id)
);