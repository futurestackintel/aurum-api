// leaderboardCron.js
// Cron job that writes daily/weekly/monthly leaderboard snapshots.
// Triggered by Cloudflare Workers cron scheduler.
// Reads live data from users + tips + challenges tables,
// then writes ranked rows to leaderboard_snapshots.
//
// Fix 3: buildMostGenerousQuery / buildHighestEarnerQuery referenced
// a non-existent column `t.amount` (confirmed via
// PRAGMA table_info(tips) — the real column is `amount_cents`).
// This caused those two queries to throw on every cron run, which
// rejected the shared Promise.all and silently prevented ALL boards —
// plus awardAccountAgeWeeks — from ever completing. Fixed the column
// name, added the missing `status = 'completed'` filter (confirmed
// present on the tips table, and already used elsewhere in the
// codebase for tip totals), converted cents to dollars for display
// (score is stored in dollars, matching handlePassport's convention),
// and isolated each board's snapshot call so one board failing can
// no longer block the others.

// ── Entry point (called from worker index.js scheduled handler) ───────────────

export async function runLeaderboardSnapshot(env) {
  const now = new Date();

  const periods = buildPeriods(now);

  await Promise.all([
    snapshotBoard(env, 'most_generous',  periods, buildMostGenerousQuery)
      .catch(err => console.error('[leaderboardCron] most_generous snapshot failed:', err)),
    snapshotBoard(env, 'highest_earner', periods, buildHighestEarnerQuery)
      .catch(err => console.error('[leaderboardCron] highest_earner snapshot failed:', err)),
    snapshotBoard(env, 'most_wins',      periods, buildMostWinsQuery)
      .catch(err => console.error('[leaderboardCron] most_wins snapshot failed:', err)),
    snapshotBoard(env, 'aurum_score',    periods, buildAurumScoreQuery)
      .catch(err => console.error('[leaderboardCron] aurum_score snapshot failed:', err)),
  ]);

  // Fix 3 — award account_age_week points to all eligible users
  await awardAccountAgeWeeks(env);

  console.log(`[leaderboardCron] Snapshot complete at ${now.toISOString()}`);
}

// ── Core snapshot writer ──────────────────────────────────────────────────────

