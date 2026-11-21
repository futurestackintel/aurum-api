-- ============================================================
-- AURUM Migration 0049
-- Duel Audience Tip Guards
-- ============================================================

-- Audience-tip counters may only increase when backed by a
-- pending audience-tip operation and a posted ledger transaction.

CREATE TRIGGER validate_duel_audience_tip_challenger_counter
BEFORE UPDATE OF audience_tips_challenger_minor ON duels
WHEN NEW.audience_tips_challenger_minor
  != OLD.audience_tips_challenger_minor
BEGIN

  SELECT CASE
    WHEN NEW.audience_tips_challenger_minor
      <= OLD.audience_tips_challenger_minor
    THEN RAISE(
      ABORT,
      'Duel audience-tip counters cannot decrease'
    )
  END;

  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM duel_financial_operations o
      JOIN ledger_transactions t
        ON t.id = o.ledger_transaction_id
      WHERE o.duel_id = NEW.id
        AND o.operation_type = 'audience_tip'
        AND o.status = 'pending'
        AND o.amount_minor =
          NEW.audience_tips_challenger_minor
          - OLD.audience_tips_challenger_minor
        AND o.currency_code = NEW.currency_code
        AND o.actor_id != NEW.challenger_id
        AND json_extract(
          o.metadata_json,
          '$.participant_id'
        ) = NEW.challenger_id
        AND json_extract(
          o.metadata_json,
          '$.participant_role'
        ) = 'challenger'
        AND t.status = 'posted'
    )
    THEN RAISE(
      ABORT,
      'Duel audience-tip counter requires posted ledger funding'
    )
  END;

END;


CREATE TRIGGER validate_duel_audience_tip_target_counter
BEFORE UPDATE OF audience_tips_target_minor ON duels
WHEN NEW.audience_tips_target_minor
  != OLD.audience_tips_target_minor
BEGIN

  SELECT CASE
    WHEN NEW.audience_tips_target_minor
      <= OLD.audience_tips_target_minor
    THEN RAISE(
      ABORT,
      'Duel audience-tip counters cannot decrease'
    )
  END;

  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM duel_financial_operations o
      JOIN ledger_transactions t
        ON t.id = o.ledger_transaction_id
      WHERE o.duel_id = NEW.id
        AND o.operation_type = 'audience_tip'
        AND o.status = 'pending'
        AND o.amount_minor =
          NEW.audience_tips_target_minor
          - OLD.audience_tips_target_minor
        AND o.currency_code = NEW.currency_code
        AND o.actor_id != NEW.target_id
        AND json_extract(
          o.metadata_json,
          '$.participant_id'
        ) = NEW.target_id
        AND json_extract(
          o.metadata_json,
          '$.participant_role'
        ) = 'target'
        AND t.status = 'posted'
    )
    THEN RAISE(
      ABORT,
      'Duel audience-tip counter requires posted ledger funding'
    )
  END;

END;


-- An audience-tip operation cannot become posted unless its
-- corresponding Duel counter has already been updated.

CREATE TRIGGER validate_duel_audience_tip_operation_posted
BEFORE UPDATE OF status ON duel_financial_operations
WHEN
  NEW.status = 'posted'
  AND NEW.operation_type = 'audience_tip'
BEGIN

  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM duels d
      WHERE d.id = NEW.duel_id
        AND d.currency_code = NEW.currency_code
        AND (
          (
            json_extract(
              NEW.metadata_json,
              '$.participant_role'
            ) = 'challenger'
            AND json_extract(
              NEW.metadata_json,
              '$.participant_id'
            ) = d.challenger_id
            AND d.audience_tips_challenger_minor
              >= NEW.amount_minor
          )
          OR
          (
            json_extract(
              NEW.metadata_json,
              '$.participant_role'
            ) = 'target'
            AND json_extract(
              NEW.metadata_json,
              '$.participant_id'
            ) = d.target_id
            AND d.audience_tips_target_minor
              >= NEW.amount_minor
          )
        )
    )
    THEN RAISE(
      ABORT,
      'Posted audience-tip operation requires matching Duel counter'
    )
  END;

END;

-- Audience-tip operations must reference a valid active Duel
-- and a valid non-participant tipper/participant combination.

CREATE TRIGGER validate_duel_audience_tip_operation_insert
BEFORE INSERT ON duel_financial_operations
WHEN NEW.operation_type = 'audience_tip'
BEGIN

  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM duels d
      WHERE d.id = NEW.duel_id
        AND d.status = 'active'
        AND d.financial_status = 'funded'
        AND d.payout_released = 0
        AND d.currency_code = NEW.currency_code
        AND NEW.actor_id NOT IN (
          d.challenger_id,
          d.target_id
        )
        AND (
          (
            json_extract(
              NEW.metadata_json,
              '$.participant_role'
            ) = 'challenger'
            AND json_extract(
              NEW.metadata_json,
              '$.participant_id'
            ) = d.challenger_id
          )
          OR
          (
            json_extract(
              NEW.metadata_json,
              '$.participant_role'
            ) = 'target'
            AND json_extract(
              NEW.metadata_json,
              '$.participant_id'
            ) = d.target_id
          )
        )
    )
    THEN RAISE(
      ABORT,
      'Invalid Duel audience-tip operation'
    )
  END;

END;
-- ============================================================
-- END MIGRATION 0049
-- ============================================================
