-- ============================================================
-- AURUM Migration 0051
-- Challenge Entry Minor-Unit Accounting
--
-- Adds currency-safe entry amount storage.
-- Preserves historical USD cents as minor units.
-- Does not move or modify wallet balances.
-- ============================================================

ALTER TABLE challenge_entries
ADD COLUMN entry_fee_paid_minor INTEGER
NOT NULL DEFAULT 0
CHECK (entry_fee_paid_minor >= 0);


-- Historical Challenge entries are USD.
-- Their existing cents values are therefore valid USD minor units.
UPDATE challenge_entries
SET entry_fee_paid_minor = COALESCE(entry_fee_paid_cents, 0)
WHERE EXISTS (
  SELECT 1
  FROM challenges c
  WHERE c.id = challenge_entries.challenge_id
    AND c.currency_code = 'USD'
    AND c.financial_status = 'legacy'
);


-- Once an entry has a posted funding operation,
-- its financial identity and amount cannot be changed.
CREATE TRIGGER prevent_posted_challenge_entry_financial_update
BEFORE UPDATE OF
  challenge_id,
  user_id,
  entry_fee_paid_minor,
  entry_fee_paid_cents
ON challenge_entries
WHEN EXISTS (
  SELECT 1
  FROM challenge_financial_operations op
  WHERE op.entry_id = OLD.id
    AND op.operation_type = 'entry_funding'
    AND op.status = 'posted'
)
BEGIN
  SELECT RAISE(
    ABORT,
    'Posted Challenge entry funding is immutable'
  );
END;


-- A financially funded entry cannot be deleted.
CREATE TRIGGER prevent_posted_challenge_entry_delete
BEFORE DELETE ON challenge_entries
WHEN EXISTS (
  SELECT 1
  FROM challenge_financial_operations op
  WHERE op.entry_id = OLD.id
    AND op.operation_type = 'entry_funding'
    AND op.status = 'posted'
)
BEGIN
  SELECT RAISE(
    ABORT,
    'Posted Challenge entries cannot be deleted'
  );
END;


CREATE INDEX idx_challenge_entries_financial_amount
ON challenge_entries(challenge_id, entry_fee_paid_minor);


-- ============================================================
-- END MIGRATION 0051
-- ============================================================