async function snapshotBoard(env, boardType, periods, queryBuilder) {
  for (const { period, periodKey, since } of periods) {
    // Only run alltime on Sundays to avoid heavy queries daily
    if (period === 'alltime' && new Date().getUTCDay() !== 0) continue;

    const rows = await env.DB.prepare(queryBuilder(since))
      .bind(...(since ? [since] : []))
      .all();

    if (!rows.results.length) continue;

    // Delete existing snapshot for this board + period + periodKey
    // so re-runs don't duplicate rows
    await env.DB.prepare(`
      DELETE FROM leaderboard_snapshots
      WHERE board_type = ?
        AND period     = ?
        AND period_key = ?
    `).bind(boardType, period, periodKey).run();

    // Batch insert new snapshot rows
    const insertStmt = env.DB.prepare(`
      INSERT INTO leaderboard_snapshots
        (id, board_type, league, period, period_key,
         user_id, rank, score, display_name, avatar_url, league_at_snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const batch = rows.results.map((row, index) =>
      insertStmt.bind(
        crypto.randomUUID(),
        boardType,
        row.league ?? 'all',
        period,
        periodKey,
        row.user_id,
        index + 1,
        row.score,
        row.display_name,
        row.avatar_url ?? null,
        row.league ?? null,
      )
    );

    await env.DB.batch(batch);
  }
}

// ── Fix 3 — Account age week scoring ─────────────────────────────────────────
// Runs after every leaderboard snapshot (daily cron).
// For each user, calculates how many complete weeks old their account is.
// Compares against last awarded week stored in KV.
// Awards 1 point per new week via addScoreEvent.

async function awardAccountAgeWeeks(env) {
  const { addScoreEvent } = await import('./aurumScore.js');
  const db  = env.DB;
  const kv  = env.KV;
  const now = Date.now();

  const { results: users } = await db
    .prepare(`SELECT id, created_at FROM users WHERE created_at IS NOT NULL`)
    .all();

  for (const user of users) {
    try {
      const accountCreated  = new Date(user.created_at).getTime();
      const msPerWeek       = 7 * 24 * 60 * 60 * 1000;
      const weeksOld        = Math.floor((now - accountCreated) / msPerWeek);

      if (weeksOld < 1) continue; // account not yet a week old

      const kvKey           = `account_age_week:${user.id}`;
      const stored          = await kv.get(kvKey);
      const lastAwardedWeek = stored ? parseInt(stored, 10) : 0;
      const newWeeks        = weeksOld - lastAwardedWeek;

      if (newWeeks < 1) continue; // no new weeks to award

      // Award 1 point per new week — each week gets its own event for auditability
      for (let w = 1; w <= newWeeks; w++) {
        await addScoreEvent(
          user.id,
          'account_age_week',
          null, // uses SCORE_WEIGHTS value (1)
          { note: `Account age week ${lastAwardedWeek + w}` },
          db,
        );
      }

      // Update KV with the new last awarded week
      await kv.put(kvKey, String(weeksOld));

    } catch (err) {
      console.error(`[awardAccountAgeWeeks] Failed for user ${user.id}:`, err);
      // Continue — don't let one user failure abort the whole batch
    }
  }

  console.log(`[leaderboardCron] account_age_week awards complete for ${users.length} users`);
}

// ── Period builders ───────────────────────────────────────────────────────────

function buildPeriods(now) {
  return [
    {
      period:    'daily',
      periodKey: now.toISOString().slice(0, 10),
      since:     startOfDay(now),
    },
    {
      period:    'weekly',
      periodKey: getWeekKey(now),
      since:     startOfWeek(now),
    },
    {
      period:    'monthly',
      periodKey: now.toISOString().slice(0, 7),
      since:     startOfMonth(now),
    },
    {
      period:    'alltime',
      periodKey: 'alltime',
      since:     null,
    },
  ];
}

// ── Query builders ────────────────────────────────────────────────────────────
// Each returns a SQL string.
// If since is not null, caller binds it as first param.
// Fix 4 — all queries use CASE WHEN stealth_mode to mask display_name.
// Fix 3 — corrected `t.amount` -> `t.amount_cents` (confirmed via
// PRAGMA table_info(tips)), added `t.status = 'completed'` filter
// (confirmed column exists), and convert cents to dollars for score.

function buildMostGenerousQuery(since) {
  const conditions = [`t.status = 'completed'`];
  if (since) conditions.push(`t.created_at >= ?`);
  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  return `
    SELECT
      t.sender_id                                       as user_id,
      CASE WHEN u.stealth_mode = 1
        THEN 'Anonymous'
        ELSE u.username
      END                                               as display_name,
      u.avatar_url,
      u.league,
      CAST(SUM(t.amount_cents) / 100.0 AS REAL)         as score
    FROM tips t
    JOIN users u ON u.id = t.sender_id
    ${whereClause}
    GROUP BY t.sender_id
    ORDER BY score DESC
    LIMIT 100
  `;
}

function buildHighestEarnerQuery(since) {
  const conditions = [`t.status = 'completed'`];
  if (since) conditions.push(`t.created_at >= ?`);
  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  return `
    SELECT
      t.receiver_id                                     as user_id,
      CASE WHEN u.stealth_mode = 1
        THEN 'Anonymous'
        ELSE u.username
      END                                               as display_name,
      u.avatar_url,
      u.league,
      CAST(SUM(t.amount_cents) / 100.0 AS REAL)         as score
    FROM tips t
    JOIN users u ON u.id = t.receiver_id
    ${whereClause}
    GROUP BY t.receiver_id
    ORDER BY score DESC
    LIMIT 100
  `;
}

function buildMostWinsQuery(since) {
  const baseWhere  = `WHERE dc.status = 'completed' AND dc.winner_id IS NOT NULL`;
  const sinceClause = since ? `AND dc.updated_at >= ?` : '';
  return `
    SELECT
      dc.winner_id                                      as user_id,
      CASE WHEN u.stealth_mode = 1
        THEN 'Anonymous'
        ELSE u.username
      END                                               as display_name,
      u.avatar_url,
      u.league,
      COUNT(*)                                          as score
    FROM drop_circles dc
    JOIN users u ON u.id = dc.winner_id
    ${baseWhere}
    ${sinceClause}
    GROUP BY dc.winner_id
    ORDER BY score DESC
    LIMIT 100
  `;
}

function buildAurumScoreQuery(since) {
  return `
    SELECT
      u.id                                              as user_id,
      CASE WHEN u.stealth_mode = 1
        THEN 'Anonymous'
        ELSE u.username
      END                                               as display_name,
      u.avatar_url,
      u.league,
      u.aurum_score                                     as score
    FROM users u
    WHERE u.aurum_score > 0
    ORDER BY score DESC
    LIMIT 100
  `;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function startOfDay(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function startOfWeek(date) {
  const d   = new Date(date);
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  d.setUTCDate(diff);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function startOfMonth(date) {
  const d = new Date(date);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function getWeekKey(date) {
  const d           = new Date(date);
  const year        = d.getUTCFullYear();
  const startOfYear = new Date(Date.UTC(year, 0, 1));
  const weekNum     = Math.ceil(
    ((d - startOfYear) / 86400000 + startOfYear.getUTCDay() + 1) / 7,
  );
  return `${year}-W${String(weekNum).padStart(2, '0')}`;
}
