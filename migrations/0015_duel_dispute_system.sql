ALTER TABLE duels ADD COLUMN post_id TEXT REFERENCES posts(id);
ALTER TABLE duels ADD COLUMN window_hours INTEGER NOT NULL DEFAULT 168;
ALTER TABLE duels ADD COLUMN dispute_status TEXT DEFAULT 'none' CHECK (dispute_status IN ('none','window_open','reported','resolved'));
ALTER TABLE duels ADD COLUMN dispute_deadline TEXT;
ALTER TABLE duels ADD COLUMN dispute_reported_by TEXT REFERENCES users(id);
ALTER TABLE duels ADD COLUMN dispute_reason TEXT;
ALTER TABLE duels ADD COLUMN payout_released INTEGER DEFAULT 0;
ALTER TABLE posts ADD COLUMN duel_id TEXT REFERENCES duels(id);
