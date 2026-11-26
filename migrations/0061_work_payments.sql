-- ============================================================
-- AURUM STAGE 4: INDIVIDUAL WORK PAYMENTS
-- Direct available-wallet transfers after approval/completion.
-- No escrow, custody or platform fee.
-- ============================================================

CREATE TABLE work_payments (
  id TEXT PRIMARY KEY,

  engagement_id TEXT NOT NULL
    REFERENCES work_engagements(id) ON DELETE RESTRICT,

  client_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,

  provider_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,

  payment_type TEXT NOT NULL
    CHECK (payment_type IN ('fixed', 'hourly')),

  payment_key TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,

  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),

  currency TEXT NOT NULL
    REFERENCES financial_currencies(currency_code)
    ON DELETE RESTRICT,

  approved_minutes INTEGER
    CHECK (approved_minutes IS NULL OR approved_minutes > 0),

  ledger_transaction_id TEXT NOT NULL UNIQUE
    REFERENCES ledger_transactions(id) ON DELETE RESTRICT,

  created_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
);

CREATE INDEX idx_work_payments_engagement
ON work_payments(engagement_id, created_at);

CREATE TRIGGER validate_work_payment_ledger
BEFORE INSERT ON work_payments
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM ledger_transactions
      WHERE id = NEW.ledger_transaction_id
        AND source_module = 'work'
        AND transaction_type = 'work_payment'
        AND status = 'draft'
    )
    THEN RAISE(ABORT, 'Work payment requires its draft ledger transaction')
  END;
END;

CREATE TRIGGER prevent_work_payment_update
BEFORE UPDATE ON work_payments
BEGIN
  SELECT RAISE(ABORT, 'Work payment records are immutable');
END;

CREATE TRIGGER prevent_work_payment_delete
BEFORE DELETE ON work_payments
BEGIN
  SELECT RAISE(ABORT, 'Work payment records cannot be deleted');
END;

-- Prevent Work payments from making a user's available wallet
-- balance negative. This check runs inside ledger posting.
CREATE TRIGGER prevent_work_payment_overdraft
BEFORE UPDATE OF status ON ledger_transactions
WHEN OLD.status = 'draft'
  AND NEW.status = 'posted'
  AND NEW.source_module = 'work'
  AND NEW.transaction_type = 'work_payment'
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM (
        SELECT
          le.account_id,
          SUM(le.amount_minor) AS debit_minor
        FROM ledger_entries le
        JOIN ledger_accounts la
          ON la.id = le.account_id
        WHERE le.transaction_id = NEW.id
          AND le.entry_side = 'debit'
          AND la.owner_type = 'user'
          AND la.account_class = 'liability'
          AND la.normal_balance = 'credit'
          AND la.account_code LIKE 'USER:AVAILABLE:%'
        GROUP BY le.account_id
      ) requested
      WHERE (
        SELECT COALESCE(
          SUM(
            CASE
              WHEN prior.entry_side = 'credit'
                THEN prior.amount_minor
              ELSE -prior.amount_minor
            END
          ),
          0
        )
        FROM ledger_entries prior
        JOIN ledger_transactions tx
          ON tx.id = prior.transaction_id
        WHERE prior.account_id = requested.account_id
          AND tx.status = 'posted'
      ) < requested.debit_minor
    )
    THEN RAISE(
      ABORT,
      'Insufficient available wallet balance for Work payment'
    )
  END;
END;
