
import { createDomainEvent } from './eventContract.js';
import { publishDomainEvent } from './eventPublisher.js';

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

  const event = createDomainEvent({
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
