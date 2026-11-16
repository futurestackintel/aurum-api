-- Link notifications to their originating domain event.
-- A notification can only be created once per event and recipient.

ALTER TABLE notifications
ADD COLUMN source_event_id TEXT
REFERENCES domain_events(event_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_event_recipient
ON notifications(source_event_id, user_id)
WHERE source_event_id IS NOT NULL;
