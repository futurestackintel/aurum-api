
-- ============================================================
-- 0043: FINANCIAL TIP OPERATIONS
-- ============================================================
-- New multi-currency tips are recorded separately from the
-- legacy USD-oriented tips table.
--
-- The immutable ledger remains the source of truth for money.
-- This table stores operational metadata and idempotency.
-- No historical tip records are modified.
-- ============================================================

CREATE TABLE financial_tip_operations (
  id TEXT PRIMARY KEY,

  sender_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,

  receiver_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,

  post_id TEXT NOT NULL
    REFERENCES posts(id) ON DELETE RESTRICT,

  currency_code TEXT NOT NULL
    REFERENCES financial_currencies(currency_code)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,

  amount_minor INTEGER NOT NULL
    CHECK (amount_minor > 0),

  idempotency_key TEXT NOT NULL,

  request_fingerprint TEXT NOT NULL
    CHECK (length(request_fingerprint) = 64),

  ledger_transaction_id TEXT
    REFERENCES ledger_transactions(id)
    ON DELETE RESTRICT,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      status IN (
        'pending',
        'completed',
        'reconciliation_required'
      )
    ),

  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  completed_at TEXT,

  CHECK (sender_id != receiver_id),

  UNIQUE(sender_id, idempotency_key),

  UNIQUE(ledger_transaction_id)
);

CREATE INDEX idx_financial_tips_sender
ON financial_tip_operations(sender_id, created_at DESC);

CREATE INDEX idx_financial_tips_receiver
ON financial_tip_operations(receiver_id, created_at DESC);

CREATE INDEX idx_financial_tips_post
ON financial_tip_operations(post_id, created_at DESC);

CREATE INDEX idx_financial_tips_currency
ON financial_tip_operations(currency_code, created_at DESC);

CREATE INDEX idx_financial_tips_status
ON financial_tip_operations(status, created_at);


-- Original request evidence cannot be changed.
CREATE TRIGGER prevent_financial_tip_evidence_update
BEFORE UPDATE OF
  sender_id,
  receiver_id,
  post_id,
  currency_code,
  amount_minor,
  idempotency_key,
  request_fingerprint,
  created_at
ON financial_tip_operations
BEGIN
  SELECT RAISE(
    ABORT,
    'Financial tip request evidence is immutable'
  );
END;


-- Financial tip operation records cannot be deleted.
CREATE TRIGGER prevent_financial_tip_delete
BEFORE DELETE ON financial_tip_operations
BEGIN
  SELECT RAISE(
    ABORT,
    'Financial tip operations cannot be deleted'
  );
END;


-- A completed operation must reference a posted ledger transaction.
CREATE TRIGGER validate_financial_tip_completion
BEFORE UPDATE OF status ON financial_tip_operations
WHEN NEW.status = 'completed'
BEGIN
  SELECT CASE
    WHEN NEW.ledger_transaction_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM ledger_transactions
        WHERE id = NEW.ledger_transaction_id
          AND status = 'posted'
      )
    THEN RAISE(
      ABORT,
      'A completed tip requires a posted ledger transaction'
    )
  END;

  SELECT CASE
    WHEN NEW.completed_at IS NULL
    THEN RAISE(
      ABORT,
      'A completed tip requires completed_at'
    )
  END;
END;
