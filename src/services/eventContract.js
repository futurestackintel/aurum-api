// ============================================================
// AURUM DOMAIN EVENT CONTRACT
// Defines the standard structure shared by all event producers
// and consumers. This module does not persist or dispatch events.
// ============================================================

export const EVENT_SCHEMA_VERSION = 1;

export const EVENT_ACTOR_TYPES = Object.freeze([
  'member',
  'platform_admin',
  'system',
]);

const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const RESOURCE_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;
const MAX_PAYLOAD_BYTES = 8192;

const BLOCKED_PAYLOAD_KEYS =
  /token|password|secret|credential|private_key|card_number|cvv|evidence_url|proof_url/i;

function validatePayload(value, path = 'payload') {
  if (value === null || typeof value !== 'object') {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      return;
    }

    throw new Error(`Invalid event payload value at ${path}`);
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      validatePayload(value[index], `${path}[${index}]`);
    }
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    if (BLOCKED_PAYLOAD_KEYS.test(key)) {
      throw new Error(`Sensitive event payload key is not allowed: ${key}`);
    }

    validatePayload(item, `${path}.${key}`);
  }
}

export function createDomainEvent({
  eventType,
  actorType = 'system',
  actorId = null,
  resourceType,
  resourceId,
  payload = {},
  requestId = null,
  occurredAt = new Date().toISOString(),
	eventId = crypto.randomUUID(),
}) {
 if (
    typeof eventId !== 'string' ||
    eventId.length === 0 ||
    eventId.length > 128
  ) {
    throw new Error('A valid event ID is required');
  }
  if (
    typeof eventType !== 'string' ||
    !EVENT_TYPE_PATTERN.test(eventType)
  ) {
    throw new Error('A valid namespaced event type is required');
  }

  if (!EVENT_ACTOR_TYPES.includes(actorType)) {
    throw new Error('Invalid event actor type');
  }

  if (
    typeof resourceType !== 'string' ||
    !RESOURCE_TYPE_PATTERN.test(resourceType)
  ) {
    throw new Error('A valid resource type is required');
  }

  if (
    typeof resourceId !== 'string' ||
    resourceId.length === 0
  ) {
    throw new Error('A valid resource ID is required');
  }

  if (
    actorId !== null &&
    (typeof actorId !== 'string' || actorId.length === 0)
  ) {
    throw new Error('Actor ID must be a non-empty string or null');
  }

  if (
    requestId !== null &&
    typeof requestId !== 'string'
  ) {
    throw new Error('Request ID must be a string or null');
  }

  if (
    typeof occurredAt !== 'string' ||
    Number.isNaN(Date.parse(occurredAt))
  ) {
    throw new Error('A valid event timestamp is required');
  }

  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    throw new Error('Event payload must be an object');
  }

  validatePayload(payload);

  const serializedPayload = JSON.stringify(payload);

  if (
    new TextEncoder().encode(serializedPayload).length >
    MAX_PAYLOAD_BYTES
  ) {
    throw new Error('Event payload exceeds the maximum allowed size');
  }

  return Object.freeze({
    eventId: crypto.randomUUID(),
    eventType,
    schemaVersion: EVENT_SCHEMA_VERSION,
    occurredAt: new Date(occurredAt).toISOString(),
    actor: Object.freeze({
      type: actorType,
      id: actorId,
    }),
    resource: Object.freeze({
      type: resourceType,
      id: resourceId,
    }),
    requestId,
    payload: Object.freeze({ ...payload }),
  });
}
