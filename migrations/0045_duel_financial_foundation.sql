
-- ============================================================
-- AURUM Migration 0045
-- Duel Financial Foundation
--
-- Adds currency-aware integer minor-unit financial fields.
-- Preserves historical Duel columns.
-- Historical Duel monetary values are assumed to be USD.
-- ============================================================

ALTER TABLE duels ADD COLUMN currency_code TEXT
  NOT NULL DEFAULT 'USD'
  REFERENCES financial_currencies(currency_code);

ALTER TABLE duels ADD COLUMN stake_amount_minor INTEGER
  NOT NULL DEFAULT 0
  CHECK (stake_amount_minor >= 0);

ALTER TABLE duels ADD COLUMN challenger_stake_funded_minor INTEGER
  NOT NULL DEFAULT 0
  CHECK (challenger_stake_funded_minor >= 0);

ALTER TABLE duels ADD COLUMN target_stake_funded_minor INTEGER
  NOT NULL DEFAULT 0
  CHECK (target_stake_funded_minor >= 0);

ALTER TABLE duels ADD COLUMN audience_tips_challenger_minor INTEGER
  NOT NULL DEFAULT 0
  CHECK (audience_tips_challenger_minor >= 0);

ALTER TABLE duels ADD COLUMN audience_tips_target_minor INTEGER
  NOT NULL DEFAULT 0
  CHECK (audience_tips_target_minor >= 0);

ALTER TABLE duels ADD COLUMN financial_status TEXT
  NOT NULL DEFAULT 'legacy'
  CHECK (
    financial_status IN (
      'legacy',
      'pending',
      'partially_funded',
      'funded',
      'settled',
      'refunded',
      'reconciliation_required'
    )
  );

-- Backfill historical Duel amounts.
-- Existing amounts are stored in USD major units.
UPDATE duels
SET stake_amount_minor = CAST(
  ROUND(duel_tip_amount * 100) AS INTEGER
)
WHERE stake_amount_minor = 0;

-- Existing historical audience tips were also USD.
UPDATE duels
SET audience_tips_challenger_minor = CAST(
  ROUND(audience_tips_challenger * 100) AS INTEGER
)
WHERE audience_tips_challenger_minor = 0;

UPDATE duels
SET audience_tips_target_minor = CAST(
  ROUND(audience_tips_target * 100) AS INTEGER
)
WHERE audience_tips_target_minor = 0;

CREATE INDEX idx_duels_financial_status
ON duels(financial_status, status);
