// ============================================================
// COMMENTS ROUTES
// GET    /api/posts/:id/comments      — get threaded comments (public, no auth)
// POST   /api/posts/:id/comments      — create a comment or reply (auth required)
// DELETE /api/comments/:id            — delete own comment (auth required)
// ============================================================

import {
  createComment,
  getCommentsForPost,
  deleteComment,
} from '../services/comments.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';

export async function handleCommentRoutes(path, method, request, env) {
  const db = env.DB;

  // ── GET /api/posts/:id/comments ─────────────────────────
  const getMatch = path.match(/^\/api\/posts\/([^/]+)\/comments$/);
  if (getMatch && method === 'GET') {
    try {
      const session = await optionalAuth(request, env);
      const viewer = session.id ? await db.prepare(`SELECT id, league FROM users WHERE clerk_id = ? AND account_deleted = 0 AND deleted_at IS NULL AND is_suspended = 0`).bind(session.id).first() : null;
      const result = await getCommentsForPost(getMatch[1], db, viewer);
      if (result.error) return jsonResponse({ error: result.error }, 404);
      return jsonResponse(result);
    } catch (err) {
      console.error('Get comments error:', err);
      return jsonResponse({ error: 'Unable to load comments. Please try again.' }, 500);
    }
  }

  // ── POST /api/posts/:id/comments ────────────────────────
  const postMatch = path.match(/^\/api\/posts\/([^/]+)\/comments$/);
  if (postMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const body   = await request.json();
      const result = await createComment(postMatch[1], user.id, body, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result, 201);
    } catch (err) {
      console.error('Create comment error:', err);
      return jsonResponse({ error: 'Unable to post comment. Please try again.' }, 500);
    }
  }

  // ── DELETE /api/comments/:id ────────────────────────────
  const deleteMatch = path.match(/^\/api\/comments\/([^/]+)$/);
  if (deleteMatch && method === 'DELETE') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const result = await deleteComment(deleteMatch[1], user.id, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Delete comment error:', err);
      return jsonResponse({ error: 'Unable to delete comment. Please try again.' }, 500);
    }
  }

  return null;
}

// ── Helper ──────────────────────────────────────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

