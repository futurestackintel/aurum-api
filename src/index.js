// ============================================================
// AURUM Worker Entry Point — Final Fix Chat
// Fix 7: expireChallenges imported and wired into scheduled cron.
// Fix 3 (confirmed, no change needed): handleUpdateNotifications
// already resolves internal DB user id from Clerk id before the
// upsert — see comment above that function.
// ============================================================

import { jsonResponse } from './http.js';
import { handleWebhookRoutes }          from './routes/webhook.js';
import { handleAuthRoutes }             from './routes/auth.js';
import { handleTipsRoutes }             from './routes/tips.js';
import { handleSubscriptionRoutes }     from './routes/subscriptions.js';
import { handleChallengePaymentRoutes } from './routes/challenges.js';
import { handleLeagueRoutes }           from './routes/league.js';
import { handleBadgeRoutes }            from './routes/badge.js';
import { handlePostRoutes }             from './routes/posts.js';
import { handleSocialRoutes }           from './routes/social.js';
import { handleChallengeRoutes }        from './routes/dropCircle.js';
import { handleDuelRoutes }             from './routes/duel.js';
import { handleWorkRoutes }             from './routes/work.js';
import { handleAdminRoutes }            from './routes/admin.js';
import { handleWalletRoutes }           from './routes/wallet.js';
import { handleFoundingRoutes }         from './routes/founding.js';
import { handleCrewRoutes }             from './routes/crew.js';
import { handleDmRoutes }               from './routes/dm.js';
import { handleUserSearchRoutes }       from './routes/userSearch.js';
import { handleSearchRoutes }           from './routes/search.js';
import { handleProfileRoutes }          from './routes/profile.js';
import { handleCommentRoutes }          from './routes/comments.js';
import { handleNotificationRoutes }     from './routes/notifications.js';
import { runLeaderboardSnapshot }       from './services/leaderboardCron.js';
import { updateExchangeRates }          from './services/currency.js';
import { finaliseExpiredAppeals, canViewPost } from './services/proofOfStake.js';
import { expireChallenges }             from './services/dropCircle.js';
import { processDuelCron }              from './services/duel.js';
import { processCrewBattleCron }        from './services/crew.js';
import { requireAuth }                   from './middleware/auth.js';
import { addScoreEvent }                from './services/aurumScore.js';
import { publishNotification } from './services/notificationPublisher.js';
import './services/notificationEventConsumer.js';
import { processRegisteredEventDeliveries } from './services/eventConsumerRegistry.js';
export { CrewChatRoom } from './durableObjects/CrewChatRoom.js';
export { DmRoom } from './durableObjects/DmRoom.js';

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
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

// ── Subscription expiry cron ──────────────────────────────────
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

// ── Rate limiting via KV ──────────────────────────────────────
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

