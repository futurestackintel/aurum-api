// notifications.js (routes)
// GET  /api/notifications           - list current user's notifications
// GET  /api/notifications/unread-count - unread badge count
// PATCH /api/notifications/:id/read - mark one as read
// PATCH /api/notifications/read-all - mark all as read
// All routes require auth.

import { getNotifications, getUnreadCount, markAsRead, markAllAsRead } from '../services/notifications.js';

export async function handleNotificationRoutes(request, env, pathname, userId) {
  const url = new URL(request.url);

  if (pathname === '/api/notifications' && request.method === 'GET') {
    const limit = parseInt(url.searchParams.get('limit') || '30', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const notifications = await getNotifications(userId, env, limit, offset);
    return new Response(JSON.stringify({ notifications }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (pathname === '/api/notifications/unread-count' && request.method === 'GET') {
    const count = await getUnreadCount(userId, env);
    return new Response(JSON.stringify({ count }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const readMatch = pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
  if (readMatch && request.method === 'PATCH') {
    const notificationId = readMatch[1];
    try {
      const result = await markAsRead(notificationId, userId, env);
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  if (pathname === '/api/notifications/read-all' && request.method === 'PATCH') {
    const result = await markAllAsRead(userId, env);
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return null; // not a notifications route
}
