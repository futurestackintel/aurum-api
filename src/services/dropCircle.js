// ============================================================
// DROP CIRCLE (ARENA) — FULL LIFECYCLE
// Stage 1: Create challenge + set entry fee
// Stage 2: Members join and fund pool → treasury
// Stage 3: Members submit achievement proof
// Stage 4: Entries scored by admin/moderator
// Stage 5: Winner resolved → 95% payout, 5% platform fee
// ============================================================

import { addScoreEvent } from './aurumScore.js';

const PLATFORM_FEE_PERCENT = 5;

// ── STAGE 1: CREATE CHALLENGE ────────────────────────────────

/**
 * Create a new Drop Circle challenge.
 * Returns challenge in exact shape frontend Arena expects.
 */
export async function createChallenge(userId, body, db) {
  const {
    title,
    type,         // 'skill' | 'achievement' | 'charity_brawl'
    entry_fee,
    ends_at,
    description,
    max_entries,
  } = body;

  // Validate
  if (!title || title.trim().length === 0) return { error: 'Title is required' };
  if (!entry_fee || entry_fee < 5)         return { error: 'Minimum entry fee is $5' };
  if (!ends_at)                            return { error: 'End date is required' };
  if (!type)                               return { error: 'Challenge type is required' };

  const validTypes = ['skill', 'achievement', 'charity_brawl'];
  if (!validTypes.includes(type)) {
    return { error: `type must be one of: ${validTypes.join(', ')}` };
  }

  // Validate end date is in the future
  const endsAtDate = new Date(ends_at);
  if (endsAtDate <= new Date()) return { error: 'ends_at must be in the future' };

  const now         = new Date().toISOString();
  const challengeId = crypto.randomUUID();

  await db
    .prepare(`
      INSERT INTO challenges
        (id, creator_id, title, type, description, entry_fee, pool_amount,
         max_entries, status, winner_id, ends_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'open', NULL, ?, ?)
    `)
    .bind(
      challengeId,
      userId,
      title.trim(),
      type,
      description ?? null,
      entry_fee,
      max_entries ?? null,
      endsAtDate.toISOString(),
      now,
    )
    .run();

  // Initialize treasury record for this challenge
  await db
    .prepare(`
      INSERT INTO treasury_ledger
        (id, challenge_id, user_id, amount, type, status, created_at)
      VALUES (?, ?, ?, 0, 'challenge_pool', 'open', ?)
    `)
    .bind(crypto.randomUUID(), challengeId, userId, now)
    .run();

  // Return in exact shape frontend Arena expects
  return {
    challenge: {
      id:         challengeId,
      title:      title.trim(),
      type,
      status:     'open',
      pool_amount: 0,
      entry_fee,
      entries:    0,
      ends_at:    endsAtDate.toISOString(),
    },
  };
}

// ── STAGE 2: JOIN AND FUND POOL ──────────────────────────────

/**
 * Member joins a challenge and funds entry fee into treasury pool.
 * In production this triggers a Paystack charge — here we record
 * the intent and mark as funded (payment confirmed via webhook).
 */