// ── Public leaderboard ────────────────────────────────────────
async function handlePublicLeaderboard(env) {
  const db     = env.DB;
  const today  = new Date().toISOString().slice(0, 10);
  const boards = ['most_generous', 'highest_earner', 'most_wins', 'aurum_score'];
  const result = {};

  for (const board of boards) {
    const leaderboardQuery = (periodKey) => db.prepare(`
      WITH eligible_rows AS (
        SELECT ls.rank AS stored_rank, ls.display_name, ls.score,
          CASE WHEN u.hide_league = 1 THEN NULL ELSE ls.league_at_snapshot END AS league_at_snapshot
        FROM leaderboard_snapshots ls
        JOIN users u ON u.id = ls.user_id
        WHERE ls.board_type = ? AND ls.period = 'daily'
          ${periodKey ? 'AND ls.period_key = ?' : ''}
          AND (? != 'aurum_score' OR u.hide_aurum_score = 0)
      ), ranked_rows AS (
        SELECT ROW_NUMBER() OVER (ORDER BY stored_rank ASC) AS rank,
          display_name, score, league_at_snapshot
        FROM eligible_rows
      )
      SELECT rank, display_name, score, league_at_snapshot
      FROM ranked_rows ORDER BY rank ASC LIMIT 10
    `).bind(...(periodKey ? [board, periodKey, board] : [board, board]));

    let { results } = await leaderboardQuery(today).all();

    if (!results.length) {
      const fallback = await leaderboardQuery(null).all();
      results = fallback.results;
    }

    result[board] = results;
  }

  return jsonResponse({ leaderboard: result, as_of: today });
}
async function handleAuthenticatedLeaderboard(type, env) {
  const db = env.DB;
  const TYPE_MAP = {
    earners: 'highest_earner',
    generous: 'most_generous',
    champions: 'most_wins',
    score: 'aurum_score',
  };

  const boardType = TYPE_MAP[type] || 'aurum_score';
  const today = new Date().toISOString().slice(0, 10);

  const leaderboardQuery = (periodKey) => db.prepare(`
    WITH eligible_rows AS (
      SELECT ls.rank AS stored_rank, ls.score, ls.avatar_url,
        CASE WHEN u.hide_league = 1 THEN NULL ELSE ls.league_at_snapshot END AS league_at_snapshot,
        u.username, u.league, u.is_verified
      FROM leaderboard_snapshots ls
      JOIN users u ON u.id = ls.user_id
      WHERE ls.board_type = ? AND ls.period = 'daily'
        ${periodKey ? 'AND ls.period_key = ?' : ''}
        AND (? != 'aurum_score' OR u.hide_aurum_score = 0)
    ), ranked_rows AS (
      SELECT ROW_NUMBER() OVER (ORDER BY stored_rank ASC) AS rank,
        score, avatar_url, league_at_snapshot, username, league, is_verified
      FROM eligible_rows
    )
    SELECT rank, score, avatar_url, league_at_snapshot, username, league, is_verified
    FROM ranked_rows ORDER BY rank ASC LIMIT 20
  `).bind(...(periodKey ? [boardType, periodKey, boardType] : [boardType, boardType]));

  let { results } = await leaderboardQuery(today).all();

  if (!results.length) {
    const fallback = await leaderboardQuery(null).all();
    results = fallback.results;
  }

  const entries = results.map(r => ({
    username: r.username,
    league: r.league_at_snapshot || r.league,
    value: r.score,
    verified: !!r.is_verified,
    avatar_url: r.avatar_url,
  }));

  return jsonResponse({ entries });
}
// ── Wealth Passport ───────────────────────────────────────────
async function handlePassport(username, env) {
  const db = env.DB;

  const user = await db
    .prepare(`
      SELECT id, username, league, aurum_score, streak_current, created_at,
             is_verified, total_challenges_won, total_tips_sent_cents,
             hide_aurum_score, hide_league, avatar_url, is_suspended
      FROM users
      WHERE username = ?
        AND account_deleted = 0
        AND deleted_at IS NULL
    `)
    .bind(username)
    .first();

  if (!user || user.is_suspended) {
    return jsonResponse({ error: 'User not found' }, 404);
  }

  const { results: badgeRows } = await db
    .prepare(`
      SELECT badge_type, verified_at AS awarded_at
      FROM badges
      WHERE user_id = ?
        AND is_public = 1
        AND revoked_at IS NULL
      ORDER BY awarded_at ASC
    `)
    .bind(user.id)
    .all();

  const today = new Date().toISOString().slice(0, 10);

  let rankRow = null;

  if (!user.hide_aurum_score) {
    rankRow = await db
      .prepare(`
        SELECT rank FROM leaderboard_snapshots
        WHERE board_type = 'aurum_score'
          AND period = 'daily'
          AND period_key = ?
          AND user_id = ?
      `)
      .bind(today, user.id)
      .first();

    if (!rankRow) {
      rankRow = await db
        .prepare(`
          SELECT rank FROM leaderboard_snapshots
          WHERE board_type = 'aurum_score'
            AND period = 'daily'
            AND user_id = ?
          ORDER BY period_key DESC
          LIMIT 1
        `)
        .bind(user.id)
        .first();
    }
  }

  return jsonResponse({
    username: user.username,
    avatar_url: user.avatar_url,
    league: user.hide_league ? null : user.league,
    aurum_score: user.hide_aurum_score ? null : user.aurum_score,
    verified: !!user.is_verified,
    badges: badgeRows,
    challenge_wins: user.total_challenges_won ?? 0,
    total_tips_given: (user.total_tips_sent_cents ?? 0) / 100,
    streak: user.streak_current ?? 0,
    member_since: user.created_at,
    rank_on_leaderboard: rankRow?.rank ?? null,
  });
}
// ── Settings: PATCH /api/users/me ────────────────────────────

