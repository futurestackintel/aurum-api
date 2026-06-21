// ============================================================
// AURUM Worker Entry Point
// All routes, CORS, and cron scheduling live here.
// ============================================================

import { handleWebhookRoutes }          from './routes/webhook.js';
import { handleAuthRoutes }             from './routes/auth.js';
import { handleTipsRoutes }             from './routes/tips.js';
import { handleSubscriptionRoutes }     from './routes/subscriptions.js';
import { handleChallengePaymentRoutes } from './routes/challenges.js';
import { handleLeagueRoutes }           from './routes/league.js';
import { handleBadgeRoutes }            from './routes/badge.js';
import { handlePostRoutes }             from './routes/posts.js';
import { handleChallengeRoutes }        from './routes/dropCircle.js';
import { handleDuelRoutes }             from './routes/duel.js';
import { handleAdminRoutes }            from './routes/admin.js';
import { handleWalletRoutes }           from './routes/wallet.js';
import { handleFoundingRoutes }         from './routes/founding.js';
import { runLeaderboardSnapshot }       from './services/leaderboardCron.js';
import { updateExchangeRates }          from './services/currency.js';
import { finaliseExpiredAppeals }       from './services/proofOfStake.js';

const ALLOWED_ORIGINS = [
  'https://tryaurum.store',
  'https://www.tryaurum.store',
  'https://aurum-frontend.pages.dev',
];

function getCorsHeaders(request) {
  const origin  = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin)
    ? origin
    : ALLOWED_ORIGINS[0];

  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

// ── Chat D — Subscription expiry cron ────────────────────────────────────────
// Runs daily. Finds subscriptions past their expires_at, marks them expired,
// downgrades user tier to explorer, and revokes the Sovereign badge if held.
async function processExpiredSubscriptions(db) {
  const now = new Date().toISOString();

  const { results: expired } = await db
    .prepare(`
      SELECT user_id FROM subscriptions
      WHERE status     = 'active'
        AND expires_at IS NOT NULL
        AND expires_at <= ?
    `)
    .bind(now)
    .all();

  if (!expired.length) return;

  for (const sub of expired) {
    const userId = sub.user_id;

    try {
      await db
        .prepare(`
          UPDATE subscriptions
          SET status = 'expired'
          WHERE user_id    = ?
            AND status     = 'active'
            AND expires_at <= ?
        `)
        .bind(userId, now)
        .run();

      await db
        .prepare(`UPDATE users SET tier = 'explorer' WHERE id = ?`)
        .bind(userId)
        .run();

      const sovereignBadge = await db
        .prepare(`
          SELECT id FROM badges
          WHERE user_id    = ?
            AND badge_type = 'sovereign'
            AND revoked_at IS NULL
          LIMIT 1
        `)
        .bind(userId)
        .first();

      if (sovereignBadge) {
        await db
          .prepare(`
            UPDATE badges
            SET revoked_at = ?
            WHERE user_id    = ?
              AND badge_type = 'sovereign'
              AND revoked_at IS NULL
          `)
          .bind(now, userId)
          .run();
      }

      console.log(`Subscription expired — user downgraded: ${userId}`);
    } catch (err) {
      console.error(`Error processing expired subscription for user ${userId}:`, err);
    }
  }
}

// ── Fix 6 — Rate limiting via KV ─────────────────────────────────────────────
// Fixed window counter stored in KV.
// Returns { limited: false } or { limited: true, retryAfter: number }

async function checkRateLimit(ip, route, limit, windowSeconds, env) {
  const now       = Math.floor(Date.now() / 1000);
  const windowKey = `rl:${route}:${ip}:${Math.floor(now / windowSeconds)}`;

  try {
    const current = await env.KV.get(windowKey);
    const count   = current ? parseInt(current, 10) : 0;

    if (count >= limit) {
      const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
      const retryAfter  = windowStart + windowSeconds - now;
      return { limited: true, retryAfter };
    }

    await env.KV.put(windowKey, String(count + 1), { expirationTtl: windowSeconds * 2 });
    return { limited: false };

  } catch (err) {
    // KV failure must never block a real request
    console.error('[rateLimit] KV error — allowing request through:', err);
    return { limited: false };
  }
}

function getClientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')  ||
    'unknown'
  );
}

function rateLimitResponse(retryAfter, corsHeaders) {
  return new Response(
    JSON.stringify({ error: 'Too many requests. Please try again later.' }),
    {
      status: 429,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Retry-After':  String(retryAfter),
      },
    },
  );
}

// ── Fix 7 — Public leaderboard ────────────────────────────────────────────────
// GET /leaderboard/public — no auth required
// Returns top 10 from latest daily snapshot for all four boards.

async function handlePublicLeaderboard(env) {
  const db     = env.DB;
  const today  = new Date().toISOString().slice(0, 10);
  const boards = ['most_generous', 'highest_earner', 'most_wins', 'aurum_score'];
  const result = {};

  for (const board of boards) {
    let { results } = await db
      .prepare(`
        SELECT rank, display_name, score, league_at_snapshot
        FROM leaderboard_snapshots
        WHERE board_type = ?
          AND period     = 'daily'
          AND period_key = ?
        ORDER BY rank ASC
        LIMIT 10
      `)
      .bind(board, today)
      .all();

    if (!results.length) {
      // Fallback — most recent daily snapshot if today's hasn't run yet
      const fallback = await db
        .prepare(`
          SELECT rank, display_name, score, league_at_snapshot
          FROM leaderboard_snapshots
          WHERE board_type = ?
            AND period     = 'daily'
          ORDER BY period_key DESC, rank ASC
          LIMIT 10
        `)
        .bind(board)
        .all();

      results = fallback.results;
    }

    result[board] = results;
  }

  return jsonResponse({ leaderboard: result, as_of: today });
}

// ── Build 1 — Wealth Passport ─────────────────────────────────────────────────
// GET /api/passport/:username — no auth required
// Returns public achievement profile for a user.

