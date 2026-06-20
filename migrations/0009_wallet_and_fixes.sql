-- ============================================================
-- AURUM Migration 0009 — Wallet tables + schema corrections
-- Run: wrangler d1 execute aurum-db --remote --file=migrations/0009_wallet_and_fixes.sql
-- ============================================================

-- ============================================================
-- FIX 1: aurum_score_events
-- Problem: columns and CHECK values don't match aurumScore.js
-- Solution: drop and recreate with correct schema
-- Safe: no production score data exists yet (every insert
--       has been silently failing due to constraint mismatch)
-- ============================================================

DROP TABLE IF EXISTS aurum_score_events;

CREATE TABLE aurum_score_events (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL
                 CHECK (event_type IN (
                   'verified_achievement_post',
                   'challenge_win',
                   'tip_sent',
                   'tip_received_reaction',
                   'streak_day',
                   'account_age_week',
                   'badge_earned',
                   'post_flagged_fake',
                   'challenge_forfeit',
                   'founding_member',
                   'gold_button_given',
                   'crew_battle_win',
                   'challenge_boost_purchased',
                   'audience_tip_sent'
                 )),
  delta        INTEGER NOT NULL,
  post_id      TEXT REFERENCES posts(id),
  challenge_id TEXT REFERENCES challenges(id),
  tip_id       TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_score_events_user ON aurum_score_events (user_id, created_at DESC);
CREATE INDEX idx_score_events_type ON aurum_score_events (event_type, created_at DESC);

-- ============================================================
-- FIX 2: subscriptions
-- Problem: built for Stripe, code uses Paystack with
--          payment_reference column that doesn't exist
-- Solution: drop and recreate Paystack-compatible schema
-- Safe: no active subscriptions exist yet (every insert
--       has been failing due to missing required columns)
-- ============================================================

DROP TABLE IF EXISTS subscriptions;

CREATE TABLE subscriptions (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier              TEXT NOT NULL CHECK (tier IN ('contender', 'sovereign')),
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'active', 'past_due', 'canceled')),
  payment_reference TEXT,
  activated_at      TEXT,
  expires_at        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_subscriptions_user   ON subscriptions (user_id);
CREATE INDEX idx_subscriptions_status ON subscriptions (status);

-- ============================================================
-- FIX 3: tips table
-- Problem 1: stripe_payment_intent_id is NOT NULL UNIQUE —
--            wallet tips have no external reference
-- Problem 2: no paystack_reference column for idempotency
-- Solution: make stripe column nullable, add paystack_reference,
--           add is_wallet_tip flag
-- ============================================================

ALTER TABLE tips RENAME COLUMN stripe_payment_intent_id TO stripe_payment_intent_id_old;

-- D1 doesn't support DROP COLUMN or modify constraints directly.
-- We recreate the table cleanly.

CREATE TABLE tips_new (
  id                       TEXT PRIMARY KEY,
  sender_id                TEXT NOT NULL REFERENCES users(id),
  receiver_id              TEXT NOT NULL REFERENCES users(id),
  post_id                  TEXT REFERENCES posts(id),
  amount_cents             INTEGER NOT NULL CHECK (amount_cents > 0),
  platform_fee_cents       INTEGER NOT NULL,
  receiver_net_cents       INTEGER NOT NULL,
  stripe_payment_intent_id TEXT UNIQUE,
  paystack_reference       TEXT UNIQUE,
  is_wallet_tip            INTEGER NOT NULL DEFAULT 0 CHECK (is_wallet_tip IN (0, 1)),
  status                   TEXT NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
  message                  TEXT,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  completed_at             TEXT
);

INSERT INTO tips_new
  (id, sender_id, receiver_id, post_id, amount_cents, platform_fee_cents,
   receiver_net_cents, stripe_payment_intent_id, is_wallet_tip, status,
   message, created_at, completed_at)
SELECT
  id, sender_id, receiver_id, post_id, amount_cents, platform_fee_cents,
  receiver_net_cents, stripe_payment_intent_id_old, 0, status,
  message, created_at, completed_at
FROM tips;

DROP TABLE tips;
ALTER TABLE tips_new RENAME TO tips;

CREATE INDEX idx_tips_sender   ON tips (sender_id, created_at DESC);
CREATE INDEX idx_tips_receiver ON tips (receiver_id, created_at DESC);
CREATE INDEX idx_tips_post     ON tips (post_id) WHERE post_id IS NOT NULL;
CREATE INDEX idx_tips_status   ON tips (status) WHERE status = 'pending';
CREATE INDEX idx_tips_paystack ON tips (paystack_reference) WHERE paystack_reference IS NOT NULL;

-- ============================================================
-- NEW: Wallet tables
-- ============================================================

CREATE TABLE IF NOT EXISTS wallets (
  id                      TEXT PRIMARY KEY,
  user_id                 TEXT NOT NULL UNIQUE REFERENCES users(id),
  balance_usd             REAL NOT NULL DEFAULT 0,
  total_deposited_usd     REAL NOT NULL DEFAULT 0,
  total_withdrawn_usd     REAL NOT NULL DEFAULT 0,
  total_tips_sent_usd     REAL NOT NULL DEFAULT 0,
  total_tips_received_usd REAL NOT NULL DEFAULT 0,
  currency_preference     TEXT NOT NULL DEFAULT 'USD'
                            CHECK (currency_preference IN ('USD','NGN','GHS','KES','ZAR')),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets (user_id);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id                TEXT PRIMARY KEY,
  wallet_id         TEXT NOT NULL REFERENCES wallets(id),
  user_id           TEXT NOT NULL REFERENCES users(id),
  type              TEXT NOT NULL CHECK (type IN (
                      'deposit', 'withdrawal', 'tip_sent', 'tip_received',
                      'challenge_entry', 'challenge_payout', 'stake_lock',
                      'stake_return', 'stake_slash', 'fee'
                    )),
  amount_usd        REAL NOT NULL,
  balance_after_usd REAL NOT NULL,
  reference         TEXT,
  description       TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wallet_tx_user    ON wallet_transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_wallet  ON wallet_transactions (wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_ref     ON wallet_transactions (reference) WHERE reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS exchange_rates (
  id          TEXT PRIMARY KEY,
  currency    TEXT NOT NULL UNIQUE,
  rate_to_usd REAL NOT NULL,
  updated_at  TEXT NOT NULL
);

INSERT OR IGNORE INTO exchange_rates (id, currency, rate_to_usd, updated_at) VALUES
  ('rate_usd', 'USD', 1.0,     strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('rate_ngn', 'NGN', 0.00065, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('rate_ghs', 'GHS', 0.068,   strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('rate_kes', 'KES', 0.0077,  strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('rate_zar', 'ZAR', 0.055,   strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
