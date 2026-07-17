// notifications.js (routes)
// GET   /api/notifications              - list current user's notifications
// GET   /api/notifications/unread-count - unread badge count
// PATCH /api/notifications/:id/read     - mark one as read
// PATCH /api/notifications/read-all     - mark all as read
// All routes require auth, resolved internally (Clerk id -> internal DB id).

import { getNotifications, getUnreadCount, markAsRead, markAllAsRead } from '../services/notifications.js';
import { requireAuth } from '../middleware/auth.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleNotificationRoutes(pathname, method, request, env) {
  if (!pathname.startsWith('/api/notifications')) return null;

  const user = await requireAuth(request, env);
  if (user.error) return jsonResponse({ error: user.error }, 401);

  const dbUser = await env.DB
    .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
    .bind(user.id)
    .first();

  if (!dbUser) return jsonResponse({ error: 'User not found' }, 404);

  const url = new URL(request.url);

  if (pathname === '/api/notifications' && method === 'GET') {
    const limit  = parseInt(url.searchParams.get('limit')  || '30', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const notifications = await getNotifications(dbUser.id, env, limit, offset);
    return jsonResponse({ notifications });
  }

  if (pathname === '/api/notifications/unread-count' && method === 'GET') {
    const count = await getUnreadCount(dbUser.id, env);
    return jsonResponse({ count });
  }

  const readMatch = pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
  if (readMatch && method === 'PATCH') {
    const notificationId = readMatch[1];
    try {
      const result = await markAsRead(notificationId, dbUser.id, env);
      return jsonResponse(result);
    } catch (err) {
      return jsonResponse({ error: err.message }, 404);
    }
  }

  if (pathname === '/api/notifications/read-all' && method === 'PATCH') {
    const result = await markAllAsRead(dbUser.id, env);
    return jsonResponse(result);
  }

  return null;
}
