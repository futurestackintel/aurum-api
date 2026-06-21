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

// ── Fix 5 — Subscription expiry cron ─────────────────────────────────────────
// Runs daily. Finds subscriptions past their expires_at, marks them expired,
// downgrades user tier to explorer, and revokes the Sovereign badge if held.
async function processExpiredSubscriptions(db) {
  const now = new Date().toISOString();

  // Find all subscriptions that have passed expires_at and are still active
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
      // Mark subscription expired
      await db
        .prepare(`
          UPDATE subscriptions
          SET status = 'expired'
          WHERE user_id  = ?
            AND status   = 'active'
            AND expires_at <= ?
        `)
        .bind(userId, now)
        .run();

      // Downgrade user tier to explorer
      await db
        .prepare(`UPDATE users SET tier = 'explorer' WHERE id = ?`)
        .bind(userId)
        .run();

      // Revoke Sovereign badge if held
      const sovereignBadge = await db
        .prepare(`
          SELECT id FROM badges
          WHERE user_id   = ?
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
      // Log per-user errors but continue processing remaining users
      console.error(`Error processing expired subscription for user ${userId}:`, err);
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: getCorsHeaders(request) });
    }

    const url      = new URL(request.url);
    const pathname = url.pathname;

    try {
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
      Object.entries(getCorsHeaders(request)).forEach(([k, v]) =>
        newHeaders.set(k, v),
      );

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
            ...getCorsHeaders(request),
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
        processExpiredSubscriptions(env.DB), // Fix 5 — subscription expiry
      ]),
    );
  },
};
