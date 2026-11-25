// Authenticated notification routes.

import {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  getNotificationPreferences,
  getNotificationCategories,
} from '../services/notifications.js';

import { requireAuth } from '../middleware/auth.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function validInteger(value, fallback, min, max) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return null;

  const number = Number(value);

  if (!Number.isSafeInteger(number) || number < min || number > max) {
    return null;
  }

  return number;
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
    const limit = validInteger(url.searchParams.get('limit'), 30, 1, 50);
    const offset = validInteger(url.searchParams.get('offset'), 0, 0, 1000000);
    const status = url.searchParams.get('status') || 'all';
    const type = url.searchParams.get('type') || null;

    if (limit === null || offset === null) {
      return jsonResponse({ error: 'Invalid pagination parameters' }, 400);
    }

    if (!['all', 'read', 'unread'].includes(status)) {
      return jsonResponse({ error: 'Invalid notification status filter' }, 400);
    }

    if (
      type !== null &&
      !/^[a-z][a-z0-9_]{0,49}$/.test(type)
    ) {
      return jsonResponse({ error: 'Invalid notification type' }, 400);
    }

    const notifications = await getNotifications(
      dbUser.id,
      env,
      { limit, offset, status, type },
    );

    return jsonResponse({
      notifications,
      pagination: { limit, offset },
      filters: { status, type },
    });
  }

  if (pathname === '/api/notifications/unread-count' && method === 'GET') {
    const type = url.searchParams.get('type') || null;

    if (
      type !== null &&
      !/^[a-z][a-z0-9_]{0,49}$/.test(type)
    ) {
      return jsonResponse({ error: 'Invalid notification type' }, 400);
    }

    const count = await getUnreadCount(dbUser.id, env, type);
    return jsonResponse({ count });
  }

  if (pathname === '/api/notifications/preferences' && method === 'GET') {
    const preferences = await getNotificationPreferences(dbUser.id, env);
    return jsonResponse({ preferences });
  }

	  if (pathname === '/api/notifications/categories' && method === 'GET') {
    const categories = await getNotificationCategories(dbUser.id, env);
    return jsonResponse({ categories });
  }

  const readMatch = pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);

  if (readMatch && method === 'PATCH') {
    try {
      const result = await markAsRead(readMatch[1], dbUser.id, env);
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
