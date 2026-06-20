// ============================================================
// PROOF OF STAKE ROUTES
// POST /api/posts              — create post with stake
// GET  /api/posts              — get ledger feed
// POST /api/posts/:id/flag     — flag a post as fake
// POST /api/posts/:id/resolve  — admin: resolve verdict
// POST /api/posts/:id/appeal   — user: submit appeal
// POST /api/posts/:id/appeal/resolve — admin: resolve appeal
// GET  /api/posts/:id/flags    — admin: view flags on a post
// ============================================================

import {
  createPost,
  flagPost,
  resolvePost,
  getLedgerPosts,
  appealPost,
  resolveAppeal,
} from '../services/proofOfStake.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { streakMiddleware }          from '../services/streak.js';

export async function handlePostRoutes(path, method, request, env) {
  const db = env.DB;

  // ── POST /api/posts — create post with stake ────────────
  if (path === '/api/posts' && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      // Fix 5 — await streakMiddleware
      await streakMiddleware(user.id, db);

      const body   = await request.json();
      const result = await createPost(user.id, body, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result, 201);
    } catch (err) {
      console.error('Create post error:', err);
      return jsonResponse({ error: 'Unable to create post. Please try again.' }, 500);
    }
  }

  // ── GET /api/posts — ledger feed ────────────────────────
  if (path === '/api/posts' && method === 'GET') {
    try {
      const url    = new URL(request.url);
      const limit  = parseInt(url.searchParams.get('limit')  ?? '20');
      const offset = parseInt(url.searchParams.get('offset') ?? '0');
      const posts  = await getLedgerPosts(limit, offset, db);
      return jsonResponse({ posts });
    } catch (err) {
      console.error('Get posts error:', err);
      return jsonResponse({ error: 'Unable to load posts. Please try again.' }, 500);
    }
  }

  // ── POST /api/posts/:id/flag ────────────────────────────
  const flagMatch = path.match(/^\/api\/posts\/([^/]+)\/flag$/);
  if (flagMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const postId = flagMatch[1];
      const body   = await request.json().catch(() => ({}));
      const result = await flagPost(postId, user.id, body.reason, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Flag post error:', err);
      return jsonResponse({ error: 'Unable to flag post. Please try again.' }, 500);
    }
  }

  // ── POST /api/posts/:id/resolve — admin verdict ─────────
  const resolveMatch = path.match(/^\/api\/posts\/([^/]+)\/resolve$/);
  if (resolveMatch && method === 'POST') {
    const admin = await requireAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, 403);

    try {
      const postId = resolveMatch[1];
      const body   = await request.json();
      if (!body.verdict) return jsonResponse({ error: 'verdict is required' }, 400);
      const result = await resolvePost(postId, body.verdict, admin.id, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Resolve post error:', err);
      return jsonResponse({ error: 'Unable to resolve post. Please try again.' }, 500);
    }
  }

  // ── POST /api/posts/:id/appeal — user submits appeal ────
  const appealMatch = path.match(/^\/api\/posts\/([^/]+)\/appeal$/);
  if (appealMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const postId = appealMatch[1];
      const body   = await request.json().catch(() => ({}));
      const result = await appealPost(postId, user.id, body.appeal_reason, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Appeal post error:', err);
      return jsonResponse({ error: 'Unable to submit appeal. Please try again.' }, 500);
    }
  }

  // ── POST /api/posts/:id/appeal/resolve — admin resolves appeal ──
  const appealResolveMatch = path.match(/^\/api\/posts\/([^/]+)\/appeal\/resolve$/);
  if (appealResolveMatch && method === 'POST') {
    const admin = await requireAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, 403);

    try {
      const postId = appealResolveMatch[1];
      const body   = await request.json();
      if (!body.decision) return jsonResponse({ error: 'decision is required' }, 400);
      const result = await resolveAppeal(postId, body.decision, admin.id, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Resolve appeal error:', err);
      return jsonResponse({ error: 'Unable to resolve appeal. Please try again.' }, 500);
    }
  }

  // ── GET /api/posts/:id/flags — admin: view flags ────────
  const flagsMatch = path.match(/^\/api\/posts\/([^/]+)\/flags$/);
  if (flagsMatch && method === 'GET') {
    const admin = await requireAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, 403);

    try {
      const postId = flagsMatch[1];
      const { results } = await db
        .prepare(`
          SELECT f.id, f.reason, f.created_at, u.username
          FROM post_flags f
          JOIN users u ON u.id = f.flagged_by
          WHERE f.post_id = ?
          ORDER BY f.created_at ASC
        `)
        .bind(postId)
        .all();
      return jsonResponse({ post_id: postId, flags: results });
    } catch (err) {
      console.error('Get flags error:', err);
      return jsonResponse({ error: 'Unable to load flags. Please try again.' }, 500);
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
