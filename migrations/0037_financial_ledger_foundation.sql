
-- ============================================================
-- AURUM Migration 0037
-- Financial Ledger Foundation
--
-- Establishes the immutable double-entry financial ledger.
-- Does NOT migrate existing wallet balances or transactions.
-- Does NOT activate or change any payment flow.
--
-- Monetary amounts are stored as integer minor units.
-- Every posted journal transaction must balance per currency.
-- ============================================================


-- ============================================================
-- 1. SUPPORTED CURRENCY DEFINITIONS
-- ============================================================

CREATE TABLE financial_currencies (
  currency_code TEXT PRIMARY KEY
    CHECK (
      length(currency_code) = 3
      AND currency_code GLOB '[A-Z][A-Z][A-Z]'
    ),

  minor_unit_exponent INTEGER NOT NULL
    CHECK (minor_unit_exponent BETWEEN 0 AND 3),

  is_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (is_enabled IN (0, 1)),

  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);


-- A currency's minor-unit exponent must never change after creation.
CREATE TRIGGER prevent_financial_currency_exponent_change
BEFORE UPDATE OF minor_unit_exponent ON financial_currencies
WHEN OLD.minor_unit_exponent != NEW.minor_unit_exponent
BEGIN
  SELECT RAISE(
    ABORT,
    'Financial currency exponent is immutable'
  );
END;


-- ============================================================
-- 2. LEDGER ACCOUNTS
-- ============================================================

CREATE TABLE ledger_accounts (
  id TEXT PRIMARY KEY,

  account_code TEXT NOT NULL UNIQUE,
  account_name TEXT NOT NULL,

  account_class TEXT NOT NULL
    CHECK (
      account_class IN (
        'asset',
        'liability',
        'equity',
        'revenue',
        'expense'
      )
    ),

  normal_balance TEXT NOT NULL
    CHECK (normal_balance IN ('debit', 'credit')),

  owner_type TEXT NOT NULL
    CHECK (
      owner_type IN (
        'user',
        'crew',
        'platform',
        'provider',
        'escrow',
        'fx',
        'custody_partner'
      )
    ),

  owner_id TEXT,

  currency_code TEXT NOT NULL
    REFERENCES financial_currencies(currency_code)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,

  status TEXT NOT NULL DEFAULT 'active'
    CHECK (
      status IN (
        'active',
        'frozen',
        'closed'
      )
    ),

  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  updated_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);


CREATE INDEX idx_ledger_accounts_owner
ON ledger_accounts(owner_type, owner_id);

CREATE INDEX idx_ledger_accounts_currency
ON ledger_accounts(currency_code, status);

CREATE INDEX idx_ledger_accounts_class
ON ledger_accounts(account_class, currency_code);


-- An account's accounting identity cannot change after it has
-- participated in a ledger entry.
CREATE TRIGGER prevent_used_ledger_account_identity_change
BEFORE UPDATE OF
  account_code,
  account_class,
  normal_balance,
  owner_type,
  owner_id,
  currency_code
ON ledger_accounts
WHEN EXISTS (
  SELECT 1
  FROM ledger_entries
  WHERE account_id = OLD.id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'Used ledger account identity is immutable'
  );
END;


-- ============================================================
-- 3. JOURNAL TRANSACTIONS
-- ============================================================

CREATE TABLE ledger_transactions (
  id TEXT PRIMARY KEY,

  idempotency_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,

  source_module TEXT NOT NULL,
  transaction_type TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (
      status IN (
        'draft',
        'posted'
      )
    ),

  description TEXT,

  reference TEXT,

  actor_type TEXT NOT NULL
    CHECK (
      actor_type IN (
        'member',
        'platform_admin',
        'system'
      )
    ),

  actor_id TEXT,

  request_id TEXT,

  reversal_of_transaction_id TEXT
    REFERENCES ledger_transactions(id)
    ON DELETE RESTRICT,

  metadata_json TEXT
    CHECK (
      metadata_json IS NULL
      OR json_valid(metadata_json)
    ),

  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  posted_at TEXT,

  CHECK (
    reversal_of_transaction_id IS NULL
    OR reversal_of_transaction_id != id
  ),

  UNIQUE(idempotency_scope, idempotency_key)
);


CREATE UNIQUE INDEX idx_ledger_one_reversal_per_transaction
ON ledger_transactions(reversal_of_transaction_id)
WHERE reversal_of_transaction_id IS NOT NULL;

CREATE INDEX idx_ledger_transactions_status
ON ledger_transactions(status, created_at);

CREATE INDEX idx_ledger_transactions_source
ON ledger_transactions(source_module, transaction_type, created_at);

CREATE INDEX idx_ledger_transactions_reference
ON ledger_transactions(reference)
WHERE reference IS NOT NULL;

CREATE INDEX idx_ledger_transactions_request
ON ledger_transactions(request_id)
WHERE request_id IS NOT NULL;


-- A reversal must reference an already-posted transaction.
CREATE TRIGGER validate_ledger_reversal_target
BEFORE INSERT ON ledger_transactions
WHEN NEW.reversal_of_transaction_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM ledger_transactions
      WHERE id = NEW.reversal_of_transaction_id
        AND status = 'posted'
    )
    THEN RAISE(
      ABORT,
      'A reversal must reference a posted transaction'
    )
  END;
