// ============================================================
// AURUM Worker Entry Point — Module Chat F
// Added: crew routes, settings routes, post cheer route,
//        KYC gate on withdrawals
// Fix 2: resolve internal DB user id from Clerk id in
//        handleUpdateProfile / handleUpdateNotifications /
//        handleDeleteAccount / handlePostCheer / KYC withdrawal gate
// Fix 3: temporary admin-only manual leaderboard snapshot
//        trigger — POST /api/admin/run-snapshot
//        Admin check now reads env.ADMIN_USER_IDS (wrangler.toml)
//        instead of a hardcoded constant.
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
import { handleCrewRoutes }             from './routes/crew.js';
import { runLeaderboardSnapshot }       from './services/leaderboardCron.js';
import { updateExchangeRates }          from './services/currency.js';
import { finaliseExpiredAppeals }       from './services/proofOfStake.js';
import { requireAuth }                  from './middleware/auth.js';
import { addScoreEvent }                from './services/aurumScore.js';

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

// ── Wealth Passport ───────────────────────────────────────────
async function handlePassport(username, env) {
  const db = env.DB;

  const user = await db
    .prepare(`
      SELECT id, username, league, aurum_score, streak_current, created_at,
             hide_aurum_score, hide_league, profile_visibility
      FROM users
      WHERE username = ? AND account_deleted = 0
    `)
    .bind(username)
    .first();

  if (!user)                                  return jsonResponse({ error: 'User not found' }, 404);
  if (user.profile_visibility === 'private')  return jsonResponse({ error: 'This profile is private' }, 403);

  const { results: badgeRows } = await db
    .prepare(`
      SELECT badge_type, awarded_at
      FROM user_badges
      WHERE user_id = ?
      ORDER BY awarded_at ASC
    `)
    .bind(user.id)
    .all();

  const winsRow = await db
    .prepare(`
      SELECT COUNT(*) as count FROM challenges
      WHERE winner_id = ? AND status = 'completed'
    `)
    .bind(user.id)
    .first();

  const tipsRow = await db
    .prepare(`
      SELECT COALESCE(SUM(amount_cents), 0) as total
      FROM tips
      WHERE sender_id = ? AND status = 'completed'
    `)
    .bind(user.id)
    .first();

  const today = new Date().toISOString().slice(0, 10);

  let rankRow = await db
    .prepare(`
      SELECT rank FROM leaderboard_snapshots
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
        SELECT rank FROM leaderboard_snapshots
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
    league:              user.hide_league      ? null : user.league,
    aurum_score:         user.hide_aurum_score ? null : user.aurum_score,
    badges:              badgeRows,
    challenge_wins:      winsRow?.count         ?? 0,
    total_tips_given:    (tipsRow?.total ?? 0)  / 100,
    streak:              user.streak_current    ?? 0,
    member_since:        user.created_at,
    rank_on_leaderboard: rankRow?.rank          ?? null,
  });
}

// ── Settings: PATCH /api/users/me ────────────────────────────
// Fix 2: requireAuth returns the Clerk id under user.id — resolve
// the internal DB user id before running any query against `users`.
async function handleUpdateProfile(request, env) {
  const db   = env.DB;
  const user = await requireAuth(request, env);
  if (user.error) return jsonResponse({ error: user.error }, 401);

  const dbUser = await db
    .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
    .bind(user.id)
    .first();

  if (!dbUser) return jsonResponse({ error: 'User not found' }, 404);

  const body = await request.json();
  const {
    username,
    stealth_mode,
    profile_visibility,
    hide_aurum_score,
    hide_league,
  } = body;

  // Validate profile_visibility if provided
  const validVisibility = ['public', 'members', 'private'];
  if (profile_visibility && !validVisibility.includes(profile_visibility)) {
    return jsonResponse({ error: `profile_visibility must be one of: ${validVisibility.join(', ')}` }, 400);
  }

  // Validate username if provided
  if (username !== undefined) {
    if (typeof username !== 'string' || username.trim().length < 3) {
      return jsonResponse({ error: 'Username must be at least 3 characters' }, 400);
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username.trim())) {
      return jsonResponse({ error: 'Username can only contain letters, numbers and underscores' }, 400);
    }
    // Check uniqueness
    const taken = await db
      .prepare(`SELECT id FROM users WHERE username = ? AND id != ?`)
      .bind(username.trim(), dbUser.id)
      .first();
    if (taken) return jsonResponse({ error: 'Username is already taken' }, 400);
  }

  const now    = new Date().toISOString();
  const fields = [];
  const values = [];

  if (username          !== undefined) { fields.push('username = ?');           values.push(username.trim()); }
  if (stealth_mode      !== undefined) { fields.push('stealth_mode = ?');        values.push(stealth_mode ? 1 : 0); }
  if (profile_visibility !== undefined){ fields.push('profile_visibility = ?');  values.push(profile_visibility); }
  if (hide_aurum_score  !== undefined) { fields.push('hide_aurum_score = ?');    values.push(hide_aurum_score ? 1 : 0); }
  if (hide_league       !== undefined) { fields.push('hide_league = ?');         values.push(hide_league ? 1 : 0); }

  if (fields.length === 0) return jsonResponse({ error: 'No valid fields provided' }, 400);

  fields.push('updated_at = ?');
  values.push(now);
  values.push(dbUser.id);

  await db
    .prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  const updated = await db
    .prepare(`
      SELECT username, stealth_mode, profile_visibility,
             hide_aurum_score, hide_league
      FROM users WHERE id = ?
    `)
    .bind(dbUser.id)
    .first();

  return jsonResponse({ updated: true, user: updated });
}

// ── Settings: PATCH /api/users/me/notifications ──────────────
// Fix 2: resolve internal DB user id from Clerk id.
async function handleUpdateNotifications(request, env) {
  const db   = env.DB;
  const user = await requireAuth(request, env);
  if (user.error) return jsonResponse({ error: user.error }, 401);

  const dbUser = await db
    .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
    .bind(user.id)
    .first();

  if (!dbUser) return jsonResponse({ error: 'User not found' }, 404);

  const body = await request.json();
  const {
    tips_received,
    challenge_updates,
    duel_challenges,
    league_promotions,
    badge_awards,
    weekly_summary,
  } = body;

  const now = new Date().toISOString();

  // Upsert notification preferences
  const existing = await db
    .prepare(`SELECT id FROM notification_preferences WHERE user_id = ?`)
    .bind(dbUser.id)
    .first();

  if (existing) {
    const fields = [];
    const values = [];

    if (tips_received      !== undefined) { fields.push('tips_received = ?');      values.push(tips_received      ? 1 : 0); }
    if (challenge_updates  !== undefined) { fields.push('challenge_updates = ?');   values.push(challenge_updates  ? 1 : 0); }
    if (duel_challenges    !== undefined) { fields.push('duel_challenges = ?');     values.push(duel_challenges    ? 1 : 0); }
    if (league_promotions  !== undefined) { fields.push('league_promotions = ?');   values.push(league_promotions  ? 1 : 0); }
    if (badge_awards       !== undefined) { fields.push('badge_awards = ?');        values.push(badge_awards       ? 1 : 0); }
    if (weekly_summary     !== undefined) { fields.push('weekly_summary = ?');      values.push(weekly_summary     ? 1 : 0); }

    if (fields.length === 0) return jsonResponse({ error: 'No valid fields provided' }, 400);

    fields.push('updated_at = ?');
    values.push(now);
    values.push(dbUser.id);

    await db
      .prepare(`UPDATE notification_preferences SET ${fields.join(', ')} WHERE user_id = ?`)
      .bind(...values)
      .run();
  } else {
    await db
      .prepare(`
        INSERT INTO notification_preferences
          (id, user_id, tips_received, challenge_updates, duel_challenges,
           league_promotions, badge_awards, weekly_summary, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        crypto.randomUUID(),
        dbUser.id,
        tips_received      !== undefined ? (tips_received      ? 1 : 0) : 1,
        challenge_updates  !== undefined ? (challenge_updates  ? 1 : 0) : 1,
        duel_challenges    !== undefined ? (duel_challenges    ? 1 : 0) : 1,
        league_promotions  !== undefined ? (league_promotions  ? 1 : 0) : 1,
        badge_awards       !== undefined ? (badge_awards       ? 1 : 0) : 1,
        weekly_summary     !== undefined ? (weekly_summary     ? 1 : 0) : 1,
        now,
        now,
      )
      .run();
  }

  const prefs = await db
    .prepare(`SELECT * FROM notification_preferences WHERE user_id = ?`)
    .bind(dbUser.id)
    .first();

  return jsonResponse({ updated: true, preferences: prefs });
}

