import { requireAuth } from '../middleware/auth.js';

const ALLOWED_FIELDS = ['avatar_url', 'bio'];

export async function handleProfileRoutes(path, method, request, env) {
  const db = env.DB;
  if (path === '/api/users/me' && method === 'PATCH') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);
    try {
      const userRow = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(user.id).first();
      if (!userRow) return jsonResponse({ error: 'User not found' }, 404);
      const userId = userRow.id;

      const body = await request.json();
      const updates = [];
      const values = [];
      for (const field of ALLOWED_FIELDS) {
        if (body[field] !== undefined) {
          updates.push(`${field} = ?`);
          values.push(body[field]);
        }
      }
      if (updates.length === 0) {
        return jsonResponse({ error: 'No valid fields to update' }, 400);
      }
      updates.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`);
      values.push(userId);

      await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
      return jsonResponse({ success: true });
    } catch (err) {
      console.error('Profile update error:', err);
      return jsonResponse({ error: 'Unable to update profile. Please try again.' }, 500);
    }
  }
  return null;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
