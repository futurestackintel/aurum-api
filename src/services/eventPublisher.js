// ============================================================
// AURUM DOMAIN EVENT PUBLISHER
// Persists domain events and their consumer delivery records.
// Uses D1 batch operations for atomic publication.
// ============================================================

const CONSUMER_KEY_PATTERN = /^[a-z][a-z0-9_.-]{1,79}$/;

export async function publishDomainEvent(db, event, consumerKeys) {
  if (!db || typeof db.batch !== 'function') {
    throw new Error('A valid D1 database binding is required');
  }

  if (!event || typeof event !== 'object') {
    throw new Error('A valid domain event is required');
  }

  if (
    typeof event.eventId !== 'string' ||
    typeof event.eventType !== 'string' ||
    !Number.isInteger(event.schemaVersion) ||
    typeof event.occurredAt !== 'string' ||
    !event.actor ||
    !event.resource ||
    typeof event.payload !== 'object' ||
    event.payload === null ||
    Array.isArray(event.payload)
  ) {
    throw new Error('Invalid domain event structure');
  }

  if (
    !Array.isArray(consumerKeys) ||
    consumerKeys.length === 0
  ) {
    throw new Error('At least one event consumer is required');
  }

  const uniqueConsumers = [...new Set(consumerKeys)];

  for (const key of uniqueConsumers) {
    if (
      typeof key !== 'string' ||
      !CONSUMER_KEY_PATTERN.test(key)
    ) {
      throw new Error('Invalid event consumer key');
    }
  }

  const statements = [
    db.prepare(`
      INSERT OR IGNORE INTO domain_events (
        event_id,
        event_type,
        schema_version,
        occurred_at,
        actor_type,
        actor_id,
        resource_type,
        resource_id,
        request_id,
        payload_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      event.eventId,
      event.eventType,
      event.schemaVersion,
      event.occurredAt,
      event.actor.type,
      event.actor.id ?? null,
      event.resource.type,
      event.resource.id,
      event.requestId ?? null,
      JSON.stringify(event.payload),
    ),
  ];

  for (const consumerKey of uniqueConsumers) {
    statements.push(
      db.prepare(`
        INSERT OR IGNORE INTO domain_event_deliveries (
          id,
          event_id,
          consumer_key
        )
        VALUES (?, ?, ?)
      `).bind(
        crypto.randomUUID(),
        event.eventId,
        consumerKey,
      ),
    );
  }

  await db.batch(statements);

  return {
    eventId: event.eventId,
    published: true,
    deliveryCount: uniqueConsumers.length,
  };
    }
