-- ============================================================
-- AURUM Migration 0050
-- Challenge Financial Foundation
--
-- Adds currency-aware financial tracking and immutable
-- operation records for Challenge financial activity.
--
-- Existing challenges remain classified as legacy.
-- No wallet balances are changed by this migration.
-- ============================================================

ALTER TABLE challenges ADD COLUMN currency_code TEXT
  NOT NULL DEFAULT 'USD'
  CHECK (length(currency_code) = 3);

UPDATE challenges
SET currency_code = 'USD'
WHERE currency_code IS NULL;

CREATE TRIGGER validate_challenge_currency_insert
BEFORE INSERT ON challenges
WHEN NOT EXISTS (
  SELECT 1 FROM financial_currencies
  WHERE currency_code = NEW.currency_code
)
BEGIN
  SELECT RAISE(ABORT, 'Challenge requires a registered currency');
END;

CREATE TRIGGER validate_challenge_currency_update
BEFORE UPDATE OF currency_code ON challenges
WHEN NOT EXISTS (
  SELECT 1 FROM financial_currencies
  WHERE currency_code = NEW.currency_code
)
BEGIN
  SELECT RAISE(ABORT, 'Challenge requires a registered currency');
END;

ALTER TABLE challenges ADD COLUMN entry_fee_minor INTEGER
  NOT NULL DEFAULT 0
  CHECK (entry_fee_minor >= 0);

ALTER TABLE challenges ADD COLUMN pool_funded_minor INTEGER
  NOT NULL DEFAULT 0
  CHECK (pool_funded_minor >= 0);

ALTER TABLE challenges ADD COLUMN financial_status TEXT
  NOT NULL DEFAULT 'legacy'
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

-- Preserve historical USD entry fees as minor units.
UPDATE challenges
SET entry_fee_minor = COALESCE(entry_fee_cents, 0)
WHERE entry_fee_minor = 0;

-- Preserve historical USD pool amounts as minor units.
UPDATE challenges
SET pool_funded_minor = COALESCE(pool_total_cents, 0)
WHERE pool_funded_minor = 0;

CREATE INDEX idx_challenges_financial_status
ON challenges(financial_status, status);


CREATE TABLE challenge_financial_operations (
  id TEXT PRIMARY KEY,

  challenge_id TEXT NOT NULL
    REFERENCES challenges(id)
    ON DELETE RESTRICT,

  entry_id TEXT
    REFERENCES challenge_entries(id)
    ON DELETE RESTRICT,

  operation_type TEXT NOT NULL
    CHECK (
      operation_type IN (
        'entry_funding',
        'winner_settlement',
        'entry_refund'
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

  UNIQUE(
    challenge_id,
    operation_type,
    actor_id,
    idempotency_key
  )
);


CREATE INDEX idx_challenge_financial_operations_challenge
ON challenge_financial_operations(challenge_id, created_at);

CREATE INDEX idx_challenge_financial_operations_status
ON challenge_financial_operations(status, created_at);

CREATE INDEX idx_challenge_financial_operations_ledger
ON challenge_financial_operations(ledger_transaction_id);


-- Posted operations must reference an actually posted ledger transaction.
CREATE TRIGGER validate_challenge_financial_operation_posted
BEFORE UPDATE OF status ON challenge_financial_operations
WHEN NEW.status = 'posted'
BEGIN

  SELECT CASE
    WHEN NEW.ledger_transaction_id IS NULL
    THEN RAISE(
      ABORT,
      'Posted Challenge operation requires a ledger transaction'
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
      'Challenge operation must reference a posted ledger transaction'
    )
  END;

END;


-- Posted financial operation records are immutable.
CREATE TRIGGER prevent_challenge_financial_operation_posted_update
BEFORE UPDATE ON challenge_financial_operations
WHEN OLD.status = 'posted'
BEGIN
  SELECT RAISE(
    ABORT,
    'Posted Challenge financial operations are immutable'
  );
END;


-- Financial operation records cannot be deleted.
CREATE TRIGGER prevent_challenge_financial_operation_delete
BEFORE DELETE ON challenge_financial_operations
BEGIN
  SELECT RAISE(
    ABORT,
    'Challenge financial operation records cannot be deleted'
  );
END;


-- ============================================================
-- END MIGRATION 0050
-- ============================================================
