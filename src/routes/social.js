import { requireAuth, optionalAuth } from '../middleware/auth.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
});

async function viewerFor(request, env, required = false) {
  const session = required ? await requireAuth(request, env) : await optionalAuth(request, env);
  if (session.error) return { error: json({ error: session.error }, 401) };
  if (!session.id) return { id: null };
  const row = await env.DB.prepare(`SELECT id, username, is_suspended FROM users
    WHERE clerk_id = ? AND account_deleted = 0 AND deleted_at IS NULL`).bind(session.id).first();
  if (!row || row.is_suspended) {
    return required
      ? { error: json({ error: 'User not found or unavailable' }, 403) }
      : { id: null };
  }
  return { id: row.id, username: row.username };
}

async function visibleProfile(db, username, viewerId) {
  const row = await db.prepare(`SELECT id, profile_visibility, stealth_mode, is_suspended
    FROM users WHERE username = ? AND account_deleted = 0 AND deleted_at IS NULL`)
    .bind(username).first();
  if (!row || row.is_suspended || (row.stealth_mode && row.id !== viewerId)) return null;
  const visibility = row.profile_visibility || 'members';
  if (visibility === 'private' && row.id !== viewerId) return null;
  if (visibility === 'members' && !viewerId) return null;
  return row;
}

export async function handleSocialRoutes(path, method, request, env) {
  const db = env.DB;
  const followAction = path.match(/^\/api\/users\/([^/]+)\/(follow|unfollow)$/);
  if (followAction && method === 'POST') {
    const viewer = await viewerFor(request, env, true);
    if (viewer.error) return viewer.error;
    const [, username, action] = followAction;
    const target = await visibleProfile(db, decodeURIComponent(username), viewer.id);
    if (!target) return json({ error: 'User not found' }, 404);
    if (target.id === viewer.id) return json({ error: 'You cannot follow yourself' }, 400);
    if (action === 'unfollow') {
      await db.prepare('DELETE FROM user_follows WHERE follower_id = ? AND followed_id = ?')
        .bind(viewer.id, target.id).run();
    } else {
      const inserted = await db.prepare(`INSERT OR IGNORE INTO user_follows (follower_id, followed_id)
        SELECT ?, id FROM users WHERE id = ? AND account_deleted = 0 AND deleted_at IS NULL AND is_suspended = 0`)
        .bind(viewer.id, target.id).run();
      if (inserted.meta.changes) {
        await db.prepare(`INSERT INTO notifications (id, user_id, type, title, body, action_url)
          VALUES (?, ?, 'new_follower', 'New follower', ?, ?)`)
          .bind(crypto.randomUUID(), target.id, `@${viewer.username} started following you.`, `/app.html?profile=${encodeURIComponent(viewer.username)}`).run();
      }
    }
    const row = await db.prepare(`SELECT EXISTS(SELECT 1 FROM user_follows WHERE follower_id = ? AND followed_id = ?) AS following,
      (SELECT COUNT(*) FROM user_follows WHERE followed_id = ?) AS followers_count,
      (SELECT COUNT(*) FROM user_follows WHERE follower_id = ?) AS following_count`)
      .bind(viewer.id, target.id, target.id, target.id).first();
    return json({ following: !!row.following, followers_count: row.followers_count, following_count: row.following_count });
  }

  const relation = path.match(/^\/api\/profiles\/([^/]+)\/relationship$/);
  if (relation && method === 'GET') {
    const viewer = await viewerFor(request, env);
    const target = await visibleProfile(db, decodeURIComponent(relation[1]), viewer.id);
    if (!target) return json({ error: 'Profile not found' }, 404);
    const row = await db.prepare(`SELECT
      CASE WHEN ? IS NULL THEN 0 ELSE EXISTS(SELECT 1 FROM user_follows WHERE follower_id = ? AND followed_id = ?) END AS following,
      (SELECT COUNT(*) FROM user_follows WHERE followed_id = ?) AS followers_count,
      (SELECT COUNT(*) FROM user_follows WHERE follower_id = ?) AS following_count`)
      .bind(viewer.id, viewer.id, target.id, target.id, target.id).first();
    return json({ following: !!row.following, is_self: target.id === viewer.id, followers_count: row.followers_count, following_count: row.following_count });
  }

  const list = path.match(/^\/api\/profiles\/([^/]+)\/(followers|following)$/);
  if (list && method === 'GET') {
    const viewer = await viewerFor(request, env);
    const username = decodeURIComponent(list[1]);
    const target = await visibleProfile(db, username, viewer.id);
    if (!target) return json({ error: 'Profile not found' }, 404);
    const url = new URL(request.url);
    const limit = Math.max(1, Math.min(50, Number.parseInt(url.searchParams.get('limit') || '20', 10) || 20));
    const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0);
    const query = list[2] === 'followers'
      ? `SELECT u.username, u.display_name, u.avatar_url, u.league, u.is_verified FROM user_follows f JOIN users u ON u.id = f.follower_id WHERE f.followed_id = ?`
      : `SELECT u.username, u.display_name, u.avatar_url, u.league, u.is_verified FROM user_follows f JOIN users u ON u.id = f.followed_id WHERE f.follower_id = ?`;
    const { results } = await db.prepare(`${query} AND u.account_deleted = 0 AND u.deleted_at IS NULL AND u.is_suspended = 0 AND u.stealth_mode = 0 AND (COALESCE(u.profile_visibility, 'members') = 'public' OR ? IS NOT NULL) ORDER BY f.created_at DESC LIMIT ? OFFSET ?`)
      .bind(target.id, viewer.id, limit, offset).all();
    return json({ users: results });
  }
  return null;
}
