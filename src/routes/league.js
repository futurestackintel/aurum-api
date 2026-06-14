// ============================================================
// LEAGUE ROUTES
// GET  /api/leagues/me           — current user's league + score
// POST /api/leagues/recalculate  — admin: recalculate all users
// ============================================================

import { assignLeague, recalculateAllLeagues } from '../services/league.js';
import { requireAuth, requireAdmin }           from '../middleware/auth.js';

export async function handleLeagueRoutes(path, method, request, env) {
  const db = env.DB;

  // ── GET /api/leagues/me ─────────────────────────────────
  if (path === '/api/leagues/me' && method === 'GET') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const result = await db
        .prepare(`SELECT aurum_score, league FROM users WHERE id = ?`)
        .bind(user.id)
        .first();

      if (!result) return jsonResponse({ error: 'User not found' }, 404);

      return jsonResponse({
        user_id: user.id,
        league:  result.league,
        score:   result.aurum_score,
      });
    } catch (err) {
      console.error("Get league error:", err);
      return jsonResponse({ error: "Unable to load league. Please try again." }, 500);
    }
  }

  // ── POST /api/leagues/recalculate ───────────────────────
  if (path === '/api/leagues/recalculate' && method === 'POST') {
    const admin = await requireAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, 403);

    try {
      const result = await recalculateAllLeagues(db);
      return jsonResponse({
        message: 'League recalculation complete',
        ...result,
      });
    } catch (err) {
      console.error("Recalculate leagues error:", err);
      return jsonResponse({ error: "Unable to recalculate leagues. Please try again." }, 500);
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