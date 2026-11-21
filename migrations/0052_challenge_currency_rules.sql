-- ============================================================
-- AURUM Migration 0052
-- Configurable Challenge Entry Rules
-- ============================================================

CREATE TABLE challenge_currency_rules (
  currency_code TEXT PRIMARY KEY
    REFERENCES financial_currencies(currency_code)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,

  minimum_entry_minor INTEGER NOT NULL
    CHECK (minimum_entry_minor > 0),

  is_enabled INTEGER NOT NULL DEFAULT 1
    CHECK (is_enabled IN (0, 1)),

  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  updated_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO challenge_currency_rules (
  currency_code,
  minimum_entry_minor
)
VALUES
  ('USD', 500),
  ('NGN', 500000),
  ('GHS', 5000),
  ('KES', 50000),
  ('ZAR', 10000);

CREATE INDEX idx_challenge_currency_rules_enabled
ON challenge_currency_rules(is_enabled, currency_code);

-- ============================================================
-- END MIGRATION 0052
-- ============================================================
