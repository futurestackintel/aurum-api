// Notifications service: listing, filtering, preferences and read states.

export const NOTIFICATION_PREFERENCES = [
  'tips_received',
  'challenge_updates',
  'messages',
  'crew_updates',
  'duel_challenges',
  'league_promotions',
  'badge_awards',
  'weekly_summary',
];

export const NOTIFICATION_CATEGORIES = [
  {
    id: 'social',
    label: 'Social',
    description: 'Reactions, comments, follows and connections',
    preference: null,
  },
    {
    id: 'challenges',
    label: 'Challenges',
    description: 'Challenge entries, results and activity',
    preference: 'challenge_updates',
  },
  {
    id: 'duels',
    label: 'Duels',
    description: 'Duel invitations, announcements and results',
    preference: 'duel_challenges',
  },
  {
    id: 'badges',
    label: 'Badge Awards',
    description: 'Verified achievement awards',
    preference: 'badge_awards',
  },
  {
    id: 'leagues',
    label: 'League Updates',
    description: 'League promotions and demotions',
    preference: 'league_promotions',
  },
  {
    id: 'messages',
    label: 'Messages',
    description: 'Direct messages and message reactions',
    preference: 'messages',
  },
  {
    id: 'crews',
    label: 'Crews',
    description: 'Crew invitations, requests and activity',
    preference: 'crew_updates',
  },
  {
    id: 'wallet',
    label: 'Wallet',
    description: 'Completed deposits and withdrawals',
    preference: null,
  },
  {
    id: 'tips',
    label: 'Tips',
    description: 'Tips received from other members',
    preference: 'tips_received',
  },
    {
    id: 'challenges',
    label: 'Challenges',
    description: 'Challenge entries, results and activity',
    preference: 'challenge_updates',
  },
  {
    id: 'duels',
    label: 'Duels',
    description: 'Duel invitations, announcements and results',
    preference: 'duel_challenges',
  },
  {
    id: 'badges',
    label: 'Badge Awards',
    description: 'Verified achievement awards',
    preference: 'badge_awards',
  },
  {
    id: 'leagues',
    label: 'League Updates',
    description: 'League promotions and demotions',
    preference: 'league_promotions',
  },
  {
    id: 'system',
    label: 'Security & System',
    description: 'Security, account and platform notices',
    preference: null,
  },
];

const NOTIFICATION_TYPE_CATEGORIES = {
  post_reacted: 'social',
  post_tipped: 'social',
  post_commented: 'social',
  new_follower: 'social',
  connection_request: 'social',
  connection_accepted: 'social',

  challenge_won: 'challenges',
  challenge_joined: 'challenges',
  challenge_ending_soon: 'challenges',
  duel_received: 'duels',
  duel_accepted: 'duels',
  duel_result: 'duels',
  duel_announced: 'duels',

  dm_received: 'messages',
  message_reaction: 'messages',

  crew_promoted: 'crews',
  crew_demoted: 'crews',
  crew_kicked: 'crews',
  crew_mention: 'crews',
  crew_invite: 'crews',
  crew_join_request: 'crews',
  room_invited: 'crews',

  deposit_completed: 'wallet',
  withdrawal_completed: 'wallet',

  tip_received: 'tips',

  badge_awarded: 'badges',
  league_promoted: 'leagues',
  league_demoted: 'leagues',

  stake_verified: 'system',
  stake_disputed: 'system',
  stake_forfeited: 'system',
  system_alert: 'system',
};

export async function getNotificationCategories(userId, env) {
  const preferences = await getNotificationPreferences(userId, env);

  return NOTIFICATION_CATEGORIES.map((category) => ({
    ...category,
    enabled: category.preference
      ? !!preferences[category.preference]
      : true,
  }));
}

export async function notificationEnabled(userId, preference, db) {
  if (!NOTIFICATION_PREFERENCES.includes(preference)) return true;

  const row = await db
    .prepare(`SELECT ${preference} AS enabled FROM notification_preferences WHERE user_id = ?`)
    .bind(userId)
    .first();

  return !row || !!row.enabled;
}

export async function getNotificationPreferences(userId, env) {
  const row = await env.DB
    .prepare(`
      SELECT tips_received, challenge_updates, messages, crew_updates,
             duel_challenges, league_promotions, badge_awards, weekly_summary
      FROM notification_preferences
      WHERE user_id = ?
    `)
    .bind(userId)
    .first();

  if (row) return row;

  return Object.fromEntries(
    NOTIFICATION_PREFERENCES.map((key) => [key, 1]),
  );
}

export async function getNotifications(
  userId,
  env,
  { limit = 30, offset = 0, status = 'all', type = null } = {},
) {
  let query = `
    SELECT id, type, title, body, action_url, metadata,
           is_read, created_at, read_at
    FROM notifications
    WHERE user_id = ?
  `;

  const bindings = [userId];

  if (status === 'unread') {
    query += ` AND is_read = 0`;
  } else if (status === 'read') {
    query += ` AND is_read = 1`;
  }

  if (type) {
    query += ` AND type = ?`;
    bindings.push(type);
  }

  query += ` ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
  bindings.push(limit, offset);

  const { results } = await env.DB
    .prepare(query)
    .bind(...bindings)
    .all();

    return results.map((notification) => ({
    ...notification,
    category: NOTIFICATION_TYPE_CATEGORIES[notification.type] || 'system',
  }));
	
export async function getUnreadCount(userId, env, type = null) {
  let query = `
    SELECT COUNT(*) AS count
    FROM notifications
    WHERE user_id = ? AND is_read = 0
  `;

  const bindings = [userId];

  if (type) {
    query += ` AND type = ?`;
    bindings.push(type);
  }

  const result = await env.DB
    .prepare(query)
    .bind(...bindings)
    .first();

  return result?.count || 0;
}

export async function markAsRead(notificationId, userId, env) {
  const now = new Date().toISOString();

  const result = await env.DB.prepare(`
    UPDATE notifications
    SET is_read = 1, read_at = ?
    WHERE id = ? AND user_id = ? AND is_read = 0
  `).bind(now, notificationId, userId).run();

  if (result.meta.changes === 0) {
    const existing = await env.DB
      .prepare(`SELECT id FROM notifications WHERE id = ? AND user_id = ?`)
      .bind(notificationId, userId)
      .first();

    if (!existing) throw new Error('Notification not found');
  }

  return { success: true };
}

export async function markAllAsRead(userId, env) {
  const now = new Date().toISOString();

  await env.DB.prepare(`
    UPDATE notifications
    SET is_read = 1, read_at = ?
    WHERE user_id = ? AND is_read = 0
  `).bind(now, userId).run();

  return { success: true };
}
