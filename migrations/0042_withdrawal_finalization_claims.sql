-- ============================================================
-- 0042: WITHDRAWAL FINALIZATION CLAIMS
-- ============================================================
-- Ensures a withdrawal can only have one finalization outcome:
-- settle OR release.
--
-- Same-outcome retries are allowed for crash recovery.
-- Opposite-outcome finalization is permanently blocked.
-- ============================================================

CREATE TABLE financial_withdrawal_finalization_claims (
  payment_operation_id TEXT PRIMARY KEY
    REFERENCES financial_payment_operations(id)
    ON DELETE RESTRICT,

  outcome TEXT NOT NULL
    CHECK (outcome IN ('settle', 'release')),

  claimed_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);


-- Only processing or reconciliation-required withdrawals
-- may receive a finalization claim.
CREATE TRIGGER validate_withdrawal_finalization_claim
BEFORE INSERT ON financial_withdrawal_finalization_claims
WHEN NOT EXISTS (
  SELECT 1
  FROM financial_payment_operations
  WHERE id = NEW.payment_operation_id
    AND operation_type = 'withdrawal'
    AND status IN (
      'processing',
      'reconciliation_required'
    )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'Only active withdrawals can be finalized'
  );
END;


-- A finalization decision is immutable.
CREATE TRIGGER prevent_withdrawal_finalization_claim_update
BEFORE UPDATE ON financial_withdrawal_finalization_claims
BEGIN
  SELECT RAISE(
    ABORT,
    'Withdrawal finalization claims are immutable'
  );
END;


-- Finalization evidence cannot be deleted.
CREATE TRIGGER prevent_withdrawal_finalization_claim_delete
BEFORE DELETE ON financial_withdrawal_finalization_claims
BEGIN
  SELECT RAISE(
    ABORT,
    'Withdrawal finalization claims cannot be deleted'
  );
END;


-- ============================================================
-- END MIGRATION 0042
-- ============================================================
