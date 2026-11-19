-- Restores the missing base schema for the stake-based Duel system.
-- Later migrations add dispute and Quick Duel columns.
-- IF NOT EXISTS protects databases where these tables already exist.

CREATE TABLE IF NOT EXISTS duels (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  challenger_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  duel_tip_amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  winner_id TEXT,
  challenger_proof TEXT,
  target_proof TEXT,
  challenger_proof_value INTEGER DEFAULT 0,
  target_proof_value INTEGER DEFAULT 0,
  accepted_at TEXT,
  ends_at TEXT,
  resolved_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  announced_at TEXT,
  is_public_announced INTEGER DEFAULT 0,
  stream_ready INTEGER DEFAULT 0,
  stream_url TEXT,
  audience_tips_challenger REAL DEFAULT 0,
  audience_tips_target REAL DEFAULT 0,
  community_vote_challenger INTEGER DEFAULT 0,
  community_vote_target INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS duel_watchers (
  id TEXT PRIMARY KEY,
  duel_id TEXT NOT NULL REFERENCES duels(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  ),
  UNIQUE(duel_id, user_id)
);

CREATE TABLE IF NOT EXISTS duel_votes (
  id TEXT PRIMARY KEY,
  duel_id TEXT NOT NULL REFERENCES duels(id),
  voter_id TEXT NOT NULL REFERENCES users(id),
  voted_for_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  ),
  UNIQUE(duel_id, voter_id)
);
