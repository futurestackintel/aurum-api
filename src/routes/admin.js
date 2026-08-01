// ============================================================
// ADMIN ROUTES — Chat 6
// All routes require admin Clerk ID in env.ADMIN_USER_IDS
//
// Badge requests:
//   GET  /api/admin/badge-requests           — pending queue
//   GET  /api/admin/badge-requests/:id       — single request detail
//   POST /api/admin/badge-requests/:id/approve
//   POST /api/admin/badge-requests/:id/reject
//
// Disputes (Proof of Stake):
//   GET  /api/admin/disputes                 — dispute queue
//   GET  /api/admin/disputes/:postId         — single dispute detail
//   POST /api/admin/disputes/:postId/verify
//   POST /api/admin/disputes/:postId/slash
//
// Moderation queue:
//   GET  /api/admin/flags                    — pending flags
//   POST /api/admin/flags/:id/resolve        — action or dismiss
//
// User report (authenticated users):
//   POST /api/report                         — submit a flag
//
// Badge requests (authenticated users):
//   POST /api/badge-requests                 — submit a badge request
//
// Analytics:
//   GET  /api/admin/analytics/summary
//   GET  /api/admin/analytics/dau
//   GET  /api/admin/analytics/dau/trend
//   GET  /api/admin/analytics/treasury
//   GET  /api/admin/analytics/revenue
//   GET  /api/admin/analytics/top-performers
//
// User management:
//   POST /api/admin/users/:userId/ban
//   POST /api/admin/users/:userId/unban
//   POST /api/admin/users/:userId/tier
//   POST /api/admin/users/:userId/score
// ============================================================

import { requireAuth, requireAdmin }      from '../middleware/auth.js';
import { addScoreEvent }                  from '../services/aurumScore.js';
import {
  submitBadgeRequest,
  getPendingBadgeRequests,
  getBadgeRequest,
  approveBadgeRequest,
  rejectBadgeRequest,
}                                          from '../services/achievementVerification.js';
import {
  getDisputeQueue,
  getDisputeDetail,
  verifyDisputedPost,
  slashDisputedPost,
  decideAppeal,
}                                          from '../services/disputeResolution.js';
import {
  submitUserFlag,
  getPendingFlags,
  resolveFlag,
}                                          from '../services/fraudDetection.js';
import {
  getUnscoredEntries,
  getResolvableChallenges,
  getDisputedDuels,
  getDisputedCrewBattles,
  getFlaggedCrewSpends,
}                                          from '../services/adminQueue.js';
import {
  getPlatformSummary,
  getDailyActiveUsers,
  getDauTrend,
  getTreasuryStats,
  getRevenueBreakdown,
  getTopPerformers,
}                                          from '../services/analytics.js';
import { resolveCrewSpendFlag }           from '../services/crew.js';