export async function joinChallenge(challengeId, userId, db) {
  // Get challenge
  const challenge = await db
    .prepare(`SELECT * FROM challenges WHERE id = ?`)
    .bind(challengeId)
    .first();

  if (!challenge)                   return { error: 'Challenge not found' };
  if (challenge.status !== 'open')  return { error: 'Challenge is not open for entries' };
  if (new Date(challenge.ends_at) <= new Date()) {
    return { error: 'Challenge has expired' };
  }

  // Check max entries
  if (challenge.max_entries) {
    const { results } = await db
      .prepare(`SELECT COUNT(*) as count FROM challenge_entries WHERE challenge_id = ?`)
      .bind(challengeId)
      .all();
    if (results[0]?.count >= challenge.max_entries) {
      return { error: 'Challenge is full' };
    }
  }

  // Prevent duplicate entry
  const existing = await db
    .prepare(`SELECT id FROM challenge_entries WHERE challenge_id = ? AND user_id = ?`)
    .bind(challengeId, userId)
    .first();
  if (existing) return { error: 'You have already joined this challenge' };

  const now     = new Date().toISOString();
  const entryId = crypto.randomUUID();

  // Create entry record
  await db
    .prepare(`
      INSERT INTO challenge_entries
        (id, challenge_id, user_id, entry_amount, achievement_proof, score, joined_at)
      VALUES (?, ?, ?, ?, NULL, 0, ?)
    `)
    .bind(entryId, challengeId, userId, challenge.entry_fee, now)
    .run();

  // Add entry fee to pool
  const newPool = (challenge.pool_amount ?? 0) + challenge.entry_fee;
  await db
    .prepare(`UPDATE challenges SET pool_amount = ? WHERE id = ?`)
    .bind(newPool, challengeId)
    .run();

  // Update treasury ledger
  await db
    .prepare(`
      UPDATE treasury_ledger
      SET amount = ?
      WHERE challenge_id = ? AND type = 'challenge_pool'
    `)
    .bind(newPool, challengeId)
    .run();

  return {
    joined:       true,
    entry_id:     entryId,
    challenge_id: challengeId,
    entry_fee:    challenge.entry_fee,
    pool_amount:  newPool,
  };
}

// ── STAGE 3: SUBMIT ACHIEVEMENT PROOF ───────────────────────

/**
 * Member submits proof of achievement for their entry.
 * proof_url: link to screenshot, report, revenue dashboard etc.
 * proof_value: numeric value for scoring (e.g. revenue amount, deal size)
 */
export async function submitProof(challengeId, userId, body, db) {
  const { proof_url, proof_description, proof_value } = body;

  if (!proof_url && !proof_description) {
    return { error: 'proof_url or proof_description is required' };
  }

  // Get entry
  const entry = await db
    .prepare(`
      SELECT ce.*, c.status, c.ends_at
      FROM challenge_entries ce
      JOIN challenges c ON c.id = ce.challenge_id
      WHERE ce.challenge_id = ? AND ce.user_id = ?
    `)
    .bind(challengeId, userId)
    .first();

  if (!entry) return { error: 'You are not entered in this challenge' };
  if (entry.status === 'resolved') return { error: 'Challenge already resolved' };

  const proof = JSON.stringify({
    url:         proof_url         ?? null,
    description: proof_description ?? null,
    value:       proof_value       ?? null,
    submitted_at: new Date().toISOString(),
  });

  await db
    .prepare(`
      UPDATE challenge_entries
      SET achievement_proof = ?, proof_value = ?
      WHERE challenge_id = ? AND user_id = ?
    `)
    .bind(proof, proof_value ?? 0, challengeId, userId)
    .run();

  return {
    submitted:    true,
    challenge_id: challengeId,
    proof_value:  proof_value ?? null,
  };
}

// ── STAGE 4: SCORE ENTRIES ───────────────────────────────────

/**
 * Admin scores a specific entry.
 * score: integer 1-100 assigned by moderator based on proof quality.
 */
export async function scoreEntry(challengeId, entryUserId, score, db) {
  if (score < 0 || score > 100) return { error: 'Score must be between 0 and 100' };

  const entry = await db
    .prepare(`SELECT id FROM challenge_entries WHERE challenge_id = ? AND user_id = ?`)
    .bind(challengeId, entryUserId)
    .first();

  if (!entry) return { error: 'Entry not found' };

  await db
    .prepare(`UPDATE challenge_entries SET score = ? WHERE challenge_id = ? AND user_id = ?`)
    .bind(score, challengeId, entryUserId)
    .run();

  return { scored: true, challenge_id: challengeId, user_id: entryUserId, score };
}

// ── STAGE 5: RESOLVE WINNER ──────────────────────────────────

/**
 * Resolve the challenge — pick winner, split pool, close treasury.
 * Winner gets 95% of pool. Platform keeps 5%.
 * Winner gets challenge_win score event.
 * All entrants get verified_achievement_post score event.
 */
