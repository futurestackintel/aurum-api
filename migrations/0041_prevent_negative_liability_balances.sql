-- ============================================================
-- 0041: PREVENT NEGATIVE LIABILITY ACCOUNT BALANCES
-- ============================================================
-- Prevents posted ledger transactions from reducing liability
-- account balances below zero.
--
-- Applies to user wallets, crew wallets and escrow accounts.
--
-- Liability accounts have a natural credit balance:
-- credits increase the balance; debits decrease it.
-- ============================================================

CREATE TRIGGER prevent_negative_liability_account_balance
BEFORE UPDATE OF status ON ledger_transactions
WHEN OLD.status = 'draft'
  AND NEW.status = 'posted'
BEGIN

  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM ledger_entries AS pending_entry

      JOIN ledger_accounts AS account
        ON account.id = pending_entry.account_id

      WHERE pending_entry.transaction_id = NEW.id
        AND account.account_class = 'liability'

        AND (

          -- Existing posted balance.
          COALESCE((
            SELECT SUM(
              CASE
                WHEN entry.entry_side = 'credit'
                THEN entry.amount_minor
                ELSE -entry.amount_minor
              END
            )
            FROM ledger_entries AS entry

            JOIN ledger_transactions AS posted_transaction
              ON posted_transaction.id = entry.transaction_id

            WHERE entry.account_id = account.id
              AND posted_transaction.status = 'posted'
          ), 0)

          +

          -- Proposed entries in the transaction being posted.
          COALESCE((
            SELECT SUM(
              CASE
                WHEN entry.entry_side = 'credit'
                THEN entry.amount_minor
                ELSE -entry.amount_minor
              END
            )
            FROM ledger_entries AS entry

            WHERE entry.transaction_id = NEW.id
              AND entry.account_id = account.id
          ), 0)

        ) < 0
    )

    THEN RAISE(
      ABORT,
      'Transaction would create a negative liability account balance'
    )
  END;

END;


-- ============================================================
-- END MIGRATION 0041
-- ============================================================