export async function handleAdminRoutes(path, method, request, env) {

  // ── POST /api/badge-requests ─────────────────────────────
  // Authenticated user submits a badge verification request
  if (path === '/api/badge-requests' && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return json({ error: user.error }, 401);

    const { badge_type, evidence_url, notes } = await request.json();
    if (!badge_type || !evidence_url) {
      return json({ error: 'badge_type and evidence_url are required' }, 400);
    }

    try {
      const result = await submitBadgeRequest(user.id, badge_type, evidence_url, notes ?? null, env);
      return json(result, 201);
    } catch (err) {
      return json({ error: err.message }, err.status ?? 400);
    }
  }

  // ── POST /api/report ─────────────────────────────────────
  // Authenticated user submits a moderation flag
  if (path === '/api/report' && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return json({ error: user.error }, 401);

    const { target_type, target_id, reason, notes } = await request.json();
    if (!target_type || !target_id || !reason) {
      return json({ error: 'target_type, target_id and reason are required' }, 400);
    }

    try {
      const result = await submitUserFlag(
        { reporterId: user.id, targetType: target_type, targetId: target_id, reason, notes },
        env
      );
      return json(result, 201);
    } catch (err) {
      return json({ error: err.message }, 400);
    }
  }

  // ── ADMIN GUARD ──────────────────────────────────────────
  // Everything below this point requires admin access.
  // We check once here and reuse the result.
  if (!path.startsWith('/api/admin/')) return null;

  const admin = await requireAdmin(request, env);
  if (admin.error) return json({ error: admin.error }, 403);

  // ── GET /api/admin/check — frontend admin-status probe ───
  if (path === '/api/admin/check' && method === 'GET') {
    return json({ is_admin: true });
  }
	
  // ── GET /api/admin/badge-requests ────────────────────────
  if (path === '/api/admin/badge-requests' && method === 'GET') {
    const url    = new URL(request.url);
    const limit  = parseInt(url.searchParams.get('limit')  ?? '50');
    const offset = parseInt(url.searchParams.get('offset') ?? '0');

    try {
      const requests = await getPendingBadgeRequests(env, limit, offset);
      return json({ requests });
    } catch (err) {
      console.error(err); return json({ error: "Something went wrong" }, 500);
    }
  }

  // ── GET /api/admin/badge-requests/:id ────────────────────
  const badgeReqMatch = path.match(/^\/api\/admin\/badge-requests\/([^/]+)$/);
  if (badgeReqMatch && method === 'GET') {
    try {
      const result = await getBadgeRequest(badgeReqMatch[1], env);
      return json(result);
    } catch (err) {
      return json({ error: err.message }, 404);
    }
  }

  // ── POST /api/admin/badge-requests/:id/approve ───────────
  const badgeApproveMatch = path.match(/^\/api\/admin\/badge-requests\/([^/]+)\/approve$/);
  if (badgeApproveMatch && method === 'POST') {
    try {
      const result = await approveBadgeRequest(badgeApproveMatch[1], admin.id, env);
      return json(result);
    } catch (err) {
      return json({ error: err.message }, 400);
    }
  }

  // ── POST /api/admin/badge-requests/:id/reject ────────────
  const badgeRejectMatch = path.match(/^\/api\/admin\/badge-requests\/([^/]+)\/reject$/);
  if (badgeRejectMatch && method === 'POST') {
    const { reason } = await request.json();
    try {
      const result = await rejectBadgeRequest(badgeRejectMatch[1], admin.id, reason, env);
      return json(result);
    } catch (err) {
      return json({ error: err.message }, 400);
    }
  }

  // ── GET /api/admin/disputes ──────────────────────────────
  if (path === '/api/admin/disputes' && method === 'GET') {
    const url    = new URL(request.url);
    const limit  = parseInt(url.searchParams.get('limit')  ?? '50');
    const offset = parseInt(url.searchParams.get('offset') ?? '0');

    try {
      const disputes = await getDisputeQueue(env, limit, offset);
      return json({ disputes });
    } catch (err) {
      console.error(err); return json({ error: "Something went wrong" }, 500);
    }
  }

  // ── GET /api/admin/disputes/:postId ──────────────────────
  const disputeDetailMatch = path.match(/^\/api\/admin\/disputes\/([^/]+)$/);
  if (disputeDetailMatch && method === 'GET') {
    try {
      const result = await getDisputeDetail(disputeDetailMatch[1], env);
      return json(result);
    } catch (err) {
      return json({ error: err.message }, 404);
    }
  }

  // ── POST /api/admin/disputes/:postId/verify ──────────────
  const disputeVerifyMatch = path.match(/^\/api\/admin\/disputes\/([^/]+)\/verify$/);
  if (disputeVerifyMatch && method === 'POST') {
    try {
      const result = await verifyDisputedPost(disputeVerifyMatch[1], admin.id, env);
      return json(result);
    } catch (err) {
      return json({ error: err.message }, 400);
    }
  }

  // ── POST /api/admin/disputes/:postId/slash ───────────────
  const disputeSlashMatch = path.match(/^\/api\/admin\/disputes\/([^/]+)\/slash$/);
  if (disputeSlashMatch && method === 'POST') {
    const { reason } = await request.json();
    try {
      const result = await slashDisputedPost(disputeSlashMatch[1], admin.id, reason, env);
      return json(result);
    } catch (err) {
      return json({ error: err.message }, 400);
    }
  }

	// ── POST /api/admin/disputes/:postId/appeal-decision ─────
  const appealDecisionMatch = path.match(/^\/api\/admin\/disputes\/([^/]+)\/appeal-decision$/);
  if (appealDecisionMatch && method === 'POST') {
    const { decision } = await request.json();
    if (!['upheld', 'rejected'].includes(decision)) {
      return json({ error: 'decision must be upheld or rejected' }, 400);
    }
    try {
      const result = await decideAppeal(appealDecisionMatch[1], decision, admin.id, env);
      return json(result);
    } catch (err) {
      return json({ error: err.message }, 400);
    }
  }
	
  // ── GET /api/admin/flags ─────────────────────────────────
  if (path === '/api/admin/flags' && method === 'GET') {
    const url    = new URL(request.url);
    const limit  = parseInt(url.searchParams.get('limit')  ?? '50');
    const offset = parseInt(url.searchParams.get('offset') ?? '0');

    try {
      const flags = await getPendingFlags(env, limit, offset);
      return json({ flags });
    } catch (err) {
      console.error(err); return json({ error: "Something went wrong" }, 500);
    }
  }

  // ── POST /api/admin/flags/:id/resolve ────────────────────
  const flagResolveMatch = path.match(/^\/api\/admin\/flags\/([^/]+)\/resolve$/);
  if (flagResolveMatch && method === 'POST') {
    const { decision, action_taken } = await request.json();
    try {
      const result = await resolveFlag(flagResolveMatch[1], admin.id, decision, action_taken, env);
      return json(result);
    } catch (err) {
      return json({ error: err.message }, 400);
    }
  }

// ── GET /api/admin/challenge-entries/unscored ───────────
  if (path === '/api/admin/challenge-entries/unscored' && method === 'GET') {
    const url    = new URL(request.url);
    const limit  = parseInt(url.searchParams.get('limit')  ?? '50');
    const offset = parseInt(url.searchParams.get('offset') ?? '0');
    try {
      const entries = await getUnscoredEntries(env, limit, offset);
      return json({ entries });
    } catch (err) {
      console.error(err); return json({ error: "Something went wrong" }, 500);
    }
  }

  // ── GET /api/admin/challenges/resolvable ─────────────────
  if (path === '/api/admin/challenges/resolvable' && method === 'GET') {
    const url    = new URL(request.url);
    const limit  = parseInt(url.searchParams.get('limit')  ?? '50');
    const offset = parseInt(url.searchParams.get('offset') ?? '0');
    try {
      const challenges = await getResolvableChallenges(env, limit, offset);
      return json({ challenges });
    } catch (err) {
      console.error(err); return json({ error: "Something went wrong" }, 500);
    }
  }

  // ── GET /api/admin/duels/disputes ────────────────────────
  if (path === '/api/admin/duels/disputes' && method === 'GET') {
    const url    = new URL(request.url);
    const limit  = parseInt(url.searchParams.get('limit')  ?? '50');
    const offset = parseInt(url.searchParams.get('offset') ?? '0');
    try {
      const duels = await getDisputedDuels(env, limit, offset);
      return json({ duels });
    } catch (err) {
      console.error(err); return json({ error: "Something went wrong" }, 500);
    }
  }

  // ── GET /api/admin/crew-battles/disputes ─────────────────
  if (path === '/api/admin/crew-battles/disputes' && method === 'GET') {
    const url    = new URL(request.url);
    const limit  = parseInt(url.searchParams.get('limit')  ?? '50');
    const offset = parseInt(url.searchParams.get('offset') ?? '0');
    try {
      const battles = await getDisputedCrewBattles(env, limit, offset);
      return json({ battles });
    } catch (err) {
      console.error(err); return json({ error: "Something went wrong" }, 500);
    }
  }

  // ── GET /api/admin/crew-spends/flags ─────────────────────
  if (path === '/api/admin/crew-spends/flags' && method === 'GET') {
    const url    = new URL(request.url);
    const limit  = parseInt(url.searchParams.get('limit')  ?? '50');
    const offset = parseInt(url.searchParams.get('offset') ?? '0');
    try {
      const flags = await getFlaggedCrewSpends(env, limit, offset);
      return json({ flags });
    } catch (err) {
      console.error(err); return json({ error: "Something went wrong" }, 500);
    }
  }

  // ── POST /api/admin/crew-spends/flags/:id/resolve ────────
  const spendFlagResolveMatch = path.match(/^\/api\/admin\/crew-spends\/flags\/([^/]+)\/resolve$/);
  if (spendFlagResolveMatch && method === 'POST') {
    const { decision, admin_notes } = await request.json();
    try {
      const result = await resolveCrewSpendFlag(spendFlagResolveMatch[1], admin.id, decision, admin_notes, env.DB);
      if (result.error) return json({ error: result.error }, 400);
      return json(result);
    } catch (err) {
      console.error(err); return json({ error: "Something went wrong" }, 500);
    }
  }
	
  // ── GET /api/admin/analytics/summary ────────────────────
  if (path === '/api/admin/analytics/summary' && method === 'GET') {
    try {
      const summary = await getPlatformSummary(env);
      return json(summary);
    } catch (err) {
      console.error(err); return json({ error: "Something went wrong" }, 500);
    }
  }

  // ── GET /api/admin/analytics/dau ────────────────────────
  if (path === '/api/admin/analytics/dau' && method === 'GET') {
    try {
      const dau = await getDailyActiveUsers(env);
      return json(dau);
    } catch (err) {
      console.error(err); return json({ error: "Something went wrong" }, 500);
    }
  }

  // ── GET /api/admin/analytics/dau/trend ──────────────────
  if (path === '/api/admin/analytics/dau/trend' && method === 'GET') {
    const url  = new URL(request.url);
    const days = parseInt(url.searchParams.get('days') ?? '30');
    try {
      const trend = await getDauTrend(env, days);
      return json({ trend });
    } catch (err) {
      console.error(err); return json({ error: "Something went wrong" }, 500);
    }
  }

  // ── GET /api/admin/analytics/treasury ───────────────────
  if (path === '/api/admin/analytics/treasury' && method === 'GET') {
    try {
      const stats = await getTreasuryStats(env);
      return json(stats);
    } catch (err) {
      console.error(err); return json({ error: "Something went wrong" }, 500);
    }
  }

  // ── GET /api/admin/analytics/revenue ────────────────────
  if (path === '/api/admin/analytics/revenue' && method === 'GET') {
    const url    = new URL(request.url);
    const period = url.searchParams.get('period') ?? 'month';
    try {
      const revenue = await getRevenueBreakdown(env, period);
      return json(revenue);
    } catch (err) {
      console.error(err); return json({ error: "Something went wrong" }, 500);
    }
  }

  // ── GET /api/admin/analytics/top-performers ─────────────
  if (path === '/api/admin/analytics/top-performers' && method === 'GET') {
    const url   = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') ?? '10');
    try {
      const performers = await getTopPerformers(env, limit);
      return json(performers);
    } catch (err) {
      console.error(err); return json({ error: "Something went wrong" }, 500);
    }
  }

  // ── POST /api/admin/users/:userId/ban ────────────────────
  const banMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/ban$/);
  if (banMatch && method === 'POST') {
    const { reason } = await request.json();
    try {
      await env.DB.prepare(`
        UPDATE users SET is_suspended = 1, suspension_reason = ?
        WHERE id = ?
      `).bind(reason ?? null, banMatch[1]).run();
      return json({ success: true, userId: banMatch[1], action: 'banned' });
    } catch (err) {
      console.error(err); return json({ error: "Something went wrong" }, 500);
    }
  }

  // ── POST /api/admin/users/:userId/unban ──────────────────
  const unbanMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/unban$/);
  if (unbanMatch && method === 'POST') {
    try {
      await env.DB.prepare(`
        UPDATE users SET is_suspended = 0, suspension_reason = NULL
        WHERE id = ?
      `).bind(unbanMatch[1]).run();
      return json({ success: true, userId: unbanMatch[1], action: 'unbanned' });
    } catch (err) {
      console.error(err); return json({ error: "Something went wrong" }, 500);
    }
  }

  // ── POST /api/admin/users/:userId/tier ───────────────────
  // Fix 8 — tier change to sovereign must create or validate subscription record
  const tierMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/tier$/);
  if (tierMatch && method === 'POST') {
    const { tier } = await request.json();
    const allowed  = ['explorer', 'contender', 'sovereign'];
    if (!allowed.includes(tier)) {
      return json({ error: `tier must be one of: ${allowed.join(', ')}` }, 400);
    }

    const userId = tierMatch[1];

    try {
      // Fix 8 — if setting sovereign, ensure an active subscription record exists
      if (tier === 'sovereign') {
        const existingSub = await env.DB.prepare(`
          SELECT id, status FROM subscriptions
          WHERE user_id = ? AND tier = 'sovereign'
          ORDER BY created_at DESC
          LIMIT 1
        `).bind(userId).first();

        const now       = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

        if (!existingSub) {
          // No subscription record at all — create one marked as admin-granted
          await env.DB.prepare(`
            INSERT INTO subscriptions
              (user_id, tier, status, payment_reference, activated_at, expires_at, created_at)
            VALUES (?, 'sovereign', 'active', ?, ?, ?, ?)
          `).bind(userId, `admin:${admin.id}:${crypto.randomUUID()}`, now, expiresAt, now).run();
        } else if (existingSub.status !== 'active') {
          // Record exists but is not active — reactivate it
          await env.DB.prepare(`
            UPDATE subscriptions
            SET status       = 'active',
                activated_at = ?,
                expires_at   = ?
            WHERE user_id = ? AND tier = 'sovereign'
          `).bind(now, expiresAt, userId).run();
        }
        // If already active — leave it untouched
      }

      await env.DB.prepare(`
        UPDATE users SET tier = ? WHERE id = ?
      `).bind(tier, userId).run();

      return json({ success: true, userId, tier });
    } catch (err) {
      console.error(err); return json({ error: "Something went wrong" }, 500);
    }
  }

  // ── POST /api/admin/users/:userId/score ──────────────────
  // Fix 7 — uses addScoreEvent instead of raw SQL update
  const scoreMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/score$/);
  if (scoreMatch && method === 'POST') {
    const { delta, reason } = await request.json();
    if (typeof delta !== 'number') {
      return json({ error: 'delta must be a number (positive or negative)' }, 400);
    }

    const userId = scoreMatch[1];

    try {
      const user = await env.DB.prepare(`
        SELECT aurum_score FROM users WHERE id = ?
      `).bind(userId).first();

      if (!user) return json({ error: 'User not found' }, 404);

      // Fix 7 — route through score engine, never raw SQL
      // addScoreEvent handles the update, league reassignment, and badge checks
      const newScore = await addScoreEvent(
        userId,
        'admin_adjustment',
        delta,
        { note: reason ? `Admin adjustment: ${reason}` : `Admin adjustment by ${admin.id}` },
        env.DB,
      );

      return json({ success: true, userId, delta, newScore });
    } catch (err) {
      console.error(err); return json({ error: "Something went wrong" }, 500);
    }
  }

  return null;
}

// ── Helper ────────────────────────────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
