// adminQueue.js (service)
// Read-only queries powering the admin review queue. Each function
// returns one category of "things needing admin action" based on
// the real, confirmed column names/values from the posts, appeals
// (appeal_* columns on posts), challenge_entries, and challenges
// tables. Nothing here mutates data — resolving/scoring stays in
// the existing resolvePost/resolveAppeal/scoreEntry/resolveChallenge
// functions elsewhere.

export async function getPendingPosts(env, limit = 50) {
  const { results } = await env.DB.prepare(`
    SELECT p.id, p.content, p.stake_amount_cents, p.stake_status,
           p.moderation_status, p.flag_count, p.created_at,
           u.username, u.id AS user_id
    FROM posts p
    JOIN users u ON u.id = p.user_id
    WHERE (p.stake_status = 'disputed' OR p.moderation_status = 'under_review')
      AND p.deleted_at IS NULL
    ORDER BY p.created_at ASC
    LIMIT ?
  `).bind(limit).all();
  return results || [];
}

export async function getPendingAppeals(env, limit = 50) {
  const { results } = await env.DB.prepare(`
    SELECT p.id, p.content, p.stake_amount_cents, p.stake_status,
           p.appeal_reason, p.appeal_deadline, p.appeal_status,
           u.username, u.id AS user_id
    FROM posts p
    JOIN users u ON u.id = p.user_id
    WHERE p.appeal_status = 'pending'
      AND p.deleted_at IS NULL
    ORDER BY p.appeal_deadline ASC
    LIMIT ?
  `).bind(limit).all();
  return results || [];
}

export async function getUnscoredEntries(env, limit = 50) {
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
    LIMIT ?
  `).bind(limit).all();
  return results || [];
}

export async function getResolvableChallenges(env, limit = 50) {
  const { results } = await env.DB.prepare(`
    SELECT c.id, c.title, c.challenge_type, c.pool_total_cents,
           c.ends_at, c.status, c.participant_count
    FROM challenges c
    WHERE c.status IN ('active', 'voting')
      AND c.ends_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      AND c.winner_id IS NULL
      AND c.deleted_at IS NULL
    ORDER BY c.ends_at ASC
    LIMIT ?
  `).bind(limit).all();
  return results || [];
}

export async function getReviewQueue(env) {
  const [posts, appeals, entries, challenges] = await Promise.all([
    getPendingPosts(env),
    getPendingAppeals(env),
    getUnscoredEntries(env),
    getResolvableChallenges(env),
  ]);
  return { posts, appeals, entries, challenges };
}
