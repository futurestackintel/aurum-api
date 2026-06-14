// ============================================================
// BADGE ROUTES
// GET  /api/badges/me              — current user's badges
// GET  /api/badges/:userId         — any user's badges (public)
// POST /api/badges/award           — admin: manually award a badge
// ============================================================

import { getUserBadges, adminAwardBadge } from '../services/badge.js';
import { requireAuth, requireAdmin }      from '../middleware/auth.js';

export async function handleBadgeRoutes(path, method, request, env) {
  const db = env.DB;

  // ── GET /api/badges/me ──────────────────────────────────
  if (path === '/api/badges/me' && method === 'GET') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const badges = await getUserBadges(user.id, db);
      return jsonResponse({ badges });
    } catch (err) {
      console.error("Get badges error:", err);
      return jsonResponse({ error: "Unable to load badges. Please try again." }, 500);
    }
  }

  // ── GET /api/badges/:userId ─────────────────────────────
  const publicMatch = path.match(/^\/api\/badges\/([^/]+)$/);
  if (publicMatch && method === 'GET') {
    try {
      const userId = publicMatch[1];
      const badges = await getUserBadges(userId, db);
      return jsonResponse({ badges });
    } catch (err) {
      console.error("Get public badges error:", err);
      return jsonResponse({ error: "Unable to load badges. Please try again." }, 500);
    }
  }

  // ── POST /api/badges/award ──────────────────────────────
  if (path === '/api/badges/award' && method === 'POST') {
    const admin = await requireAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, 403);

    try {
      const body = await request.json();
      const { user_id, badge_type } = body;

      if (!user_id || !badge_type) {
        return jsonResponse({ error: 'user_id and badge_type are required' }, 400);
      }

      const result = await adminAwardBadge(user_id, badge_type, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);

      return jsonResponse({
        message: result.awarded
          ? `Badge ${badge_type} awarded to ${user_id}`
          : result.reason,
        ...result,
      });
    } catch (err) {
      console.error("Award badge error:", err);
      return jsonResponse({ error: "Unable to award badge. Please try again." }, 500);
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