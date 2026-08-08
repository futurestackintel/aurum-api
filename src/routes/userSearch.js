import { requireAuth } from '../middleware/auth.js';

export async function handleUserSearchRoutes(path, method, request, env) {
  const db = env.DB;

  if (path === '/api/users/search' && method === 'GET') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const url = new URL(request.url);
      const q = (url.searchParams.get('q') || '').trim();

      if (q.length < 2) {
        return jsonResponse({ error: 'Search query must be at least 2 characters' }, 400);
      }

      const { results } = await db
        .prepare(`
          SELECT id, username, league, aurum_score, hide_aurum_score, hide_league
          FROM users
          WHERE username LIKE ? || '%'
            AND account_deleted = 0
            AND profile_visibility != 'private'
            AND stealth_mode = 0
          ORDER BY username ASC
          LIMIT 20
        `)
        .bind(q)
        .all();

      const sanitized = results.map(u => ({
        id: u.id,
        username: u.username,
        league: u.hide_league ? null : u.league,
        aurum_score: u.hide_aurum_score ? null : u.aurum_score,
      }));

      return jsonResponse({ results: sanitized });
    } catch (err) {
      console.error('User search error:', err);
      return jsonResponse({ error: 'Unable to search. Please try again.' }, 500);
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