// ── Settings: POST /api/users/me/delete ──────────────────────
// Fix 2: resolve internal DB user id from Clerk id for the DB
// update. user.clerkId is kept as-is for the Clerk ban API call.
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
// Fix 2 (Q4): resolve internal DB user id from Clerk id.
async function handlePostCheer(postId, request, env) {
  const db   = env.DB;
  const user = await requireAuth(request, env);
  if (user.error) return jsonResponse({ error: user.error }, 401);

  const dbUser = await db
    .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
    .bind(user.id)
    .first();

  if (!dbUser) return jsonResponse({ error: 'User not found' }, 404);

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

  // Notify post author
  if (post.user_id !== dbUser.id) {
    await db
      .prepare(`
        INSERT INTO notifications
          (id, user_id, type, title, body, reference_id, created_at)
        VALUES (?, ?, 'post_cheer', 'Someone cheered your post', 'Your Wealth Journey post received a cheer!', ?, ?)
      `)
      .bind(crypto.randomUUID(), post.user_id, postId, now)
      .run();
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

// ── Fix 3: manual leaderboard snapshot trigger (admin only) ──
// Temporary endpoint. Remove after the leaderboard_snapshots
// table has been confirmed populated by a successful manual run.
// Admin check reads env.ADMIN_USER_IDS (wrangler.toml) — supports
// a single id or a comma-separated list.
async function handleRunSnapshotAdmin(request, env) {
  const user = await requireAuth(request, env);
  if (user.error) return jsonResponse({ error: user.error }, 401);

  const adminIds = (env.ADMIN_USER_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);

  if (!adminIds.includes(user.id)) {
    return jsonResponse({ error: 'Forbidden' }, 403);
  }

  try {
    await runLeaderboardSnapshot(env);
    return jsonResponse({
      triggered: true,
      message:   'Leaderboard snapshot run complete. Check leaderboard_snapshots table.',
      ran_at:    new Date().toISOString(),
    });
  } catch (err) {
    console.error('[handleRunSnapshotAdmin] Snapshot failed:', err);
    return jsonResponse({ error: 'Snapshot run failed', detail: err.message }, 500);
  }
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

// ── Helper ────────────────────────────────────────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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

      if (pathname.startsWith('/api/posts') && request.method === 'POST') {
        const rl = await checkRateLimit(ip, 'posts', 5, 60, env);
        if (rl.limited) return rateLimitResponse(rl.retryAfter, cors);
      }

      // ── KYC gate on withdrawals ─────────────────────────
      // Fix 2 (Q4): resolve internal DB user id from Clerk id
      // before passing into checkKycGate.
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

      // ── Public leaderboard (no auth) ────────────────────
      if (pathname === '/leaderboard/public' && request.method === 'GET') {
        const res = await handlePublicLeaderboard(env);
        return withCors(res, cors);
      }

      // ── Wealth Passport (no auth) ───────────────────────
      const passportMatch = pathname.match(/^\/api\/passport\/([^/]+)$/);
      if (passportMatch && request.method === 'GET') {
        const username = decodeURIComponent(passportMatch[1]);
        const res      = await handlePassport(username, env);
        return withCors(res, cors);
      }

      // ── Settings routes ─────────────────────────────────
      if (pathname === '/api/users/me' && request.method === 'PATCH') {
        const res = await handleUpdateProfile(request, env);
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

      // ── Fix 3: manual leaderboard snapshot trigger (admin) ──
      if (pathname === '/api/admin/run-snapshot' && request.method === 'POST') {
        const res = await handleRunSnapshotAdmin(request, env);
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
        (await handleChallengeRoutes(pathname, request.method, request, env)) ||
        (await handleDuelRoutes(pathname, request.method, request, env))      ||
        (await handleCrewRoutes(pathname, request.method, request, env))      ||
        (await handleAdminRoutes(pathname, request.method, request, env));

      if (!response) {
        response = jsonResponse({ error: 'Route not found' }, 404);
      }

      return withCors(response, cors);

    } catch (err) {
      console.error('Worker error:', err);
      return new Response(
        JSON.stringify({ error: 'Internal server error' }),
        {
          status: 500,
          headers: { ...cors, 'Content-Type': 'application/json' },
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
        processExpiredSubscriptions(env.DB),
      ]),
    );
  },
};

// ── CORS helper ───────────────────────────────────────────────
function withCors(response, cors) {
  const newHeaders = new Headers(response.headers);
  Object.entries(cors).forEach(([k, v]) => newHeaders.set(k, v));
  return new Response(response.body, { status: response.status, headers: newHeaders });
}
