
-- ============================================================
-- AURUM Migration 0046
-- Duel Financial Operations
--
-- Durable operation records for Duel financial activity.
-- ============================================================

CREATE TABLE duel_financial_operations (
  id TEXT PRIMARY KEY,

  duel_id TEXT NOT NULL
    REFERENCES duels(id)
    ON DELETE RESTRICT,

  operation_type TEXT NOT NULL
    CHECK (
      operation_type IN (
        'challenger_stake',
        'target_stake',
        'audience_tip'
      )
    ),

  actor_id TEXT NOT NULL,

  currency_code TEXT NOT NULL
    REFERENCES financial_currencies(currency_code),

  amount_minor INTEGER NOT NULL
    CHECK (amount_minor > 0),

  idempotency_key TEXT NOT NULL,

  ledger_transaction_id TEXT
    REFERENCES ledger_transactions(id)
    ON DELETE RESTRICT,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      status IN (
        'pending',
        'posted',
        'failed',
        'reconciliation_required'
      )
    ),

  metadata_json TEXT
    CHECK (
      metadata_json IS NULL
      OR json_valid(metadata_json)
    ),

  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  updated_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  UNIQUE(duel_id, operation_type, actor_id, idempotency_key)
);


CREATE INDEX idx_duel_financial_operations_duel
ON duel_financial_operations(duel_id, created_at);


CREATE INDEX idx_duel_financial_operations_status
ON duel_financial_operations(status, created_at);


CREATE INDEX idx_duel_financial_operations_ledger
ON duel_financial_operations(ledger_transaction_id);


-- A posted operation must reference a posted ledger transaction.
CREATE TRIGGER validate_duel_financial_operation_posted
BEFORE UPDATE OF status ON duel_financial_operations
WHEN NEW.status = 'posted'
BEGIN

  SELECT CASE
    WHEN NEW.ledger_transaction_id IS NULL
    THEN RAISE(
      ABORT,
      'Posted Duel operation requires a ledger transaction'
    )
  END;

  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM ledger_transactions
      WHERE id = NEW.ledger_transaction_id
        AND status = 'posted'
    )
    THEN RAISE(
      ABORT,
      'Duel operation must reference a posted ledger transaction'
    )
  END;

END;


-- Posted operation records cannot be modified.
CREATE TRIGGER prevent_duel_financial_operation_posted_update
BEFORE UPDATE ON duel_financial_operations
WHEN OLD.status = 'posted'
BEGIN
  SELECT RAISE(
    ABORT,
    'Posted Duel financial operations are immutable'
  );
END;


CREATE TRIGGER prevent_duel_financial_operation_delete
BEFORE DELETE ON duel_financial_operations
BEGIN
  SELECT RAISE(
    ABORT,
    'Duel financial operation records cannot be deleted'
  );
END;


-- ============================================================
-- END MIGRATION 0046
-- ============================================================
