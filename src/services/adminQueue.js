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
