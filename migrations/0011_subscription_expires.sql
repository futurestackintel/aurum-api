-- Migration 0011 — Add expires_at to subscriptions
-- Module Chat D — Fix 5
-- Tracks when a subscription expires so the daily cron can downgrade users.

ALTER TABLE subscriptions ADD COLUMN expires_at TEXT;
