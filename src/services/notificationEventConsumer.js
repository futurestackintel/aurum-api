// ============================================================
// AURUM NOTIFICATION EVENT CONSUMER
// Converts notification.requested events into notifications.
// Preserves preferences and prevents duplicate delivery effects.
// ============================================================

import { notificationEnabled } from './notifications.js';
import { registerEventConsumer } from './eventConsumerRegistry.js';

const CONSUMER_KEY = 'notifications';

const ALLOWED_NOTIFICATION_TYPES = new Set([
  'tip_received',
  'challenge_won',
  'challenge_joined',
  'challenge_ending_soon',
  'duel_received',
  'duel_accepted',
  'duel_result',
  'duel_announced',
  'post_reacted',
  'post_tipped',
  'post_commented',
  'badge_awarded',
  'league_promoted',
  'league_demoted',
  'stake_verified',
  'stake_disputed',
  'stake_forfeited',
  'room_invited',
  'system_alert',
  'crew_promoted',
  'crew_demoted',
  'crew_kicked',
  'crew_mention',
  'dm_received',
  'message_reaction',
  'crew_invite',
  'crew_join_request',
  'new_follower',
  'connection_request',
  'connection_accepted',
	'deposit_completed',
  'withdrawal_completed',
]);

const ALLOWED_PREFERENCES = new Set([
  'badge_awards',
  'tips_received',
  'challenge_updates',
  'weekly_summary',
  'messages',
  'crew_updates',
  'duel_challenges',
  'league_promotions',
]);

async function handleNotificationEvent(event, context) {
  if (event.eventType !== 'notification.requested') {
    throw new Error('UnsupportedNotificationEvent');
  }

  const payload = event.payload;

  const {
    recipientUserId,
    type,
    title,
    body,
    actionUrl = null,
    preference = null,
  } = payload;

  if (
    typeof recipientUserId !== 'string' ||
    recipientUserId.length === 0
  ) {
    throw new Error('InvalidNotificationRecipient');
  }

  if (!ALLOWED_NOTIFICATION_TYPES.has(type)) {
    throw new Error('InvalidNotificationType');
  }

  if (
    typeof title !== 'string' ||
    title.length === 0 ||
    title.length > 160
  ) {
    throw new Error('InvalidNotificationTitle');
  }

  if (
    typeof body !== 'string' ||
    body.length === 0 ||
    body.length > 1000
  ) {
    throw new Error('InvalidNotificationBody');
  }

  if (
    actionUrl !== null &&
    (
      typeof actionUrl !== 'string' ||
      !actionUrl.startsWith('/') ||
      actionUrl.startsWith('//') ||
      actionUrl.length > 500
    )
  ) {
    throw new Error('InvalidNotificationActionUrl');
  }

  if (
    preference !== null &&
    !ALLOWED_PREFERENCES.has(preference)
  ) {
    throw new Error('InvalidNotificationPreference');
  }

  const db = context.db;

  if (!db || typeof db.prepare !== 'function') {
    throw new Error('A valid D1 database binding is required');
  }

  if (
    preference &&
    !(await notificationEnabled(recipientUserId, preference, db))
  ) {
    return { created: false, reason: 'preference_disabled' };
  }

  const result = await db.prepare(`
    INSERT OR IGNORE INTO notifications (
      id,
      user_id,
      type,
      title,
      body,
      action_url,
      source_event_id,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    recipientUserId,
    type,
    title,
    body,
    actionUrl,
    event.eventId,
    event.occurredAt,
  ).run();

  return {
    created: result.meta.changes === 1,
    reason: result.meta.changes === 1
      ? 'created'
      : 'already_exists',
  };
}

registerEventConsumer(CONSUMER_KEY, async (event, delivery) => {
  return handleNotificationEvent(event, {
    ...delivery,
    db: delivery.db,
  });
});

export { handleNotificationEvent };
