// ============================================================
// BADGE ASSIGNMENT ENGINE
// Auto-awards badges when score/achievement thresholds are met.
// Idempotent — re-checking never double-awards.
// Feeds badge_earned points back into Aurum Score.
// Called after every score update.
// ============================================================

import { addScoreEvent } from './aurumScore.js';

// Badge definitions — locked.
// type must match badge_type column in badges table.
export const BADGE_DEFINITIONS = [
  {
    type:             'verified_builder',
    label:            '🥉 Verified Builder',
    description:      'Owns a verified business',
    score_threshold:  100,
    manual_verify:    true,  // requires admin approval
  },
  {
    type:             'verified_founder',
    label:            '🥈 Verified Founder',
    description:      'Verified startup or exit',
    score_threshold:  400,
    manual_verify:    true,
  },
  {
    type:             'verified_millionaire',
    label:            '🥇 Verified Millionaire',
    description:      'Verified high net worth',
    score_threshold:  1000,
    manual_verify:    true,
  },
  {
    type:             'sovereign',
    label:            '💎 Sovereign',
    description:      'Platform elite status',
    score_threshold:  2000,
    manual_verify:    false, // auto-awarded when score hits Sovereign league
  },
  // Build 1 — Founding Member badge
  {
    type:             'founding_member',
    label:            '⚡ Founding Member',
    description:      'One of the first 100 AURUM members',
    score_threshold:  0,
    manual_verify:    false, // awarded by webhook on payment confirmation
  },
];

// Fix 6 — Display priority order for getUserBadges.
// Lower number = higher priority = appears first.
const BADGE_DISPLAY_PRIORITY = {
  sovereign:            1,
  verified_millionaire: 2,
  verified_founder:     3,
  verified_builder:     4,
  founding_member:      5,
};

/**
 * Check and auto-award badges a user qualifies for.
 * Only awards badges where manual_verify = false.
 * Manual badges are awarded via adminAwardBadge().
 * founding_member is awarded directly by the webhook — not by score check.
 *
 * Fix 4 — Sovereign badge additionally requires an active sovereign subscription.
 *
 * Returns array of newly awarded badges.
 */
export async function checkAndAwardBadges(userId, db) {
  const user = await db
    .prepare(`SELECT aurum_score, league FROM users WHERE id = ?`)
    .bind(userId)
    .first();

  if (!user) return [];

  // Get badges user already has
  const { results: existing } = await db
    .prepare(`SELECT badge_type FROM badges WHERE user_id = ?`)
    .bind(userId)
    .all();

  const alreadyHas   = new Set(existing.map(b => b.badge_type));
  const newlyAwarded = [];

  for (const badge of BADGE_DEFINITIONS) {
    // Skip if already awarded
    if (alreadyHas.has(badge.type)) continue;

    // Skip manual verification badges
    if (badge.manual_verify) continue;

    // Skip founding_member here — awarded only by webhook on payment
    if (badge.type === 'founding_member') continue;

    // Check score threshold
    if (user.aurum_score < badge.score_threshold) continue;

    // Fix 4 — Sovereign badge requires active sovereign subscription
    // Score alone is not enough — must also hold a confirmed subscription
    if (badge.type === 'sovereign') {
      const activeSub = await db
        .prepare(`
          SELECT id FROM subscriptions
          WHERE user_id = ?
            AND status  = 'active'
            AND tier    = 'sovereign'
          LIMIT 1
        `)
        .bind(userId)
        .first();

      if (!activeSub) continue; // score qualifies but no active subscription — skip
    }

    await awardBadge(userId, badge.type, db);
    newlyAwarded.push(badge);
  }

  return newlyAwarded;
}

/**
 * Award a specific badge to a user.
 * Idempotent — safe to call multiple times.
 * Adds badge_earned score event on first award only.
 */
export async function awardBadge(userId, badgeType, db) {
  // Check if already awarded
  const existing = await db
    .prepare(`SELECT id FROM badges WHERE user_id = ? AND badge_type = ?`)
    .bind(userId, badgeType)
    .first();

  if (existing) return { awarded: false, reason: 'Already has badge' };

  const now = new Date().toISOString();

  // Insert badge record
  await db
    .prepare(`
      INSERT INTO badges (user_id, badge_type, verified_at)
      VALUES (?, ?, ?)
    `)
    .bind(userId, badgeType, now)
    .run();

  // Award score points for earning the badge
  await addScoreEvent(
    userId,
    'badge_earned',
    null, // uses weight table value (20 pts)
    { note: `Badge awarded: ${badgeType}` },
    db,
  );

  return { awarded: true, badge_type: badgeType, verified_at: now };
}

/**
 * Admin manually awards a badge (for manual_verify badges).
 * Requires admin check to be done in the route handler.
 */
export async function adminAwardBadge(userId, badgeType, db) {
  const badgeDef = BADGE_DEFINITIONS.find(b => b.type === badgeType);
  if (!badgeDef) return { error: `Unknown badge type: ${badgeType}` };

  return await awardBadge(userId, badgeType, db);
}

/**
 * Get all badges for a user.
 * Fix 6 — sorted by display priority:
 * Sovereign → Verified Millionaire → Verified Founder → Verified Builder → Founding Member → others
 */
export async function getUserBadges(userId, db) {
  const { results } = await db
    .prepare(`
      SELECT badge_type, verified_at
      FROM badges
      WHERE user_id = ?
    `)
    .bind(userId)
    .all();

  // Enrich with badge metadata
  const enriched = results.map(row => {
    const def = BADGE_DEFINITIONS.find(b => b.type === row.badge_type);
    return {
      type:        row.badge_type,
      label:       def?.label       ?? row.badge_type,
      description: def?.description ?? '',
      verified_at: row.verified_at,
    };
  });

  // Fix 6 — Sort by display priority; unknown badge types fall to the end
  enriched.sort((a, b) => {
    const pa = BADGE_DISPLAY_PRIORITY[a.type] ?? 999;
    const pb = BADGE_DISPLAY_PRIORITY[b.type] ?? 999;
    return pa - pb;
  });

  return enriched;
}
