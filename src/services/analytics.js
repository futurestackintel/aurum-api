// analytics.js
// Platform analytics endpoints for the AURUM admin dashboard.
// Covers: DAU, treasury volume, revenue by stream,
// top performers, and leaderboard snapshot reads.

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Daily active users — users who performed any action today.
 * Uses notifications table as a proxy (any event fired = active).
 * Called from GET /admin/analytics/dau
 */
export async function getDailyActiveUsers(env) {
  const todayStart = startOfToday();

  const result = await env.DB.prepare(`
    SELECT COUNT(DISTINCT user_id) as dau
    FROM notifications
    WHERE created_at >= ?
  `).bind(todayStart).first();

  return { date: todayStart.slice(0, 10), dau: result.dau };
}

/**
 * DAU trend for the last N days.
 * Called from GET /admin/analytics/dau/trend?days=30
 */
export async function getDauTrend(env, days = 30) {
  const results = await env.DB.prepare(`
    SELECT
      DATE(created_at) as date,
      COUNT(DISTINCT user_id) as dau
    FROM notifications
    WHERE created_at >= ?
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `).bind(daysAgo(days)).all();

  return results.results;
}

/**
 * Total treasury volume — all funds ever held.
 * Broken down by status: held, released, forfeited.
 * Called from GET /admin/analytics/treasury
 */
export async function getTreasuryStats(env) {
  const result = await env.DB.prepare(`
    SELECT
      status,
      COUNT(*)          as count,
      SUM(total_held_cents)   as total_cents
    FROM treasury_ledger
    GROUP BY status
  `).all();

  const breakdown = {};
  let grandTotal = 0;

  for (const row of result.results) {
    breakdown[row.status] = {
      count:       row.count,
      total_cents: row.total_cents ?? 0,
      total_usd:   centsToDollars(row.total_cents ?? 0),
    };
    grandTotal += row.total_cents ?? 0;
  }

  return {
    breakdown,
    grand_total_cents: grandTotal,
    grand_total_usd:   centsToDollars(grandTotal),
  };
}

/**
 * Revenue breakdown by stream.
 * Streams: tip fees, challenge pool fees, subscriptions, boost tokens.
 * Called from GET /admin/analytics/revenue
 * @param {'today'|'week'|'month'|'alltime'} period
 */
export async function getRevenueBreakdown(env, period = 'month') {
  const since = periodToDate(period);

  // Tip fees (5% of each tip)
  const tipFees = await env.DB.prepare(`
    SELECT
      COUNT(*)        as count,
      SUM(platform_fee_cents)  as total_cents
    FROM tips
    WHERE created_at >= ?
  `).bind(since).first();

  // Challenge pool fees (5% of each pool)
  const challengeFees = await env.DB.prepare(`
    SELECT
      COUNT(*)                          as count,
      SUM(pool_total_cents * 0.05)      as total_cents
    FROM challenges
    WHERE status     = 'completed'
      AND created_at >= ?
  `).bind(since).first();

  // Subscription revenue
  const subscriptions = await env.DB.prepare(`
    SELECT
      tier,
      COUNT(*) as count
    FROM subscriptions
    WHERE status     = 'active'
      AND created_at >= ?
    GROUP BY tier
  `).bind(since).all();

  // Boost token revenue
  const boosts = await env.DB.prepare(`
    SELECT
      COUNT(*)                  as count,
      SUM(amount_paid_cents)    as total_cents
    FROM boost_tokens
    WHERE created_at >= ?
  `).bind(since).first();

  // Calculate subscription revenue from tier prices
  const SUB_PRICES = { contender: 900, sovereign: 2900 }; // cents
  let subTotalCents = 0;
  const subBreakdown = {};
  for (const row of subscriptions.results) {
    const tierRevenue = (SUB_PRICES[row.tier] ?? 0) * row.count;
    subBreakdown[row.tier] = { count: row.count, total_cents: tierRevenue };
    subTotalCents += tierRevenue;
  }

  const streams = {
    tip_fees: {
      count:       tipFees.count ?? 0,
      total_cents: tipFees.total_cents ?? 0,
      total_usd:   centsToDollars(tipFees.total_cents ?? 0),
    },
    challenge_fees: {
      count:       challengeFees.count ?? 0,
      total_cents: Math.round(challengeFees.total_cents ?? 0),
      total_usd:   centsToDollars(Math.round(challengeFees.total_cents ?? 0)),
    },
    subscriptions: {
      breakdown:   subBreakdown,
      total_cents: subTotalCents,
      total_usd:   centsToDollars(subTotalCents),
    },
    boost_tokens: {
      count:       boosts.count ?? 0,
      total_cents: boosts.total_cents ?? 0,
      total_usd:   centsToDollars(boosts.total_cents ?? 0),
    },
  };

  const grandTotal =
    streams.tip_fees.total_cents +
    streams.challenge_fees.total_cents +
    streams.subscriptions.total_cents +
    streams.boost_tokens.total_cents;

  return {
    period,
    since,
    streams,
    grand_total_cents: grandTotal,
    grand_total_usd:   centsToDollars(grandTotal),
  };
}