async function handleUpdateProfile(request, env) {
  const db = env.DB;
  const user = await requireAuth(request, env);

  if (user.error) {
    return jsonResponse({ error: user.error }, 401);
  }

  try {
    const dbUser = await db
      .prepare(`SELECT id FROM users WHERE clerk_id = ? AND deleted_at IS NULL`)
      .bind(user.id)
      .first();

    if (!dbUser) {
      return jsonResponse({ error: 'User not found' }, 404);
    }

    const body = await request.json();

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonResponse({ error: 'Invalid request body' }, 400);
    }

    const {
      username,
      display_name,
      bio,
      hide_aurum_score,
      hide_league,
      avatar_url,
    } = body;

    if (username !== undefined) {
      if (
        typeof username !== 'string' ||
        username.trim().length < 3 ||
        username.trim().length > 30 ||
        !/^[a-zA-Z0-9_]+$/.test(username.trim())
      ) {
        return jsonResponse({
          error: 'Username must be 3–30 characters and contain only letters, numbers and underscores'
        }, 400);
      }

      const taken = await db
        .prepare(`SELECT id FROM users WHERE username = ? AND id != ?`)
        .bind(username.trim(), dbUser.id)
        .first();

      if (taken) {
        return jsonResponse({ error: 'Username is already taken' }, 409);
      }
    }

    if (
      display_name !== undefined &&
      (typeof display_name !== 'string' ||
        display_name.trim().length < 1 ||
        display_name.trim().length > 80)
    ) {
      return jsonResponse({
        error: 'Display name must be 1–80 characters'
      }, 400);
    }

    if (bio !== undefined && (typeof bio !== 'string' || bio.length > 300)) {
      return jsonResponse({
        error: 'Bio must be 300 characters or fewer'
      }, 400);
    }

    for (const [field, value] of Object.entries({
      hide_aurum_score,
      hide_league,
    })) {
      if (value !== undefined && typeof value !== 'boolean') {
        return jsonResponse({ error: `${field} must be a boolean` }, 400);
      }
    }

    if (
      avatar_url !== undefined &&
      avatar_url !== null &&
      (typeof avatar_url !== 'string' || avatar_url.length > 2048)
    ) {
      return jsonResponse({ error: 'Invalid avatar value' }, 400);
    }

    const fields = [];
    const values = [];

    if (username !== undefined) {
      fields.push('username = ?');
      values.push(username.trim());
    }

    if (display_name !== undefined) {
      fields.push('display_name = ?');
      values.push(display_name.trim());
    }

    if (bio !== undefined) {
      fields.push('bio = ?');
      values.push(bio.trim());
    }

    if (hide_aurum_score !== undefined) {
      fields.push('hide_aurum_score = ?');
      values.push(hide_aurum_score ? 1 : 0);
    }

    if (hide_league !== undefined) {
      fields.push('hide_league = ?');
      values.push(hide_league ? 1 : 0);
    }

    if (avatar_url !== undefined) {
      fields.push('avatar_url = ?');
      values.push(avatar_url);
    }

    if (fields.length === 0) {
      return jsonResponse({ error: 'No valid fields provided' }, 400);
    }

    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(dbUser.id);

    await db
      .prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();

    const updated = await db
      .prepare(`
        SELECT username, display_name, bio, avatar_url,
               hide_aurum_score, hide_league
        FROM users WHERE id = ?
      `)
      .bind(dbUser.id)
      .first();

    return jsonResponse({ updated: true, user: updated });
  } catch (err) {
    console.error('Profile update error:', err);
    return jsonResponse({
      error: 'Unable to update profile. Please try again.'
    }, 500);
  }
}

// ── Settings: notification preferences ──────────────────────
const NOTIFICATION_PREFERENCE_FIELDS = [
  'tips_received',
  'challenge_updates',
  'messages',
  'crew_updates',
  'duel_challenges',
  'league_promotions',
  'badge_awards',
  'weekly_summary',
];

