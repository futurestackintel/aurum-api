-- Stage 2: Crew Battle financial foundation
-- Existing battles remain legacy records.
-- New battles use currency-specific ledger accounting.

ALTER TABLE crew_battles
ADD COLUMN currency_code TEXT NOT NULL DEFAULT 'USD';

ALTER TABLE crew_battles
ADD COLUMN challenger_contribution_minor INTEGER NOT NULL DEFAULT 0;

ALTER TABLE crew_battles
ADD COLUMN target_contribution_minor INTEGER NOT NULL DEFAULT 0;

ALTER TABLE crew_battles
ADD COLUMN prize_pool_minor INTEGER NOT NULL DEFAULT 0;

ALTER TABLE crew_battles
ADD COLUMN financial_status TEXT NOT NULL DEFAULT 'legacy'
CHECK (
  financial_status IN (
    'legacy',
    'pending',
    'funding',
    'funded',
    'settling',
    'settled',
    'refunding',
    'refunded',
    'reconciliation_required'
  )
);

-- Convert historical USD values into minor units.
UPDATE crew_battles
SET
  challenger_contribution_minor =
    CAST(ROUND(entry_contribution_usd * 100) AS INTEGER),

  target_contribution_minor =
    CAST(ROUND(COALESCE(target_contribution_usd, 0) * 100) AS INTEGER),

  prize_pool_minor =
    CAST(ROUND(COALESCE(prize_pool_usd, 0) * 100) AS INTEGER),

  financial_status = 'legacy';

-- Track each contribution and terminal financial operation.
CREATE TABLE IF NOT EXISTS crew_battle_financial_operations (
  id TEXT PRIMARY KEY,

  battle_id TEXT NOT NULL
    REFERENCES crew_battles(id),

  operation_type TEXT NOT NULL
    CHECK (
      operation_type IN (
        'challenger_funding',
        'target_funding',
        'winner_settlement',
        'challenger_refund',
        'target_refund'
      )
    ),

  actor_id TEXT,

  owner_type TEXT NOT NULL
    CHECK (owner_type IN ('user', 'crew')),

  owner_id TEXT NOT NULL,

  currency_code TEXT NOT NULL,

  amount_minor INTEGER NOT NULL
    CHECK (amount_minor > 0),

  idempotency_key TEXT NOT NULL UNIQUE,

  ledger_transaction_id TEXT,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      status IN (
        'pending',
        'posted',
        'failed',
        'reconciliation_required'
      )
    ),

  metadata_json TEXT NOT NULL DEFAULT '{}',

  created_at TEXT NOT NULL,

  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS
idx_crew_battle_financial_operations_battle
ON crew_battle_financial_operations (
  battle_id,
  operation_type,
  status
);

CREATE INDEX IF NOT EXISTS
idx_crew_battle_financial_operations_ledger
ON crew_battle_financial_operations (
  ledger_transaction_id
);
