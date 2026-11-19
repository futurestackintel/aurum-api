
-- ============================================================
-- 0039: FINANCIAL OPENING-BALANCE PREPARATION
-- ============================================================
-- Stages legacy opening-balance evidence for review.
-- Does NOT post ledger transactions or alter wallet balances.
-- ============================================================

CREATE TABLE financial_opening_balance_batches (
  id TEXT PRIMARY KEY,

  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (
      status IN (
        'draft',
        'reviewed',
        'approved',
        'cancelled'
      )
    ),

  source_scope TEXT NOT NULL,

  created_by_type TEXT NOT NULL DEFAULT 'system'
    CHECK (
      created_by_type IN (
        'member',
        'platform_admin',
        'system'
      )
    ),

  created_by_id TEXT,

  reviewed_by_type TEXT,
  reviewed_by_id TEXT,
  reviewed_at TEXT,

  approved_by_type TEXT,
  approved_by_id TEXT,
  approved_at TEXT,

  total_items INTEGER NOT NULL DEFAULT 0
    CHECK (total_items >= 0),

  verified_items INTEGER NOT NULL DEFAULT 0
    CHECK (verified_items >= 0),

  disputed_items INTEGER NOT NULL DEFAULT 0
    CHECK (disputed_items >= 0),

  excluded_items INTEGER NOT NULL DEFAULT 0
    CHECK (excluded_items >= 0),

  metadata_json TEXT
    CHECK (
      metadata_json IS NULL
      OR json_valid(metadata_json)
    ),

  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  updated_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);


CREATE INDEX idx_opening_balance_batches_status
ON financial_opening_balance_batches(status, created_at);


CREATE TABLE financial_opening_balance_items (
  id TEXT PRIMARY KEY,

  batch_id TEXT NOT NULL
    REFERENCES financial_opening_balance_batches(id)
    ON DELETE RESTRICT,

  source_table TEXT NOT NULL,
  source_record_id TEXT NOT NULL,

  source_reference TEXT,

  -- Preserve the original value exactly as observed.
  -- Do not assume that legacy REAL values are minor units.
  source_amount_text TEXT,

  source_currency_code TEXT,

  -- Populated only after the target amount and mapping
  -- have been independently verified.
  account_id TEXT
    REFERENCES ledger_accounts(id)
    ON DELETE RESTRICT,

  currency_code TEXT
    REFERENCES financial_currencies(currency_code)
    ON DELETE RESTRICT,

  opening_side TEXT
    CHECK (
      opening_side IS NULL
      OR opening_side IN ('debit', 'credit')
    ),

  amount_minor INTEGER
    CHECK (
      amount_minor IS NULL
      OR amount_minor > 0
    ),

  item_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      item_status IN (
        'pending',
        'verified',
        'disputed',
        'excluded'
      )
    ),

  verification_note TEXT,

  verified_by_type TEXT
    CHECK (
      verified_by_type IS NULL
      OR verified_by_type IN (
        'member',
        'platform_admin',
        'system'
      )
    ),

  verified_by_id TEXT,
  verified_at TEXT,

  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  updated_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  UNIQUE(batch_id, source_table, source_record_id),

  CHECK (
    item_status != 'verified'
    OR (
      account_id IS NOT NULL
      AND currency_code IS NOT NULL
      AND opening_side IS NOT NULL
      AND amount_minor IS NOT NULL
      AND verified_at IS NOT NULL
      AND verified_by_type IS NOT NULL
    )
  )
);


CREATE INDEX idx_opening_balance_items_batch
ON financial_opening_balance_items(batch_id, item_status);


CREATE INDEX idx_opening_balance_items_source
ON financial_opening_balance_items(source_table, source_record_id);


CREATE INDEX idx_opening_balance_items_account
ON financial_opening_balance_items(account_id, currency_code);


-- Items may only be added while their batch is a draft.
CREATE TRIGGER prevent_opening_balance_item_insert_after_review
BEFORE INSERT ON financial_opening_balance_items
WHEN (
  SELECT status
  FROM financial_opening_balance_batches
  WHERE id = NEW.batch_id
) != 'draft'
BEGIN
  SELECT RAISE(
    ABORT,
    'Opening-balance batch is no longer editable'
  );
END;


-- Evidence and mappings become immutable after review begins.
CREATE TRIGGER prevent_opening_balance_item_update_after_review
BEFORE UPDATE ON financial_opening_balance_items
WHEN (
  SELECT status
  FROM financial_opening_balance_batches
  WHERE id = OLD.batch_id
) != 'draft'
BEGIN
  SELECT RAISE(
    ABORT,
    'Opening-balance batch is no longer editable'
  );
END;


CREATE TRIGGER prevent_opening_balance_item_delete
BEFORE DELETE ON financial_opening_balance_items
BEGIN
  SELECT RAISE(
    ABORT,
    'Opening-balance evidence cannot be deleted'
  );
END;


