import { createDomainEvent } from './eventContract.js';
import { publishDomainEvent } from './eventPublisher.js';

async function createNotificationEventId({
  recipientUserId,
  type,
  actorType,
  actorId,
  resourceType,
  resourceId,
  requestId,
}) {
  const identity = JSON.stringify([
    recipientUserId,
    type,
    actorType,
    actorId,
    resourceType,
    resourceId,
    requestId,
  ]);

  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(identity),
  );

  const hash = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  return `notification_${hash}`;
}

export async function publishNotification(
  db,
  {
    recipientUserId,
    type,
    title,
    body,
    actionUrl = null,
    preference = null,
    actorType = 'system',
    actorId = null,
    resourceType,
    resourceId,
    requestId = null,
    occurredAt = new Date().toISOString(),
  },
) {
  if (
    typeof recipientUserId !== 'string' ||
    !recipientUserId ||
    typeof resourceType !== 'string' ||
    typeof resourceId !== 'string' ||
    !resourceId
  ) {
    throw new Error('Invalid notification event references');
  }

  const eventId = await createNotificationEventId({
    recipientUserId,
    type,
    actorType,
    actorId,
    resourceType,
    resourceId,
    requestId,
  });

  const event = createDomainEvent({
    eventId,
    eventType: 'notification.requested',
    actorType,
    actorId,
    resourceType,
    resourceId,
    requestId,
    occurredAt,
    payload: {
      recipientUserId,
      type,
      title,
      body,
      actionUrl,
      preference,
    },
  });

  return publishDomainEvent(db, event, ['notifications']);
}