async function handlePassport(username, env) {
  const db = env.DB;

  const user = await db
    .prepare(`
      SELECT
        id,
        username,
        league,
        aurum_score,
        streak_days,
        created_at
      FROM users
      WHERE username = ?
    `)
    .bind(username)
    .first();

  if (!user) return jsonResponse({ error: 'User not found' }, 404);

  // Badges
  const { results: badgeRows } = await db
    .prepare(`
      SELECT badge_type, awarded_at
      FROM user_badges
      WHERE user_id = ?
      ORDER BY awarded_at ASC
    `)
    .bind(user.id)
    .all();

  // Challenge wins
  const winsRow = await db
    .prepare(`
      SELECT COUNT(*) as count
      FROM drop_circles
      WHERE winner_id = ?
        AND status    = 'completed'
    `)
    .bind(user.id)
    .first();

  // Total tips given
  const tipsRow = await db
    .prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM tips
      WHERE sender_id = ?
    `)
    .bind(user.id)
    .first();

  // Rank on aurum_score leaderboard — today's snapshot with fallback
  const today = new Date().toISOString().slice(0, 10);

  let rankRow = await db
    .prepare(`
      SELECT rank
      FROM leaderboard_snapshots
      WHERE board_type = 'aurum_score'
        AND period     = 'daily'
        AND period_key = ?
        AND user_id    = ?
    `)
    .bind(today, user.id)
    .first();

  if (!rankRow) {
    rankRow = await db
      .prepare(`
        SELECT rank
        FROM leaderboard_snapshots
        WHERE board_type = 'aurum_score'
          AND period     = 'daily'
          AND user_id    = ?
        ORDER BY period_key DESC
        LIMIT 1
      `)
      .bind(user.id)
      .first();
  }

  return jsonResponse({
    username:            user.username,
    league:              user.league,
    aurum_score:         user.aurum_score,
    badges:              badgeRows,
    challenge_wins:      winsRow?.count   ?? 0,
    total_tips_given:    tipsRow?.total   ?? 0,
    streak:              user.streak_days ?? 0,
    member_since:        user.created_at,
    rank_on_leaderboard: rankRow?.rank    ?? null,
  });
}

// ── Helper ────────────────────────────────────────────────────────────────────

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Main fetch handler ────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: getCorsHeaders(request) });
    }

    const url      = new URL(request.url);
    const pathname = url.pathname;
    const ip       = getClientIp(request);
    const cors     = getCorsHeaders(request);

    try {

      // ── Fix 6 — Rate limiting gates ──────────────────────────────────────
      // Auth routes: 10 req/min
      if (pathname.startsWith('/api/auth')) {
        const rl = await checkRateLimit(ip, 'auth', 10, 60, env);
        if (rl.limited) return rateLimitResponse(rl.retryAfter, cors);
      }

      // Tips routes: 20 req/min
      if (pathname.startsWith('/api/tips')) {
        const rl = await checkRateLimit(ip, 'tips', 20, 60, env);
        if (rl.limited) return rateLimitResponse(rl.retryAfter, cors);
      }

      // Post creation: 5 req/min (POST only)
      if (pathname.startsWith('/api/posts') && request.method === 'POST') {
        const rl = await checkRateLimit(ip, 'posts', 5, 60, env);
        if (rl.limited) return rateLimitResponse(rl.retryAfter, cors);
      }

      // ── Fix 7 — Public leaderboard (no auth) ─────────────────────────────
      if (pathname === '/leaderboard/public' && request.method === 'GET') {
        const res        = await handlePublicLeaderboard(env);
        const newHeaders = new Headers(res.headers);
        Object.entries(cors).forEach(([k, v]) => newHeaders.set(k, v));
        return new Response(res.body, { status: res.status, headers: newHeaders });
      }

      // ── Build 1 — Wealth Passport (no auth) ──────────────────────────────
      const passportMatch = pathname.match(/^\/api\/passport\/([^/]+)$/);
      if (passportMatch && request.method === 'GET') {
        const username   = decodeURIComponent(passportMatch[1]);
        const res        = await handlePassport(username, env);
        const newHeaders = new Headers(res.headers);
        Object.entries(cors).forEach(([k, v]) => newHeaders.set(k, v));
        return new Response(res.body, { status: res.status, headers: newHeaders });
      }

      // ── Standard route dispatch ───────────────────────────────────────────
      let response =
        (await handleWebhookRoutes(pathname, request, env))                   ||
        (await handleAuthRoutes(pathname, request, env))                      ||
        (await handleWalletRoutes(pathname, request, env))                    ||
        (await handleTipsRoutes(pathname, request, env))                      ||
        (await handleSubscriptionRoutes(pathname, request, env))              ||
        (await handleChallengePaymentRoutes(pathname, request, env))          ||
        (await handleFoundingRoutes(pathname, request, env))                  ||
        (await handleLeagueRoutes(pathname, request.method, request, env))    ||
        (await handleBadgeRoutes(pathname, request.method, request, env))     ||
        (await handlePostRoutes(pathname, request.method, request, env))      ||
        (await handleChallengeRoutes(pathname, request.method, request, env)) ||
        (await handleDuelRoutes(pathname, request.method, request, env))      ||
        (await handleAdminRoutes(pathname, request.method, request, env));

      if (!response) {
        response = new Response(
          JSON.stringify({ error: 'Route not found' }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        );
      }

      const newHeaders = new Headers(response.headers);
      Object.entries(cors).forEach(([k, v]) => newHeaders.set(k, v));

      return new Response(response.body, {
        status:  response.status,
        headers: newHeaders,
      });

    } catch (err) {
      console.error('Worker error:', err);
      return new Response(
        JSON.stringify({ error: 'Internal server error' }),
        {
          status: 500,
          headers: {
            ...cors,
            'Content-Type': 'application/json',
          },
        },
      );
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      Promise.all([
        runLeaderboardSnapshot(env),
        updateExchangeRates(env.DB),
        finaliseExpiredAppeals(env.DB),
        processExpiredSubscriptions(env.DB), // Chat D — subscription expiry
      ]),
    );
  },
};
