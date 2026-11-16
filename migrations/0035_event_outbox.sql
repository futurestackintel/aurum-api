-- AURUM Domain Event Outbox
-- Stores immutable domain events and tracks delivery per consumer.
-- Event records are not financial ledger transactions.

CREATE TABLE IF NOT EXISTS domain_events (
  event_id TEXT PRIMARY KEY,

  event_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),

  occurred_at TEXT NOT NULL,

  actor_type TEXT NOT NULL
    CHECK (actor_type IN ('member', 'platform_admin', 'system')),
  actor_id TEXT,

  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,

  request_id TEXT,

  payload_json TEXT NOT NULL
    CHECK (json_valid(payload_json)),

  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_domain_events_type_created
ON domain_events(event_type, created_at);

CREATE INDEX IF NOT EXISTS idx_domain_events_resource
ON domain_events(resource_type, resource_id, created_at);

CREATE INDEX IF NOT EXISTS idx_domain_events_request
ON domain_events(request_id);


CREATE TABLE IF NOT EXISTS domain_event_deliveries (
  id TEXT PRIMARY KEY,

  event_id TEXT NOT NULL
    REFERENCES domain_events(event_id) ON DELETE RESTRICT,

  consumer_key TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      status IN (
        'pending',
        'processing',
        'succeeded',
        'dead_letter'
      )
    ),

  attempts INTEGER NOT NULL DEFAULT 0
    CHECK (attempts >= 0),

  available_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  locked_until TEXT,

  processed_at TEXT,

  last_error TEXT,

  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  updated_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  UNIQUE (event_id, consumer_key)
);

CREATE INDEX IF NOT EXISTS idx_event_deliveries_pending
ON domain_event_deliveries(status, available_at);

CREATE INDEX IF NOT EXISTS idx_event_deliveries_consumer
ON domain_event_deliveries(consumer_key, status, available_at);

CREATE INDEX IF NOT EXISTS idx_event_deliveries_event
ON domain_event_deliveries(event_id);


-- Domain event records are immutable.
CREATE TRIGGER IF NOT EXISTS prevent_domain_event_update
BEFORE UPDATE ON domain_events
BEGIN
  SELECT RAISE(ABORT, 'Domain event records are immutable');
END;

CREATE TRIGGER IF NOT EXISTS prevent_domain_event_delete
BEFORE DELETE ON domain_events
BEGIN
  SELECT RAISE(ABORT, 'Domain event records cannot be deleted');
END;
