ALTER TABLE notification_preferences
  ADD COLUMN messages INTEGER NOT NULL DEFAULT 1;

ALTER TABLE notification_preferences
  ADD COLUMN crew_updates INTEGER NOT NULL DEFAULT 1;
