// ============================================================
// WEALTH LEAGUE ASSIGNMENT SERVICE
// Auto-assigns league tier based on Aurum Score.
// Called after every addScoreEvent() call.
// Writes league changes to users table + league_history log.
// ============================================================

import { scoreToLeague } from './aurumScore.js';

/**
 * Evaluate a user's current score and assign the correct league.
 * If league changed → write to users table + log the promotion/demotion.
 *
 * Returns { previous_league, new_league, changed, score }
 */
export async function assignLeague(userId, db) {
  const user = await db
    .prepare(`SELECT aurum_score, league FROM users WHERE id = ?`)
    .bind(userId)
    .first();

  if (!user) throw new Error(`User ${userId} not found`);

  const newLeague      = scoreToLeague(user.aurum_score);
  const previousLeague = user.league;
  const changed        = newLeague !== previousLeague;

  if (changed) {
    // Update the user row
    await db
      .prepare(`UPDATE users SET league = ? WHERE id = ?`)
      .bind(newLeague, userId)
      .run();

    // Log the league change for history / admin visibility
    await db
      .prepare(`
        INSERT INTO league_history
          (user_id, previous_league, new_league, score_at_change, changed_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .bind(
        userId,
        previousLeague,
        newLeague,
        user.aurum_score,
        new Date().toISOString(),
      )
      .run();
  }

  return {
    previous_league: previousLeague,
    new_league:      newLeague,
    changed,
    score:           user.aurum_score,
  };
}

/**
 * Batch recalculate leagues for ALL users.
 * Admin-only. Used for corrections after weight table changes.
 * Returns count of users whose league changed.
 */
export async function recalculateAllLeagues(db) {
  const { results: users } = await db
    .prepare(`SELECT id FROM users`)
    .all();

  let changed = 0;
  for (const user of users) {
    const result = await assignLeague(user.id, db);
    if (result.changed) changed++;
  }

  return { total: users.length, changed };
}