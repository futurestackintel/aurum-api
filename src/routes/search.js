import { requireAuth } from '../middleware/auth.js';

export async function handleSearchRoutes(path, method, request, env) {
  const db = env.DB;
  if (path === '/api/search' && method === 'GET') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);
    try {
      const url = new URL(request.url);
      const q = (url.searchParams.get('q') || '').trim();
      if (q.length < 2) {
        return jsonResponse({ error: 'Search query must be at least 2 characters' }, 400);
      }

      const [usersResult, crewsResult, postsResult] = await Promise.all([
        db.prepare(`
          SELECT id, username, league, aurum_score, hide_aurum_score, hide_league, avatar_url
          FROM users
          WHERE username LIKE ? || '%'
            AND account_deleted = 0
            AND profile_visibility != 'private'
            AND stealth_mode = 0
            AND is_suspended = 0
            AND deleted_at IS NULL
          ORDER BY username ASC
          LIMIT 10
        `).bind(q).all(),
        db.prepare(`
          SELECT id, name, description, member_count
          FROM crews
          WHERE name LIKE ? || '%'
            AND is_locked = 0
            AND is_frozen = 0
          ORDER BY name ASC
          LIMIT 10
        `).bind(q).all(),
        db.prepare(`
          SELECT p.id, p.content, p.created_at, p.user_id, u.username, u.stealth_mode
          FROM posts p
          JOIN users u ON u.id = p.user_id
          WHERE p.content LIKE '%' || ? || '%'
            AND p.visibility = 'public'
            AND p.moderation_status = 'active'
            AND p.deleted_at IS NULL
            AND u.account_deleted = 0
          ORDER BY p.created_at DESC
          LIMIT 10
        `).bind(q).all(),
      ]);

      const users = usersResult.results.map(u => ({
        id: u.id,
        username: u.username,
        league: u.hide_league ? null : u.league,
        aurum_score: u.hide_aurum_score ? null : u.aurum_score,
        avatar_url: u.avatar_url,
      }));

      const crews = crewsResult.results.map(c => ({
        id: c.id,
        name: c.name,
        description: c.description,
        member_count: c.member_count,
      }));

      const posts = postsResult.results.map(p => ({
        id: p.id,
        content: p.content,
        created_at: p.created_at,
        author_username: p.stealth_mode ? 'Anonymous' : p.username,
      }));

      return jsonResponse({ users, crews, posts });
    } catch (err) {
      console.error('Universal search error:', err);
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
