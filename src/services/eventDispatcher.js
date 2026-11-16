// ============================================================
// AURUM DOMAIN EVENT DISPATCHER
// Claims, processes, retries and completes event deliveries.
// Delivery is at-least-once; consumers must be idempotent.
// ============================================================

const MAX_ATTEMPTS = 8;
const LOCK_DURATION_MS = 60_000;

const RETRY_DELAYS_MS = [
  5_000,
  15_000,
  30_000,
  60_000,
  120_000,
  300_000,
  600_000,
];

const CONSUMER_KEY_PATTERN = /^[a-z][a-z0-9_.-]{1,79}$/;

function createLeaseExpiry() {
  // Small random offset makes simultaneous lease values unlikely.
  const offset = crypto.getRandomValues(new Uint16Array(1))[0] % 1000;

  return new Date(
    Date.now() + LOCK_DURATION_MS + offset,
  ).toISOString();
}

async function claimNextDelivery(db, consumerKey) {
  const now = new Date().toISOString();
  const leaseExpiry = createLeaseExpiry();
  // Recover deliveries that expired during their final attempt.
  await db.prepare(`
    UPDATE domain_event_deliveries
    SET
      status = 'dead_letter',
      locked_until = NULL,
      last_error = 'MaxAttemptsExceeded',
      updated_at = ?
    WHERE consumer_key = ?
      AND status = 'processing'
      AND locked_until <= ?
      AND attempts >= ?
  `).bind(
    now,
    consumerKey,
    now,
    MAX_ATTEMPTS,
  ).run();
	
  return db.prepare(`
    UPDATE domain_event_deliveries
    SET
      status = 'processing',
      attempts = attempts + 1,
      locked_until = ?,
      updated_at = ?
    WHERE id = (
      SELECT id
      FROM domain_event_deliveries
      WHERE consumer_key = ?
        AND attempts < ?
        AND (
          (status = 'pending' AND available_at <= ?)
          OR
          (status = 'processing' AND locked_until <= ?)
        )
      ORDER BY available_at ASC, created_at ASC
      LIMIT 1
    )
    AND attempts < ?
    AND (
      (status = 'pending' AND available_at <= ?)
      OR
      (status = 'processing' AND locked_until <= ?)
    )
    RETURNING
      id,
      event_id,
      consumer_key,
      attempts,
      locked_until
  `).bind(
    leaseExpiry,
    now,
    consumerKey,
    MAX_ATTEMPTS,
    now,
    now,
    MAX_ATTEMPTS,
    now,
    now,
  ).first();
}

async function completeDelivery(db, delivery) {
  const now = new Date().toISOString();

  const result = await db.prepare(`
    UPDATE domain_event_deliveries
    SET
      status = 'succeeded',
      processed_at = ?,
      locked_until = NULL,
      last_error = NULL,
      updated_at = ?
    WHERE id = ?
      AND status = 'processing'
      AND locked_until = ?
  `).bind(
    now,
    now,
    delivery.id,
    delivery.locked_until,
  ).run();

  return result.meta.changes === 1;
}

async function failDelivery(db, delivery, error) {
  const now = new Date().toISOString();
  const exhausted = delivery.attempts >= MAX_ATTEMPTS;

  const delay = RETRY_DELAYS_MS[
    Math.min(delivery.attempts - 1, RETRY_DELAYS_MS.length - 1)
  ];

  const nextAttempt = new Date(Date.now() + delay).toISOString();

  // Store only a safe error category, never arbitrary error messages.
  const errorName =
    typeof error?.name === 'string' &&
    /^[a-zA-Z0-9_.-]{1,80}$/.test(error.name)
      ? error.name
      : 'ProcessingError';

  const result = await db.prepare(`
    UPDATE domain_event_deliveries
    SET
      status = ?,
      available_at = ?,
      locked_until = NULL,
      last_error = ?,
      updated_at = ?
    WHERE id = ?
      AND status = 'processing'
      AND locked_until = ?
  `).bind(
    exhausted ? 'dead_letter' : 'pending',
    exhausted ? now : nextAttempt,
    errorName,
    now,
    delivery.id,
    delivery.locked_until,
  ).run();

  return {
    updated: result.meta.changes === 1,
    deadLettered: exhausted && result.meta.changes === 1,
    retryScheduled: !exhausted && result.meta.changes === 1,
  };
}

export async function dispatchNextEvent(db, consumerKey, handler) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('A valid D1 database binding is required');
  }

  if (
    typeof consumerKey !== 'string' ||
    !CONSUMER_KEY_PATTERN.test(consumerKey)
  ) {
    throw new Error('Invalid event consumer key');
  }

  if (typeof handler !== 'function') {
    throw new Error('An event consumer handler is required');
  }

  const delivery = await claimNextDelivery(db, consumerKey);

  if (!delivery) {
    return {
      processed: false,
      reason: 'no_pending_delivery',
    };
  }

  try {
    const eventRow = await db.prepare(`
      SELECT
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
      FROM domain_events
      WHERE event_id = ?
    `).bind(delivery.event_id).first();

    if (!eventRow) {
      throw new Error('DomainEventMissing');
    }

    const event = {
      eventId: eventRow.event_id,
      eventType: eventRow.event_type,
      schemaVersion: eventRow.schema_version,
      occurredAt: eventRow.occurred_at,
      actor: {
        type: eventRow.actor_type,
        id: eventRow.actor_id,
      },
      resource: {
        type: eventRow.resource_type,
        id: eventRow.resource_id,
      },
      requestId: eventRow.request_id,
      payload: JSON.parse(eventRow.payload_json),
    };

    await handler(event, {
      deliveryId: delivery.id,
      attempt: delivery.attempts,
      consumerKey,
    });

    const completed = await completeDelivery(db, delivery);

    return {
      processed: completed,
      eventId: delivery.event_id,
      deliveryId: delivery.id,
      status: completed ? 'succeeded' : 'lease_lost',
    };
  } catch (error) {
    const failure = await failDelivery(db, delivery, error);

    return {
      processed: false,
      eventId: delivery.event_id,
      deliveryId: delivery.id,
      status: failure.deadLettered
        ? 'dead_letter'
        : failure.retryScheduled
          ? 'retry_scheduled'
          : 'lease_lost',
    };
  }
}
