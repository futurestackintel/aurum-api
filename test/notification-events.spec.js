import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { publishNotification } from '../src/services/notificationPublisher.js';
import { handleNotificationEvent } from '../src/services/notificationEventConsumer.js';

async function createTestUser() {
  const id = crypto.randomUUID();

  await env.DB.prepare(`
    INSERT INTO users (
      id, clerk_id, username, display_name, email
    )
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    id,
    `clerk-${id}`,
    `test-${id}`,
    'Notification Test',
    `${id}@example.test`,
  ).run();

  return id;
}

describe('notification event pipeline', () => {
  it('publishes repeated notification requests as one event and one notification', async () => {
    const userId = await createTestUser();
		const testUser = await env.DB.prepare(
  'SELECT id FROM users WHERE id = ?'
).bind(userId).first();

console.log('NOTIFICATION TEST USER:', userId, testUser);

    const notification = {
      recipientUserId: userId,
      type: 'system_alert',
      title: 'Test notification',
      body: 'Notification pipeline integration test.',
      actionUrl: '/profile',
      actorType: 'system',
      resourceType: 'test_resource',
      resourceId: `resource-${userId}`,
      requestId: `request-${userId}`,
    };

    const first = await publishNotification(env.DB, notification);
    const second = await publishNotification(env.DB, notification);

    expect(second.eventId).toBe(first.eventId);

    const eventCount = await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM domain_events
      WHERE event_id = ?
    `).bind(first.eventId).first();

    const deliveryCount = await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM domain_event_deliveries
      WHERE event_id = ?
        AND consumer_key = 'notifications'
    `).bind(first.eventId).first();

    expect(eventCount.count).toBe(1);
    expect(deliveryCount.count).toBe(1);

    const eventRow = await env.DB.prepare(`
      SELECT *
      FROM domain_events
      WHERE event_id = ?
    `).bind(first.eventId).first();

    const event = {
      eventId: eventRow.event_id,
      eventType: eventRow.event_type,
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

    await handleNotificationEvent(event, { db: env.DB });
    await handleNotificationEvent(event, { db: env.DB });

    const notificationCount = await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM notifications
      WHERE user_id = ?
        AND source_event_id = ?
    `).bind(userId, first.eventId).first();

    expect(notificationCount.count).toBe(1);
  });

  it('accepts completed deposit and withdrawal notification types', async () => {
    const userId = await createTestUser();

    for (const type of ['deposit_completed', 'withdrawal_completed']) {
      const event = {
        eventId: crypto.randomUUID(),
        eventType: 'notification.requested',
        occurredAt: new Date().toISOString(),
        actor: { type: 'system', id: null },
        resource: {
          type: 'payment_operation',
          id: `${type}-${userId}`,
        },
        requestId: `${type}-${userId}`,
        payload: {
          recipientUserId: userId,
          type,
          title: 'Wallet operation completed',
          body: 'Your wallet operation has completed.',
          actionUrl: '/wallet/transactions',
          preference: null,
        },
      };

      const result = await handleNotificationEvent(event, { db: env.DB });

      expect(result.created).toBe(true);
    }

    const rows = await env.DB.prepare(`
      SELECT type
      FROM notifications
      WHERE user_id = ?
      ORDER BY type
    `).bind(userId).all();

    expect(rows.results.map((row) => row.type)).toEqual([
      'deposit_completed',
      'withdrawal_completed',
    ]);
  });

  it('rejects external notification action URLs', async () => {
    const event = {
      eventId: crypto.randomUUID(),
      eventType: 'notification.requested',
      occurredAt: new Date().toISOString(),
      actor: { type: 'system', id: null },
      resource: { type: 'test_resource', id: 'external-url-test' },
      requestId: null,
      payload: {
        recipientUserId: 'test-user',
        type: 'system_alert',
        title: 'Invalid URL test',
        body: 'This notification must be rejected.',
        actionUrl: 'https://example.com',
        preference: null,
      },
    };

    await expect(
      handleNotificationEvent(event, { db: env.DB }),
    ).rejects.toThrow('InvalidNotificationActionUrl');
  });
});
