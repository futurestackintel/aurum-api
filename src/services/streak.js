// ============================================================
// STREAK TRACKING SERVICE
// Tracks daily login/activity streaks per user.
// Streak feeds into Aurum Score (SCORE_WEIGHTS.streak_day).
// Called on every authenticated request via middleware.
// ============================================================

import { addScoreEvent } from './aurumScore.js';

const STREAK_WINDOW_HOURS = 24; // gap > 24h breaks streak

/**
 * Check and update streak for a user on activity.
 * - If no activity today yet → extend or start streak, award points
 * - If last activity was > 24h ago → reset streak to 1
 * - If already counted today → no-op
 *
 * Returns { streak, extended, broken, points_awarded }
 */
export async function checkStreak(userId, db) {
  const user = await db
    .prepare(`SELECT streak, streak_last_active FROM users WHERE id = ?`)
    .bind(userId)
    .first();

  if (!user) return { streak: 0, extended: false, broken: false, points_awarded: 0 };

  const now         = new Date();
  const lastActive  = user.streak_last_active ? new Date(user.streak_last_active) : null;
  const streak      = user.streak ?? 0;

  // Already counted today (same UTC day) — no-op
  if (lastActive && isSameUTCDay(now, lastActive)) {
    return { streak, extended: false, broken: false, points_awarded: 0 };
  }

  const hoursSinceLast = lastActive
    ? (now - lastActive) / (1000 * 60 * 60)
    : Infinity;

  let newStreak;
  let broken = false;

  if (hoursSinceLast <= STREAK_WINDOW_HOURS) {
    // Consecutive day — extend
    newStreak = streak + 1;
  } else {
    // Gap detected — reset
    newStreak = 1;
    broken = streak > 1; // only flag as broken if they had a real streak
  }

  await db
    .prepare(`UPDATE users SET streak = ?, streak_last_active = ? WHERE id = ?`)
    .bind(newStreak, now.toISOString(), userId)
    .run();

  // Award score points for the new streak day
  const points = await addScoreEvent(
    userId,
    'streak_day',
    null, // use weight table value
    { note: `Streak day ${newStreak}` },
    db,
  );

  return {
    streak:          newStreak,
    extended:        newStreak > 1 && !broken,
    broken,
    points_awarded:  2, // SCORE_WEIGHTS.streak_day
    new_score:       points,
  };
}

/**
 * Streak middleware — attach to every authenticated route.
 * Runs async, does not block the response.
 */
export function streakMiddleware(userId, db) {
  // Fire and forget — don't await in request path
  checkStreak(userId, db).catch(console.error);
}

// ── Helpers ─────────────────────────────────────────────────

function isSameUTCDay(a, b) {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth()    === b.getUTCMonth()    &&
    a.getUTCDate()     === b.getUTCDate()
  );
}