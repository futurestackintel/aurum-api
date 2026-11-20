
-- ============================================================
-- 0044: FINANCIAL ESCROW TERMINAL OPERATION GUARD
-- ============================================================
-- Each escrow may have exactly one terminal outcome:
-- settlement OR refund.
--
-- The guard row is inserted in the same atomic D1 batch
-- as the corresponding posted ledger transaction.
-- ============================================================

CREATE TABLE financial_escrow_terminal_operations (
  id TEXT PRIMARY KEY,

  escrow_type TEXT NOT NULL
    CHECK (
      escrow_type IN (
        'DUEL',
        'CHALLENGE',
        'CREW_BATTLE'
      )
    ),

  escrow_id TEXT NOT NULL,

  currency_code TEXT NOT NULL
    REFERENCES financial_currencies(currency_code)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,

  outcome TEXT NOT NULL
    CHECK (
      outcome IN (
        'settlement',
        'refund'
      )
    ),

  ledger_transaction_id TEXT NOT NULL UNIQUE
    REFERENCES ledger_transactions(id)
    ON DELETE RESTRICT,

  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  -- One terminal outcome across the entire escrow,
  -- regardless of currency or idempotency key.
  UNIQUE(escrow_type, escrow_id)
);


CREATE INDEX idx_financial_escrow_terminal_created
ON financial_escrow_terminal_operations(created_at);


CREATE TRIGGER validate_financial_escrow_terminal_insert
BEFORE INSERT ON financial_escrow_terminal_operations
BEGIN

  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM ledger_transactions
      WHERE id = NEW.ledger_transaction_id
        AND status = 'draft'
        AND source_module = 'financial_service'
        AND transaction_type = CASE
          WHEN NEW.outcome = 'settlement'
            THEN 'escrow_settlement'
          ELSE 'escrow_refund'
        END
        AND json_extract(metadata_json, '$.escrow_type')
          = NEW.escrow_type
        AND json_extract(metadata_json, '$.escrow_id')
          = NEW.escrow_id
        AND json_extract(metadata_json, '$.currency_code')
          = NEW.currency_code
    )
    THEN RAISE(
      ABORT,
      'Escrow terminal operation does not match its ledger transaction'
    )
  END;

END;


CREATE TRIGGER prevent_financial_escrow_terminal_update
BEFORE UPDATE ON financial_escrow_terminal_operations
BEGIN
  SELECT RAISE(
    ABORT,
    'Escrow terminal operation records are immutable'
  );
END;


CREATE TRIGGER prevent_financial_escrow_terminal_delete
BEFORE DELETE ON financial_escrow_terminal_operations
BEGIN
  SELECT RAISE(
    ABORT,
    'Escrow terminal operation records cannot be deleted'
  );
END;


-- ============================================================
-- END MIGRATION 0044
-- ============================================================