/**
 * Top performers across all three leaderboard types.
 * Reads from the latest leaderboard snapshots.
 * Called from GET /admin/analytics/top-performers
 */
export async function getTopPerformers(env, limit = 10) {
  const boardTypes = ['most_generous', 'highest_earner', 'most_wins', 'aurum_score'];
  const result = {};

  for (const boardType of boardTypes) {
    // Get the most recent period_key for this board
    const latest = await env.DB.prepare(`
      SELECT period_key FROM leaderboard_snapshots
      WHERE board_type = ?
        AND period     = 'daily'
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(boardType).first();

    if (!latest) {
      result[boardType] = [];
      continue;
    }

    const rows = await env.DB.prepare(`
      SELECT
        ls.rank,
        ls.score,
        ls.display_name,
        ls.league_at_snapshot,
        ls.user_id,
        ls.avatar_url
      FROM leaderboard_snapshots ls
      WHERE ls.board_type  = ?
        AND ls.period      = 'daily'
        AND ls.period_key  = ?
      ORDER BY ls.rank ASC
      LIMIT ?
    `).bind(boardType, latest.period_key, limit).all();

    result[boardType] = rows.results;
  }

  return result;
}

/**
 * Platform-wide summary stats.
 * Single endpoint for admin dashboard overview card.
 * Called from GET /admin/analytics/summary
 */
export async function getPlatformSummary(env) {
  const [
    totalUsers,
    activeSubscriptions,
    pendingFlags,
    pendingBadgeRequests,
    totalTips,
    totalChallenges,
  ] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) as count FROM users`).first(),
    env.DB.prepare(`SELECT COUNT(*) as count FROM subscriptions WHERE status = 'active'`).first(),
    env.DB.prepare(`SELECT COUNT(*) as count FROM moderation_flags WHERE status = 'pending'`).first(),
    env.DB.prepare(`SELECT COUNT(*) as count FROM badge_requests WHERE status = 'pending'`).first(),
    env.DB.prepare(`SELECT COUNT(*) as count, SUM(amount_cents) as volume FROM tips`).first(),
    env.DB.prepare(`SELECT COUNT(*) as count FROM challenges`).first(),
  ]);

  return {
    total_users:             totalUsers.count,
    active_subscriptions:    activeSubscriptions.count,
    pending_flags:           pendingFlags.count,
    pending_badge_requests:  pendingBadgeRequests.count,
    total_tips:              totalTips.count,
    tip_volume_cents:        totalTips.volume ?? 0,
    tip_volume_usd:          centsToDollars(totalTips.volume ?? 0),
    total_challenges:        totalChallenges.count,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function centsToDollars(cents) {
  return (cents / 100).toFixed(2);
}

function startOfToday() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function periodToDate(period) {
  switch (period) {
    case 'today': return startOfToday();
    case 'week':  return daysAgo(7);
    case 'month': return daysAgo(30);
    default:      return new Date(0).toISOString(); // alltime
  }
}
