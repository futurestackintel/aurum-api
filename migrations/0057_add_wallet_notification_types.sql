-- Allow completed wallet operations to create notifications.
-- Preserve existing notification data and event idempotency.

CREATE TABLE notifications_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'tip_received', 'challenge_won', 'challenge_joined', 'challenge_ending_soon',
    'duel_received', 'duel_accepted', 'duel_result', 'duel_announced',
    'post_reacted', 'post_tipped', 'post_commented',
    'badge_awarded', 'league_promoted', 'league_demoted',
    'stake_verified', 'stake_disputed', 'stake_forfeited',
    'room_invited', 'subscription_renewal', 'system_alert',
    'crew_promoted', 'crew_demoted', 'crew_kicked', 'crew_mention', 'dm_received',
    'message_reaction', 'crew_invite', 'crew_join_request',
    'new_follower', 'connection_request', 'connection_accepted',
    'deposit_completed', 'withdrawal_completed'
  )),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  action_url TEXT,
  metadata TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  read_at TEXT,
  source_event_id TEXT REFERENCES domain_events(event_id) ON DELETE RESTRICT
);

INSERT INTO notifications_new (
  id, user_id, type, title, body, action_url, metadata,
  is_read, created_at, read_at, source_event_id
)
SELECT
  id, user_id, type, title, body, action_url, metadata,
  is_read, created_at, read_at, source_event_id
FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;

CREATE INDEX idx_notifications_user_unread
ON notifications(user_id, created_at DESC)
WHERE is_read = 0;

CREATE INDEX idx_notifications_user_all
ON notifications(user_id, created_at DESC);

CREATE UNIQUE INDEX idx_notifications_event_recipient
ON notifications(source_event_id, user_id)
WHERE source_event_id IS NOT NULL;
