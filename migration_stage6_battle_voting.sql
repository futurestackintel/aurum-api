ALTER TABLE crew_battles ADD COLUMN dispute_status TEXT DEFAULT 'none' CHECK (dispute_status IN ('none','awaiting_dispute','disputed','admin_review'));
ALTER TABLE crew_battles ADD COLUMN dispute_deadline TEXT;
ALTER TABLE crew_battles ADD COLUMN dispute_reported_by TEXT REFERENCES users(id);
ALTER TABLE crew_battles ADD COLUMN dispute_reason TEXT;

CREATE TABLE crew_battle_votes (
  id TEXT PRIMARY KEY,
  battle_id TEXT NOT NULL REFERENCES crew_battles(id),
  voter_id TEXT NOT NULL REFERENCES users(id),
  voted_crew_id TEXT NOT NULL REFERENCES crews(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE(battle_id, voter_id)
);