-- ============================================================
-- AURUM Migration 0048
-- Configurable Duel Minimum Stakes by Currency
--
-- Currency definitions are registered but remain disabled
-- unless explicitly enabled through financial_currencies.
-- Duel rules never activate a currency by themselves.
-- ============================================================

-- Register currency metadata only when it does not already exist.
-- Do not overwrite an existing currency's enabled status.

INSERT OR IGNORE INTO financial_currencies (
  currency_code,
  minor_unit_exponent,
  is_enabled
)
VALUES
  ('USD', 2, 0),
  ('NGN', 2, 0),
  ('GHS', 2, 0),
  ('KES', 2, 0),
  ('ZAR', 2, 0);


CREATE TABLE duel_currency_rules (
  currency_code TEXT PRIMARY KEY
    REFERENCES financial_currencies(currency_code)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,

  minimum_stake_minor INTEGER NOT NULL
    CHECK (minimum_stake_minor > 0),

  is_enabled INTEGER NOT NULL DEFAULT 1
    CHECK (is_enabled IN (0, 1)),

  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  updated_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);


-- Initial approved minimum stakes.
-- Amounts are stored in integer minor units.

INSERT INTO duel_currency_rules (
  currency_code,
  minimum_stake_minor
)
VALUES
  ('USD', 500),
  ('NGN', 500000),
  ('GHS', 5000),
  ('KES', 50000),
  ('ZAR', 10000);


CREATE INDEX idx_duel_currency_rules_enabled
ON duel_currency_rules(is_enabled, currency_code);


-- Currency definitions and Duel rules are separate controls.
-- A rule cannot be used unless its financial currency is enabled.
-- Enforce this again in the Duel service when validating stakes.

-- ============================================================
-- END MIGRATION 0048
-- ============================================================