END;


-- ============================================================
-- 4. JOURNAL ENTRIES
-- ============================================================

CREATE TABLE ledger_entries (
  id TEXT PRIMARY KEY,

  transaction_id TEXT NOT NULL
    REFERENCES ledger_transactions(id)
    ON DELETE RESTRICT,

  account_id TEXT NOT NULL
    REFERENCES ledger_accounts(id)
    ON DELETE RESTRICT,

  currency_code TEXT NOT NULL
    REFERENCES financial_currencies(currency_code)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,

  entry_side TEXT NOT NULL
    CHECK (
      entry_side IN (
        'debit',
        'credit'
      )
    ),

  amount_minor INTEGER NOT NULL
    CHECK (amount_minor > 0),

  description TEXT,

  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);


CREATE INDEX idx_ledger_entries_transaction
ON ledger_entries(transaction_id);

CREATE INDEX idx_ledger_entries_account
ON ledger_entries(account_id, created_at);

CREATE INDEX idx_ledger_entries_currency
ON ledger_entries(currency_code, transaction_id);


-- Every entry must use the same currency as its ledger account.
CREATE TRIGGER validate_ledger_entry_account_currency
BEFORE INSERT ON ledger_entries
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM ledger_accounts
      WHERE id = NEW.account_id
        AND currency_code = NEW.currency_code
    )
    THEN RAISE(
      ABORT,
      'Ledger entry currency must match its account currency'
    )
  END;
END;


-- New entries can only be added while their transaction is a draft.
CREATE TRIGGER prevent_entry_on_posted_transaction
BEFORE INSERT ON ledger_entries
WHEN EXISTS (
  SELECT 1
  FROM ledger_transactions
  WHERE id = NEW.transaction_id
    AND status = 'posted'
)
BEGIN
  SELECT RAISE(
    ABORT,
    'Cannot add entries to a posted transaction'
  );
END;


-- Posted entries cannot be modified.
CREATE TRIGGER prevent_posted_ledger_entry_update
BEFORE UPDATE ON ledger_entries
WHEN EXISTS (
  SELECT 1
  FROM ledger_transactions
  WHERE id = OLD.transaction_id
    AND status = 'posted'
)
BEGIN
  SELECT RAISE(
    ABORT,
    'Posted ledger entries are immutable'
  );
END;


-- Posted entries cannot be deleted.
CREATE TRIGGER prevent_posted_ledger_entry_delete
BEFORE DELETE ON ledger_entries
WHEN EXISTS (
  SELECT 1
  FROM ledger_transactions
  WHERE id = OLD.transaction_id
    AND status = 'posted'
)
BEGIN
  SELECT RAISE(
    ABORT,
    'Posted ledger entries cannot be deleted'
  );
END;


-- ============================================================
-- 5. POSTING VALIDATION
-- ============================================================

-- A transaction cannot become posted unless:
--   1. It contains at least two entries.
--   2. Debits equal credits for every currency independently.
--
-- Cross-currency transactions must therefore contain balanced
-- entries for each currency, not a synthetic combined total.

CREATE TRIGGER validate_ledger_transaction_before_posting
BEFORE UPDATE OF status ON ledger_transactions
WHEN OLD.status = 'draft'
  AND NEW.status = 'posted'
BEGIN

  SELECT CASE
    WHEN (
      SELECT COUNT(*)
      FROM ledger_entries
      WHERE transaction_id = NEW.id
    ) < 2
    THEN RAISE(
      ABORT,
      'A posted ledger transaction requires at least two entries'
    )
  END;

  SELECT CASE
    WHEN EXISTS (
      SELECT currency_code
      FROM ledger_entries
      WHERE transaction_id = NEW.id
      GROUP BY currency_code
      HAVING
        SUM(
          CASE
            WHEN entry_side = 'debit'
            THEN amount_minor
            ELSE 0
          END
        )
        !=
        SUM(
          CASE
            WHEN entry_side = 'credit'
            THEN amount_minor
            ELSE 0
          END
        )
    )
    THEN RAISE(
      ABORT,
      'Ledger transaction debits and credits must balance per currency'
    )
  END;

  SELECT CASE
    WHEN NEW.posted_at IS NULL
    THEN RAISE(
      ABORT,
      'Posted ledger transaction requires posted_at'
    )
  END;

END;


-- ============================================================
-- 6. JOURNAL TRANSACTION IMMUTABILITY
-- ============================================================

CREATE TRIGGER prevent_posted_ledger_transaction_update
BEFORE UPDATE ON ledger_transactions
WHEN OLD.status = 'posted'
BEGIN
  SELECT RAISE(
    ABORT,
    'Posted ledger transactions are immutable'
  );
END;


CREATE TRIGGER prevent_posted_ledger_transaction_delete
BEFORE DELETE ON ledger_transactions
WHEN OLD.status = 'posted'
BEGIN
  SELECT RAISE(
    ABORT,
    'Posted ledger transactions cannot be deleted'
  );
END;


-- ============================================================
-- END OF MIGRATION 0037
-- ============================================================
