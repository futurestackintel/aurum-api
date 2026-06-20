-- ============================================================
-- Migration 0010 — Module C
-- 1. Add appeal columns to posts
-- 2. Add paystack_reference to challenge_entries
-- 3. Create founding_members table
-- ============================================================

-- Fix 3: Appeal window columns on posts
ALTER TABLE posts ADD COLUMN appeal_deadline TEXT;
ALTER TABLE posts ADD COLUMN appeal_reason TEXT;
ALTER TABLE posts ADD COLUMN appeal_status TEXT;

-- Fix 6: Paystack reference on challenge_entries
ALTER TABLE challenge_entries ADD COLUMN paystack_reference TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_challenge_entries_paystack_ref
ON challenge_entries(paystack_reference)
WHERE paystack_reference IS NOT NULL;

-- Build 1: Founding members table
CREATE TABLE IF NOT EXISTS founding_members (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL UNIQUE,
  payment_reference TEXT NOT NULL,
  amount_usd       REAL NOT NULL DEFAULT 20,
  joined_at        TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