-- A batch can only move through the approved workflow.
CREATE TRIGGER validate_opening_balance_batch_transition
BEFORE UPDATE OF status ON financial_opening_balance_batches
WHEN OLD.status != NEW.status
BEGIN
  SELECT CASE
    WHEN NOT (
      (OLD.status = 'draft' AND NEW.status = 'reviewed')
      OR
      (OLD.status = 'reviewed' AND NEW.status IN ('approved', 'cancelled'))
    )
    THEN RAISE(
      ABORT,
      'Invalid opening-balance batch status transition'
    )
  END;
END;


-- Reviewed, approved and cancelled batches cannot be edited
-- except for the permitted status transition itself.
CREATE TRIGGER prevent_opening_balance_batch_update_after_review
BEFORE UPDATE ON financial_opening_balance_batches
WHEN OLD.status != 'draft'
  AND NEW.status = OLD.status
BEGIN
  SELECT RAISE(
    ABORT,
    'Reviewed opening-balance batches are immutable'
  );
END;


CREATE TRIGGER prevent_opening_balance_batch_delete
BEFORE DELETE ON financial_opening_balance_batches
BEGIN
  SELECT RAISE(
    ABORT,
    'Opening-balance batches cannot be deleted'
  );
END;


-- ============================================================
-- ADDITIONAL OPENING-BALANCE INTEGRITY CONTROLS
-- ============================================================

-- A legacy source record must never be staged twice,
-- even if someone creates another batch.
CREATE UNIQUE INDEX idx_opening_balance_unique_source
ON financial_opening_balance_items(source_table, source_record_id);


-- Verified items must map to an account with the same currency.
CREATE TRIGGER validate_opening_balance_item_account_currency
BEFORE UPDATE OF
  item_status,
  account_id,
  currency_code,
  amount_minor,
  opening_side
ON financial_opening_balance_items
WHEN NEW.item_status = 'verified'
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM ledger_accounts a
      WHERE a.id = NEW.account_id
        AND a.currency_code = NEW.currency_code
    )
    THEN RAISE(
      ABORT,
      'Verified opening balance account currency mismatch'
    )
  END;
END;


-- A batch cannot enter review until every item has been
-- classified and the recorded counters match the evidence.
CREATE TRIGGER validate_opening_balance_review
BEFORE UPDATE OF status ON financial_opening_balance_batches
WHEN OLD.status = 'draft'
  AND NEW.status = 'reviewed'
BEGIN
  SELECT CASE
    WHEN NEW.reviewed_by_type IS NULL
      OR NEW.reviewed_by_id IS NULL
      OR NEW.reviewed_at IS NULL
    THEN RAISE(
      ABORT,
      'Reviewer identity and timestamp are required'
    )
  END;

  SELECT CASE
    WHEN NEW.total_items != (
      SELECT COUNT(*)
      FROM financial_opening_balance_items
      WHERE batch_id = NEW.id
    )
    THEN RAISE(
      ABORT,
      'Opening-balance total item count mismatch'
    )
  END;

  SELECT CASE
    WHEN NEW.verified_items != (
      SELECT COUNT(*)
      FROM financial_opening_balance_items
      WHERE batch_id = NEW.id
        AND item_status = 'verified'
    )
    OR NEW.disputed_items != (
      SELECT COUNT(*)
      FROM financial_opening_balance_items
      WHERE batch_id = NEW.id
        AND item_status = 'disputed'
    )
    OR NEW.excluded_items != (
      SELECT COUNT(*)
      FROM financial_opening_balance_items
      WHERE batch_id = NEW.id
        AND item_status = 'excluded'
    )
    THEN RAISE(
      ABORT,
      'Opening-balance item counters do not match evidence'
    )
  END;

  SELECT CASE
    WHEN NEW.total_items = 0
      OR NEW.verified_items + NEW.disputed_items
        + NEW.excluded_items != NEW.total_items
    THEN RAISE(
      ABORT,
      'All opening-balance items must be classified'
    )
  END;
END;


-- Approval requires a different reviewer and approver.
CREATE TRIGGER validate_opening_balance_approval
BEFORE UPDATE OF status ON financial_opening_balance_batches
WHEN OLD.status = 'reviewed'
  AND NEW.status = 'approved'
BEGIN
  SELECT CASE
    WHEN NEW.approved_by_type IS NULL
      OR NEW.approved_by_id IS NULL
      OR NEW.approved_at IS NULL
    THEN RAISE(
      ABORT,
      'Approver identity and timestamp are required'
    )
  END;

  SELECT CASE
    WHEN NEW.approved_by_type = OLD.reviewed_by_type
      AND NEW.approved_by_id = OLD.reviewed_by_id
    THEN RAISE(
      ABORT,
      'Reviewer cannot approve their own opening-balance batch'
    )
  END;

  SELECT CASE
    WHEN OLD.verified_items = 0
    THEN RAISE(
      ABORT,
      'Batch has no verified opening-balance items'
    )
  END;
END;


-- ============================================================
-- END MIGRATION 0039
-- ============================================================
