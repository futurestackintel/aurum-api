// ============================================================
// AURUM EVENT CONSUMER REGISTRY
// Registers trusted consumers and processes their deliveries.
// ============================================================

import { dispatchNextEvent } from './eventDispatcher.js';

const CONSUMER_KEY_PATTERN = /^[a-z][a-z0-9_.-]{1,79}$/;

const consumers = new Map();

export function registerEventConsumer(consumerKey, handler) {
  if (
    typeof consumerKey !== 'string' ||
    !CONSUMER_KEY_PATTERN.test(consumerKey)
  ) {
    throw new Error('Invalid event consumer key');
  }

  if (typeof handler !== 'function') {
    throw new Error('Event consumer handler must be a function');
  }

  if (consumers.has(consumerKey)) {
    throw new Error(`Event consumer already registered: ${consumerKey}`);
  }

  consumers.set(consumerKey, handler);

  return consumerKey;
}

export function getEventConsumer(consumerKey) {
  return consumers.get(consumerKey) || null;
}

export function getRegisteredEventConsumers() {
  return [...consumers.keys()];
}

export async function processRegisteredEventDeliveries(
  db,
  { maxPerConsumer = 10 } = {},
) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('A valid D1 database binding is required');
  }

  if (
    !Number.isInteger(maxPerConsumer) ||
    maxPerConsumer < 1 ||
    maxPerConsumer > 100
  ) {
    throw new Error('maxPerConsumer must be between 1 and 100');
  }

  const summary = {
    consumers: consumers.size,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    deadLettered: 0,
  };

  for (const [consumerKey, handler] of consumers) {
    for (let index = 0; index < maxPerConsumer; index++) {
      const result = await dispatchNextEvent(
        db,
        consumerKey,
        handler,
      );

      if (result.reason === 'no_pending_delivery') {
        break;
      }

      summary.attempted++;

      if (result.status === 'succeeded') {
        summary.succeeded++;
      } else {
        summary.failed++;

        if (result.status === 'dead_letter') {
          summary.deadLettered++;
        }
      }
    }
  }

  return summary;
}
