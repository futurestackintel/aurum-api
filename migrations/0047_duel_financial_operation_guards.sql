
-- ============================================================
-- AURUM Migration 0047
-- Duel Financial Operation Guards
-- ============================================================

-- Validate stake operation identity and amount before insertion.
CREATE TRIGGER validate_duel_stake_operation_insert
BEFORE INSERT ON duel_financial_operations
WHEN NEW.operation_type IN ('challenger_stake', 'target_stake')
BEGIN

  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM duels d
      WHERE d.id = NEW.duel_id
        AND d.currency_code = NEW.currency_code
        AND d.stake_amount_minor = NEW.amount_minor
        AND d.status IN ('pending', 'active')
        AND d.financial_status IN ('pending', 'partially_funded')
        AND (
          (
            NEW.operation_type = 'challenger_stake'
            AND d.challenger_id = NEW.actor_id
            AND d.challenger_stake_funded_minor = 0
          )
          OR
          (
            NEW.operation_type = 'target_stake'
            AND d.target_id = NEW.actor_id
            AND d.target_stake_funded_minor = 0
            AND d.challenger_stake_funded_minor = d.stake_amount_minor
          )
        )
    )
    THEN RAISE(
      ABORT,
      'Duel stake operation does not match an eligible participant'
    )
  END;

END;


-- A Duel stake funding update must be backed by a posted ledger
-- transaction and a pending operation for the same participant.
CREATE TRIGGER validate_duel_stake_funding_update
BEFORE UPDATE OF
  challenger_stake_funded_minor,
  target_stake_funded_minor
ON duels
WHEN
  NEW.challenger_stake_funded_minor != OLD.challenger_stake_funded_minor
  OR NEW.target_stake_funded_minor != OLD.target_stake_funded_minor
BEGIN

  SELECT CASE
    WHEN NEW.challenger_stake_funded_minor != OLD.challenger_stake_funded_minor
      AND NOT EXISTS (
        SELECT 1
        FROM duel_financial_operations o
        JOIN ledger_transactions t
          ON t.id = o.ledger_transaction_id
        WHERE o.duel_id = NEW.id
          AND o.operation_type = 'challenger_stake'
          AND o.actor_id = NEW.challenger_id
          AND o.amount_minor = NEW.challenger_stake_funded_minor
          AND o.status = 'pending'
          AND t.status = 'posted'
      )
    THEN RAISE(
      ABORT,
      'Challenger stake update requires posted ledger funding'
    )
  END;

  SELECT CASE
    WHEN NEW.target_stake_funded_minor != OLD.target_stake_funded_minor
      AND NOT EXISTS (
        SELECT 1
        FROM duel_financial_operations o
        JOIN ledger_transactions t
          ON t.id = o.ledger_transaction_id
        WHERE o.duel_id = NEW.id
          AND o.operation_type = 'target_stake'
          AND o.actor_id = NEW.target_id
          AND o.amount_minor = NEW.target_stake_funded_minor
          AND o.status = 'pending'
          AND t.status = 'posted'
      )
    THEN RAISE(
      ABORT,
      'Target stake update requires posted ledger funding'
    )
  END;

END;

-- A stake operation cannot become posted unless the matching
-- Duel record reflects the funded amount.
CREATE TRIGGER validate_duel_stake_operation_posted
BEFORE UPDATE OF status ON duel_financial_operations
WHEN
  NEW.status = 'posted'
  AND NEW.operation_type IN ('challenger_stake', 'target_stake')
BEGIN

  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM duels d
      WHERE d.id = NEW.duel_id
        AND d.currency_code = NEW.currency_code
        AND (
          (
            NEW.operation_type = 'challenger_stake'
            AND d.challenger_id = NEW.actor_id
            AND d.challenger_stake_funded_minor = NEW.amount_minor
          )
          OR
          (
            NEW.operation_type = 'target_stake'
            AND d.target_id = NEW.actor_id
            AND d.target_stake_funded_minor = NEW.amount_minor
          )
        )
    )
    THEN RAISE(
      ABORT,
      'Posted Duel stake operation requires matching funded Duel record'
    )
  END;

END;

-- ============================================================
-- END MIGRATION 0047
-- ============================================================
