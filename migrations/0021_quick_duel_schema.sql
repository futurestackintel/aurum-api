-- 0021_quick_duel_schema.sql
-- Adds Quick Duel support: a duel_type flag to distinguish the existing
-- async "proof" duels from new self-contained Quick Duels, plus a
-- dedicated results table for score submission and blind-then-reveal.

ALTER TABLE duels ADD COLUMN duel_type TEXT NOT NULL DEFAULT 'proof';
ALTER TABLE duels ADD COLUMN quick_game_type TEXT;

CREATE TABLE quick_duel_results (
  id                    TEXT PRIMARY KEY,
  duel_id               TEXT NOT NULL REFERENCES duels(id),
  challenger_score      INTEGER,
  target_score          INTEGER,
  challenger_submitted_at TEXT,
  target_submitted_at  TEXT,
  created_at            TEXT NOT NULL
);

CREATE INDEX idx_quick_duel_results_duel_id ON quick_duel_results(duel_id);
