 CREATE TABLE tips (
  id                        TEXT PRIMARY KEY,
  sender_id                 TEXT NOT NULL REFERENCES users(id),
  receiver_id               TEXT NOT NULL REFERENCES users(id),
  post_id                   TEXT REFERENCES posts(id),
  amount_cents              INTEGER NOT NULL CHECK (amount_cents > 0),
  platform_fee_cents        INTEGER NOT NULL,
  receiver_net_cents        INTEGER NOT NULL,
  stripe_payment_intent_id  TEXT NOT NULL UNIQUE,
  status                    TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
  message                   TEXT,
  created_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  completed_at              TEXT
);

CREATE INDEX idx_tips_sender ON tips (sender_id, created_at DESC);
CREATE INDEX idx_tips_receiver ON tips (receiver_id, created_at DESC);
CREATE INDEX idx_tips_post ON tips (post_id) WHERE post_id IS NOT NULL;
CREATE INDEX idx_tips_status ON tips (status) WHERE status = 'pending';