export async function resolveChallenge(challengeId, moderatorId, db) {
  const challenge = await db
    .prepare(`SELECT * FROM challenges WHERE id = ?`)
    .bind(challengeId)
    .first();

  if (!challenge)                        return { error: 'Challenge not found' };
  if (challenge.status === 'resolved')   return { error: 'Challenge already resolved' };
  if (challenge.status === 'cancelled')  return { error: 'Challenge was cancelled' };

  // Get all entries ordered by score descending
  const { results: entries } = await db
    .prepare(`
      SELECT ce.user_id, ce.score, ce.entry_amount, u.username
      FROM challenge_entries ce
      JOIN users u ON u.id = ce.user_id
      WHERE ce.challenge_id = ?
      ORDER BY ce.score DESC
    `)
    .bind(challengeId)
    .all();

  if (entries.length === 0) return { error: 'No entries to resolve' };

  const winner       = entries[0];
  const pool         = challenge.pool_amount ?? 0;
  const platformFee  = Math.floor(pool * (PLATFORM_FEE_PERCENT / 100));
  const winnerPayout = pool - platformFee;
  const now          = new Date().toISOString();

  // Mark challenge resolved
  await db
    .prepare(`UPDATE challenges SET status = 'resolved', winner_id = ? WHERE id = ?`)
    .bind(winner.user_id, challengeId)
    .run();

  // Close treasury — record payout
  await db
    .prepare(`
      UPDATE treasury_ledger
      SET status = 'released', released_at = ?,
          winner_payout = ?, platform_fee = ?
      WHERE challenge_id = ? AND type = 'challenge_pool'
    `)
    .bind(now, winnerPayout, platformFee, challengeId)
    .run();

  // Log payout record
  await db
    .prepare(`
      INSERT INTO challenge_payouts
        (id, challenge_id, winner_id, pool_amount, platform_fee, winner_payout, resolved_at, moderator_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      crypto.randomUUID(),
      challengeId,
      winner.user_id,
      pool,
      platformFee,
      winnerPayout,
      now,
      moderatorId,
    )
    .run();

  // Award score to winner
  await addScoreEvent(
    winner.user_id,
    'challenge_win',
    null,
    { challenge_id: challengeId, note: `Won Drop Circle: ${challenge.title}` },
    db,
  );

  // Award participation score to all other entrants
  for (const entry of entries.slice(1)) {
    await addScoreEvent(
      entry.user_id,
      'verified_achievement_post',
      10, // participation points — less than a win
      { challenge_id: challengeId, note: `Participated in Drop Circle: ${challenge.title}` },
      db,
    );
  }

  return {
    resolved:       true,
    challenge_id:   challengeId,
    winner_id:      winner.user_id,
    winner_username: winner.username,
    pool_amount:    pool,
    platform_fee:   platformFee,
    winner_payout:  winnerPayout,
    total_entries:  entries.length,
  };
}

// ── GET CHALLENGES (Arena feed) ──────────────────────────────

/**
 * Get all open challenges — returns in exact shape frontend Arena expects.
 */
export async function getChallenges(limit, offset, db) {
  const { results } = await db
    .prepare(`
      SELECT
        c.id, c.title, c.type, c.status, c.pool_amount,
        c.entry_fee, c.ends_at,
        COUNT(ce.id) as entries
      FROM challenges c
      LEFT JOIN challenge_entries ce ON ce.challenge_id = c.id
      WHERE c.status = 'open'
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `)
    .bind(limit ?? 20, offset ?? 0)
    .all();

  return results;
}

/**
 * Get a single challenge with all entries.
 */
export async function getChallengeById(challengeId, db) {
  const challenge = await db
    .prepare(`
      SELECT
        c.*,
        COUNT(ce.id) as entries
      FROM challenges c
      LEFT JOIN challenge_entries ce ON ce.challenge_id = c.id
      WHERE c.id = ?
      GROUP BY c.id
    `)
    .bind(challengeId)
    .first();

  if (!challenge) return null;

  const { results: entryList } = await db
    .prepare(`
      SELECT ce.user_id, ce.score, ce.joined_at, u.username, u.league
      FROM challenge_entries ce
      JOIN users u ON u.id = ce.user_id
      WHERE ce.challenge_id = ?
      ORDER BY ce.score DESC
    `)
    .bind(challengeId)
    .all();

  return { ...challenge, entry_list: entryList };
}