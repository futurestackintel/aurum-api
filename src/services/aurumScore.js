// ============================================================
// AURUM SCORE ENGINE
// Calculates composite reputation score and writes score events
// Called by: posts, tips, challenges, streaks, badges
// Auto-triggers: league assignment after every score change
// ============================================================

// Lazy import to avoid circular dependency
// league.js imports scoreToLeague from here — we import assignLeague from there
let _assignLeague = null;
async function getLeagueAssigner() {
  if (!_assignLeague) {
    const mod = await import('./league.js');
    _assignLeague = mod.assignLeague;
  }
  return _assignLeague;
}

// Weight table — locked. Change here affects the entire platform.
const SCORE_WEIGHTS = {
  verified_achievement_post:  50,   // highest — real provable wins
  challenge_win:              40,
  tip_sent:                    5,   // per tip (generosity)
  tip_received_reaction:       3,   // per reaction/tip received
  streak_day:                  2,   // per active streak day
  account_age_week:            1,   // per week of account age
  badge_earned:               20,   // one-time per badge
  post_flagged_fake:         -60,   // stake slashed + score penalty
  challenge_forfeit:         -20,
};

// League thresholds — locked. Adjust only here.
const LEAGUE_THRESHOLDS = {
  Sovereign: 2000,
  Gold:       800,
  Silver:     300,
  Bronze:       0,
};

/**
 * Recalculate a user's full Aurum Score from the events table.
 * Source of truth = aurum_score_events. users.aurum_score is a cache.
 */
export async function recalculateScore(userId, db) {
  const { results } = await db
    .prepare(`SELECT SUM(delta) as total FROM aurum_score_events WHERE user_id = ?`)
    .bind(userId)
    .all();

  const raw = results[0]?.total ?? 0;
  const score = Math.max(0, Math.round(raw)); // score never goes below 0

  await db
    .prepare(`UPDATE users SET aurum_score = ? WHERE id = ?`)
    .bind(score, userId)
    .run();

  return score;
}

/**
 * Add a score event and update the cached score on the user row.
 * Returns the new score.
 *
 * @param {string} userId
 * @param {string} eventType   — key from SCORE_WEIGHTS or custom
 * @param {number|null} delta  — if null, looked up from SCORE_WEIGHTS
 * @param {object} meta        — { post_id, challenge_id, tip_id, note }
 * @param {D1Database} db
 */
export async function addScoreEvent(userId, eventType, delta, meta = {}, db) {
  const points = delta !== null && delta !== undefined
    ? delta
    : (SCORE_WEIGHTS[eventType] ?? 0);

  if (points === 0) return await recalculateScore(userId, db);

  await db
    .prepare(`
      INSERT INTO aurum_score_events
        (user_id, event_type, delta, post_id, challenge_id, tip_id, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      userId,
      eventType,
      points,
      meta.post_id    ?? null,
      meta.challenge_id ?? null,
      meta.tip_id     ?? null,
      meta.note       ?? null,
      new Date().toISOString(),
    )
    .run();

  const newScore = await recalculateScore(userId, db);

  // Auto-assign league after every score change
  const assignLeague = await getLeagueAssigner();
  await assignLeague(userId, db).catch(console.error);

  // Auto-check and award badges after every score change
  const { checkAndAwardBadges } = await import('./badge.js');
  await checkAndAwardBadges(userId, db).catch(console.error);

  return newScore;
}

/**
 * Derive league name from a score integer.
 */
export function scoreToLeague(score) {
  if (score >= LEAGUE_THRESHOLDS.Sovereign) return 'Sovereign';
  if (score >= LEAGUE_THRESHOLDS.Gold)      return 'Gold';
  if (score >= LEAGUE_THRESHOLDS.Silver)    return 'Silver';
  return 'Bronze';
}

export { SCORE_WEIGHTS, LEAGUE_THRESHOLDS };