async function handleUpdateNotifications(request, env) {
  const db = env.DB;
  const user = await requireAuth(request, env);

  if (user.error) {
    return jsonResponse({ error: user.error }, 401);
  }

  const dbUser = await db
    .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
    .bind(user.id)
    .first();

  if (!dbUser) {
    return jsonResponse({ error: 'User not found' }, 404);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse({ error: 'Invalid preferences payload' }, 400);
  }

  const fields = Object.keys(body);

  if (fields.length === 0) {
    return jsonResponse({ error: 'No preferences provided' }, 400);
  }

  for (const field of fields) {
    if (!NOTIFICATION_PREFERENCE_FIELDS.includes(field)) {
      return jsonResponse({ error: `Unsupported preference: ${field}` }, 400);
    }

    if (typeof body[field] !== 'boolean') {
      return jsonResponse({ error: `${field} must be a boolean` }, 400);
    }
  }

  const now = new Date().toISOString();

  const existing = await db
    .prepare(`SELECT id FROM notification_preferences WHERE user_id = ?`)
    .bind(dbUser.id)
    .first();

  if (existing) {
    const assignments = fields.map((field) => `${field} = ?`);
    const values = fields.map((field) => body[field] ? 1 : 0);

    assignments.push('updated_at = ?');
    values.push(now, dbUser.id);

    await db.prepare(`
      UPDATE notification_preferences
      SET ${assignments.join(', ')}
      WHERE user_id = ?
    `).bind(...values).run();
  } else {
    const valuesByField = Object.fromEntries(
      NOTIFICATION_PREFERENCE_FIELDS.map((field) => [
        field,
        body[field] === undefined ? 1 : (body[field] ? 1 : 0),
      ]),
    );

    await db.prepare(`
      INSERT INTO notification_preferences (
        id, user_id,
        tips_received, challenge_updates, messages, crew_updates,
        duel_challenges, league_promotions, badge_awards, weekly_summary,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      dbUser.id,
      valuesByField.tips_received,
      valuesByField.challenge_updates,
      valuesByField.messages,
      valuesByField.crew_updates,
      valuesByField.duel_challenges,
      valuesByField.league_promotions,
      valuesByField.badge_awards,
      valuesByField.weekly_summary,
      now,
      now,
    ).run();
  }

  const preferences = await db
    .prepare(`
      SELECT tips_received, challenge_updates, messages, crew_updates,
             duel_challenges, league_promotions, badge_awards, weekly_summary
      FROM notification_preferences
      WHERE user_id = ?
    `)
    .bind(dbUser.id)
    .first();

  return jsonResponse({ updated: true, preferences });
}
// ── Settings: POST /api/users/me/delete ──────────────────────
async function handleDeleteAccount(request, env) {
  const db   = env.DB;
  const user = await requireAuth(request, env);
  if (user.error) return jsonResponse({ error: user.error }, 401);

  const dbUser = await db
    .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
    .bind(user.id)
    .first();

  if (!dbUser) return jsonResponse({ error: 'User not found' }, 404);

  const now = new Date().toISOString();

  await db
    .prepare(`
      UPDATE users
      SET account_deleted = 1, deleted_at = ?, updated_at = ?
      WHERE id = ?
    `)
    .bind(now, now, dbUser.id)
    .run();

  // Revoke Clerk session by banning the user via Clerk Backend API
  try {
    await fetch(`https://api.clerk.com/v1/users/${user.clerkId}/ban`, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${env.CLERK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    // Non-fatal — account is already marked deleted in DB
    console.error('Clerk ban error:', err);
  }

  return jsonResponse({
    deleted:      true,
    grace_period: '30 days',
    message:      'Your account has been scheduled for deletion. You have 30 days to contact support to recover it.',
  });
}

// ── Feature 7b: POST /api/posts/:id/cheer ────────────────────
export async function handlePostCheer(postId, request, env) {
  const db   = env.DB;
  const user = await requireAuth(request, env);
  if (user.error) return jsonResponse({ error: user.error }, 401);

  const dbUser = await db
    .prepare(`SELECT id, league FROM users WHERE clerk_id = ? AND account_deleted = 0 AND deleted_at IS NULL AND is_suspended = 0`)
    .bind(user.id)
    .first();

  if (!dbUser) return jsonResponse({ error: 'User not found' }, 404);

  if (!(await canViewPost(postId, db, dbUser))) return jsonResponse({ error: 'Post not found' }, 404);

  const post = await db
    .prepare(`SELECT id, user_id FROM posts WHERE id = ?`)
    .bind(postId)
    .first();

  if (!post) return jsonResponse({ error: 'Post not found' }, 404);

  const existing = await db
    .prepare(`SELECT id FROM post_cheers WHERE post_id = ? AND user_id = ?`)
    .bind(postId, dbUser.id)
    .first();

  if (existing) return jsonResponse({ error: 'You have already cheered this post' }, 400);

  const now = new Date().toISOString();

  await db
    .prepare(`
      INSERT INTO post_cheers (id, post_id, user_id, created_at)
      VALUES (?, ?, ?, ?)
    `)
    .bind(crypto.randomUUID(), postId, dbUser.id, now)
    .run();

    // Notify post author through the shared event pipeline.
  if (post.user_id !== dbUser.id) {
    try {
      await publishNotification(db, {
        recipientUserId: post.user_id,
        type: 'post_reacted',
        title: 'Someone cheered your post',
        body: 'Your Wealth Journey post received a cheer!',
        actionUrl: `/posts/${postId}`,
        actorType: 'member',
        actorId: dbUser.id,
        resourceType: 'post',
        resourceId: postId,
        requestId: `post-cheer:${postId}:${dbUser.id}`,
      });
    } catch (error) {
      console.error('Post cheer notification failed:', error?.name);
    }
  }
  // Award 1 Aurum Score to the cheerer
  await addScoreEvent(
    dbUser.id,
    'tip_received_reaction',
    1,
    { post_id: postId, note: 'Cheered a Wealth Journey post' },
    db,
  );

  return jsonResponse({ cheered: true, post_id: postId });
}

// ── KYC gate helper ───────────────────────────────────────────
async function checkKycGate(userId, db) {
  const user = await db
    .prepare(`
      SELECT email, display_name, kyc_status
      FROM users WHERE id = ?
    `)
    .bind(userId)
    .first();

  if (!user) return { blocked: true, reason: 'User not found' };

  const missing = [];

  if (!user.email)        missing.push('verified email address');
  if (!user.display_name) missing.push('full name on profile');

  // Check bank account details exist
  const bankDetails = await db
    .prepare(`SELECT id FROM wallet_transactions WHERE user_id = ? AND type = 'bank_account' LIMIT 1`)
    .bind(userId)
    .first();

  if (!bankDetails) missing.push('valid bank account details');

  if (missing.length > 0) {
    return {
      blocked: true,
      reason:  `Before withdrawing you must provide: ${missing.join(', ')}.`,
    };
  }

  return { blocked: false };
}


// ── Main fetch handler ────────────────────────────────────────
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
      // ── Rate limiting gates ─────────────────────────────
      if (pathname.startsWith('/api/auth')) {
        const rl = await checkRateLimit(ip, 'auth', 10, 60, env);
        if (rl.limited) return rateLimitResponse(rl.retryAfter, cors);
      }

      if (pathname.startsWith('/api/tips')) {
        const rl = await checkRateLimit(ip, 'tips', 20, 60, env);
        if (rl.limited) return rateLimitResponse(rl.retryAfter, cors);
      }

      if (pathname.match(/^\/api\/posts\/[^/]+\/comments$/) && request.method === 'POST') {
        const rl = await checkRateLimit(ip, 'comments', 15, 60, env);
        if (rl.limited) return rateLimitResponse(rl.retryAfter, cors);
      } else if (pathname.startsWith('/api/posts') && request.method === 'POST') {
        const rl = await checkRateLimit(ip, 'posts', 5, 60, env);
        if (rl.limited) return rateLimitResponse(rl.retryAfter, cors);
      }

      // ── KYC gate on withdrawals ─────────────────────────
      if (pathname === '/api/wallet/withdraw' && request.method === 'POST') {
        const user = await requireAuth(request, env);
        if (user.error) {
          return withCors(jsonResponse({ error: user.error }, 401), cors);
        }
        const dbUser = await env.DB
          .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
          .bind(user.id)
          .first();
        if (!dbUser) {
          return withCors(jsonResponse({ error: 'User not found' }, 404), cors);
        }
        const kyc = await checkKycGate(dbUser.id, env.DB);
        if (kyc.blocked) {
          return withCors(jsonResponse({ error: kyc.reason }, 403), cors);
        }
      }

      // ─── Public leaderboard (no auth) ──────────────
      if (pathname === '/leaderboard/public' && request.method === 'GET') {
        const res = await handlePublicLeaderboard(env);
        return withCors(res, cors);
      }
      // ─── Authenticated full leaderboard ────────────
      if (pathname === '/leaderboard' && request.method === 'GET') {
        const authUser = await requireAuth(request, env);
        if (authUser.error) return withCors(jsonResponse({ error: authUser.error }, 401), cors);
        const url  = new URL(request.url);
        const type = url.searchParams.get('type') || 'score';
        const res  = await handleAuthenticatedLeaderboard(type, env);
        return withCors(res, cors);
      }

      // ── Wealth Passport (no auth) ───────────────────────
      const passportMatch = pathname.match(/^\/api\/passport\/([^/]+)$/);
      if (passportMatch && request.method === 'GET') {
        const username = decodeURIComponent(passportMatch[1]);
        const res      = await handlePassport(username, env, request);
        return withCors(res, cors);
      }

      // ── Settings routes ─────────────────────────────────
      if (pathname === '/api/users/me' && request.method === 'PATCH') {
        const res = await handleUpdateProfile(request, env);
        return withCors(res, cors);
      }

			if (pathname === '/api/users/me/notifications' && request.method === 'GET') {
				  const res = await handleNotificationRoutes(
			    '/api/notifications/preferences',
			    'GET',
				    request,
				    env,
				  );
		  return withCors(res, cors);
				}

      if (pathname === '/api/users/me/notifications' && request.method === 'PATCH') {
        const res = await handleUpdateNotifications(request, env);
        return withCors(res, cors);
      }

      if (pathname === '/api/users/me/delete' && request.method === 'POST') {
        const res = await handleDeleteAccount(request, env);
        return withCors(res, cors);
      }

      // ── Post cheer route ────────────────────────────────
      const cheerMatch = pathname.match(/^\/api\/posts\/([^/]+)\/cheer$/);
      if (cheerMatch && request.method === 'POST') {
        const res = await handlePostCheer(cheerMatch[1], request, env);
        return withCors(res, cors);
      }

      // ── Standard route dispatch ─────────────────────────
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
        (await handleSocialRoutes(pathname, request.method, request, env))    ||
        (await handleChallengeRoutes(pathname, request.method, request, env)) ||
        (await handleDuelRoutes(pathname, request.method, request, env))      ||
        (await handleWorkRoutes(pathname, request.method, request, env))      ||
        (await handleCrewRoutes(pathname, request.method, request, env))      ||
        (await handleDmRoutes(pathname, request.method, request, env))        ||
        (await handleUserSearchRoutes(pathname, request.method, request, env)) ||
        (await handleSearchRoutes(pathname, request.method, request, env))     ||
        (await handleProfileRoutes(pathname, request.method, request, env))    ||
        (await handleCommentRoutes(pathname, request.method, request, env))    ||
        (await handleNotificationRoutes(pathname, request.method, request, env)) ||
        (await handleAdminRoutes(pathname, request.method, request, env));
      if (!response) {
        response = jsonResponse({ error: 'Route not found' }, 404);
      }

      return withCors(response, cors);

        } catch (err) {
      const requestId =
        request.headers.get('cf-ray') || crypto.randomUUID();

      console.error('[request] Unhandled error:', {
        requestId,
        errorName: err?.name || 'RequestError',
        pathname,
        method: request.method,
      });

      return withCors(
        jsonResponse(
          {
            error: 'Internal server error',
            request_id: requestId,
          },
          500,
        ),
        cors,
      );
    }
  },

    async scheduled(event, env, ctx) {
    const runCronTask = (name, task) =>
      Promise.resolve()
        .then(task)
        .catch((error) => {
          console.error(
            `[cron] ${name} failed:`,
            error?.name || 'ScheduledTaskError',
          );
        });

    ctx.waitUntil(
      runCronTask('event-deliveries', async () => {
        const summary = await processRegisteredEventDeliveries(env.DB);

        if (summary.attempted > 0) {
          console.log('[event-dispatcher] Delivery summary:', {
            consumers: summary.consumers,
            attempted: summary.attempted,
            succeeded: summary.succeeded,
            failed: summary.failed,
            deadLettered: summary.deadLettered,
          });
        }
      }),
    );

    if (event.cron === '*/15 * * * *') {
      ctx.waitUntil(
        runCronTask('duel', () => processDuelCron(env.DB)),
      );
      ctx.waitUntil(
        runCronTask('crew-battle', () => processCrewBattleCron(env.DB)),
      );
      return;
    }

    const dailyTasks = [
      ['leaderboard-snapshot', () => runLeaderboardSnapshot(env)],
      ['exchange-rates', () => updateExchangeRates(env.DB)],
      ['expired-appeals', () => finaliseExpiredAppeals(env.DB)],
      ['expired-subscriptions', () => processExpiredSubscriptions(env.DB)],
      ['expired-challenges', () => expireChallenges(env.DB)],
    ];

    ctx.waitUntil(
      Promise.all(
        dailyTasks.map(([name, task]) => runCronTask(name, task)),
      ),
    );
  },
};

// ── CORS helper ───────────────────────────────────────────────
function withCors(response, cors) {
  if (response.status === 101) return response;
  const newHeaders = new Headers(response.headers);
  Object.entries(cors).forEach(([k, v]) => newHeaders.set(k, v));
  return new Response(response.body, { status: response.status, headers: newHeaders });
}
