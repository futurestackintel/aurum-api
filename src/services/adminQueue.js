// adminQueue.js (service)
// Fills the two genuinely missing pieces of the admin review queue:
// challenge entries awaiting a score, and challenges past their end
// date with no winner picked yet. Badge requests, moderation flags,
// and post disputes already have their own services/routes — this
// does not duplicate or replace those.

export async function getUnscoredEntries(env, limit = 50, offset = 0) {
  const { results } = await env.DB.prepare(`
    SELECT ce.id, ce.challenge_id, ce.user_id, ce.achievement_value,
           ce.achievement_proof_urls, ce.proof_description,
           ce.submitted_at, ce.status,
           u.username,
           c.title AS challenge_title
    FROM challenge_entries ce
    JOIN users u ON u.id = ce.user_id
    JOIN challenges c ON c.id = ce.challenge_id
    WHERE ce.status = 'submitted' AND ce.score IS NULL
    ORDER BY ce.submitted_at ASC
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all();
  return results || [];
}

export async function getResolvableChallenges(env, limit = 50, offset = 0) {
  const { results } = await env.DB.prepare(`
    SELECT c.id, c.title, c.challenge_type, c.pool_total_cents,
           c.ends_at, c.status, c.participant_count
    FROM challenges c
    WHERE c.status IN ('active', 'voting')
      AND c.ends_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      AND c.winner_id IS NULL
      AND c.deleted_at IS NULL
    ORDER BY c.ends_at ASC
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all();
  return results || [];
}

// ── DISPUTED/TIED DUELS ──────────────────────────────────────
// Surfaces duels that need admin attention: either explicitly
// reported for cheating, or tied (closeDuelWindow couldn't pick
// a winner). Both cases go to POST /api/duels/:id/dispute-decision.

export async function getDisputedDuels(env, limit, offset) {
  const { results } = await env.DB.prepare(`
    SELECT
      d.id, d.title, d.duel_tip_amount, d.status, d.dispute_status,
      d.dispute_reason, d.dispute_deadline, d.winner_id,
      d.audience_tips_challenger, d.audience_tips_target,
      uc.username AS challenger_username,
      ut.username AS target_username,
      ur.username AS reported_by_username
    FROM duels d
    JOIN users uc ON uc.id = d.challenger_id
    JOIN users ut ON ut.id = d.target_id
    LEFT JOIN users ur ON ur.id = d.dispute_reported_by
    WHERE d.dispute_status = 'reported' OR d.status = 'tied'
    ORDER BY d.created_at DESC
    LIMIT ? OFFSET ?
  `).bind(limit ?? 50, offset ?? 0).all();

  return results;
}
