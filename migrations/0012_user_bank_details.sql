-- ============================================================
-- Migration: user_bank_details
-- Stores saved withdrawal bank account details per user, separate
-- from the per-withdrawal account_number/bank_code/account_name
-- currently passed directly into POST /api/wallet/withdraw.
-- ============================================================

CREATE TABLE IF NOT EXISTS user_bank_details (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  bank_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  account_name TEXT NOT NULL,
  bank_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
