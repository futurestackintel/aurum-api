import { requireAuth } from '../middleware/auth.js';
import { jsonResponse } from '../http.js';

export async function handleSearchRoutes(path, method, request, env) {
  const db = env.DB;
  if (path === '/api/search' && method === 'GET') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);
    try {
      const viewer = await db.prepare(`SELECT id, is_suspended FROM users
        WHERE clerk_id = ? AND account_deleted = 0 AND deleted_at IS NULL`).bind(user.id).first();
      if (!viewer || viewer.is_suspended) return jsonResponse({ error: 'User not found or unavailable' }, 403);
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
          SELECT p.id, p.content, p.created_at, p.user_id, u.username
          FROM posts p
          JOIN users u ON u.id = p.user_id
          WHERE p.content LIKE '%' || ? || '%'
            AND p.visibility = 'public'
            AND p.moderation_status = 'active'
            AND p.deleted_at IS NULL
            AND u.account_deleted = 0
            AND u.is_suspended = 0
            AND u.deleted_at IS NULL
          ORDER BY p.created_at DESC
          LIMIT 10
        `).bind(q).all(),
				db.prepare(`
  SELECT
    id, title, description, challenge_type, status,
    starts_at, ends_at, entry_fee_minor, currency_code,
    participant_count, max_participants
  FROM challenges
  WHERE (title LIKE '%' || ? || '%'
      OR description LIKE '%' || ? || '%')
    AND moderation_status = 'approved'
    AND deleted_at IS NULL
    AND status IN ('open', 'active', 'completed')
  ORDER BY
    CASE WHEN status = 'open' THEN 0
         WHEN status = 'active' THEN 1
         ELSE 2 END,
    created_at DESC
  LIMIT 10
`).bind(q, q).all(),
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
        author_username: p.username,
      }));

			const challenges = challengesResult.results.map(c => ({
  id: c.id,
  title: c.title,
  description: c.description,
  challenge_type: c.challenge_type,
  status: c.status,
  starts_at: c.starts_at,
  ends_at: c.ends_at,
  entry_fee_minor: c.entry_fee_minor,
  currency_code: c.currency_code,
  participant_count: c.participant_count,
  max_participants: c.max_participants,
}));

      return jsonResponse({ users, crews, posts, challenges });
    } catch (err) {
      console.error('Universal search error:', err);
      return jsonResponse({ error: 'Unable to search. Please try again.' }, 500);
    }
  }
  return null;
}
