// notifications.js
// Handles fetching, reading, and counting user notifications.
// Notifications themselves are created elsewhere (duel.js, league.js,
// comments.js, index.js cheer handler, etc.) — this file only reads/updates.

export async function notificationEnabled(userId, preference, db) {
  const allowed = [
    'badge_awards', 'tips_received', 'challenge_updates', 'weekly_summary', 'messages', 'crew_updates',
    // Retained as compatibility gates for existing saved preferences.
    'duel_challenges', 'league_promotions',
  ];
  if (!allowed.includes(preference)) return true;
  const row = await db.prepare(`SELECT ${preference} AS enabled FROM notification_preferences WHERE user_id = ?`).bind(userId).first();
  return !row || !!row.enabled;
}

export async function getNotifications(userId, env, limit = 30, offset = 0) {
  const { results } = await env.DB.prepare(`
    SELECT id, type, title, body, action_url, metadata, is_read, created_at, read_at
    FROM notifications
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).bind(userId, limit, offset).all();

  return results;
}

export async function getUnreadCount(userId, env) {
  const result = await env.DB.prepare(`
    SELECT COUNT(*) as count
    FROM notifications
    WHERE user_id = ? AND is_read = 0
  `).bind(userId).first();

  return result.count;
}

export async function markAsRead(notificationId, userId, env) {
  const now = new Date().toISOString();

  const result = await env.DB.prepare(`
    UPDATE notifications
    SET is_read = 1, read_at = ?
    WHERE id = ? AND user_id = ?
  `).bind(now, notificationId, userId).run();

  if (result.meta.changes === 0) {
    throw new Error('Notification not found');
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
