// ============================================================
// CHALLENGER DUEL SYSTEM
// Any member can publicly challenge another to an achievement duel.
// Target must accept. Both submit proof. Loser tips winner publicly.
// Creates organic drama and viral leaderboard content.
// ============================================================

import { addScoreEvent } from './aurumScore.js';

const DUEL_EXPIRY_HOURS    = 48; // target has 48hrs to accept
const DEFAULT_DUEL_DAYS    = 7;  // duel runs for 7 days after acceptance
const MIN_DUEL_TIP_AMOUNT  = 5;  // minimum loser tip in dollars

// ── CREATE DUEL ──────────────────────────────────────────────

/**
 * Challenger creates a public duel against a target user.
 * A duel_tip_amount is locked — loser pays this to winner.
 */
export async function createDuel(challengerId, body, db) {
  const { target_username, title, description, duel_tip_amount } = body;

  if (!target_username)                           return { error: 'target_username is required' };
  if (!title || title.trim().length === 0)        return { error: 'title is required' };
  if (!duel_tip_amount || duel_tip_amount < MIN_DUEL_TIP_AMOUNT) {
    return { error: `Minimum duel tip amount is $${MIN_DUEL_TIP_AMOUNT}` };
  }

  // Look up target
  const target = await db
    .prepare(`SELECT id, username FROM users WHERE username = ?`)
    .bind(target_username.trim())
    .first();

  if (!target) return { error: `User @${target_username} not found` };
  if (target.id === challengerId) return { error: 'You cannot duel yourself' };

  // Prevent duplicate active duel between same two users
  const existing = await db
    .prepare(`
      SELECT id FROM duels
      WHERE (challenger_id = ? AND target_id = ?)
         OR (challenger_id = ? AND target_id = ?)
      AND status IN ('pending', 'active')
    `)
    .bind(challengerId, target.id, target.id, challengerId)
    .first();

  if (existing) return { error: 'You already have an active duel with this user' };

  const now      = new Date();
  const expiresAt = new Date(now.getTime() + DUEL_EXPIRY_HOURS * 60 * 60 * 1000);
  const duelId   = crypto.randomUUID();

  await db
    .prepare(`
      INSERT INTO duels
        (id, challenger_id, target_id, title, description,
         duel_tip_amount, status, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `)
    .bind(
      duelId,
      challengerId,
      target.id,
      title.trim(),
      description ?? null,
      duel_tip_amount,
      expiresAt.toISOString(),
      now.toISOString(),
    )
    .run();

  // Get challenger info for response
  const challenger = await db
    .prepare(`SELECT username FROM users WHERE id = ?`)
    .bind(challengerId)
    .first();

  return {
    duel: {
      id:               duelId,
      challenger:       challenger.username,
      target:           target.username,
      title:            title.trim(),
      description:      description ?? null,
      duel_tip_amount:  duel_tip_amount,
      status:           'pending',
      expires_at:       expiresAt.toISOString(),
      created_at:       now.toISOString(),
    },
  };
}

// ── ACCEPT DUEL ──────────────────────────────────────────────

/**
 * Target accepts the duel — status moves from pending → active.
 * Duel end date is set from acceptance time.
 */
export async function acceptDuel(duelId, userId, db) {
  const duel = await db
    .prepare(`SELECT * FROM duels WHERE id = ?`)
    .bind(duelId)
    .first();

  if (!duel)                        return { error: 'Duel not found' };
  if (duel.target_id !== userId)    return { error: 'Only the challenged user can accept' };
  if (duel.status !== 'pending')    return { error: `Duel is already ${duel.status}` };
  if (new Date(duel.expires_at) <= new Date()) {
    await db
      .prepare(`UPDATE duels SET status = 'expired' WHERE id = ?`)
      .bind(duelId)
      .run();
    return { error: 'Duel invitation has expired' };
  }

  const now    = new Date();
  const endsAt = new Date(now.getTime() + DEFAULT_DUEL_DAYS * 24 * 60 * 60 * 1000);

  await db
    .prepare(`
      UPDATE duels
      SET status = 'active', accepted_at = ?, ends_at = ?
      WHERE id = ?
    `)
    .bind(now.toISOString(), endsAt.toISOString(), duelId)
    .run();

  return {
    accepted:  true,
    duel_id:   duelId,
    ends_at:   endsAt.toISOString(),
  };
}

// ── DECLINE DUEL ─────────────────────────────────────────────

export async function declineDuel(duelId, userId, db) {
  const duel = await db
    .prepare(`SELECT * FROM duels WHERE id = ?`)
    .bind(duelId)
    .first();

  if (!duel)                      return { error: 'Duel not found' };
  if (duel.target_id !== userId)  return { error: 'Only the challenged user can decline' };
  if (duel.status !== 'pending')  return { error: `Duel is already ${duel.status}` };

  await db
    .prepare(`UPDATE duels SET status = 'declined' WHERE id = ?`)
    .bind(duelId)
    .run();

  return { declined: true, duel_id: duelId };
}

// ── SUBMIT PROOF ─────────────────────────────────────────────

/**
 * Either participant submits their achievement proof.
 * proof_value is the numeric metric (revenue, deals, growth %).
 */
export async function submitDuelProof(duelId, userId, body, db) {
  const { proof_url, proof_description, proof_value } = body;

  if (!proof_url && !proof_description) {
    return { error: 'proof_url or proof_description is required' };
  }

  const duel = await db
    .prepare(`SELECT * FROM duels WHERE id = ?`)
    .bind(duelId)
    .first();

  if (!duel) return { error: 'Duel not found' };
  if (duel.status !== 'active') return { error: 'Duel is not active' };
  if (duel.challenger_id !== userId && duel.target_id !== userId) {
    return { error: 'You are not a participant in this duel' };
  }
  if (new Date(duel.ends_at) <= new Date()) {
    return { error: 'Duel submission window has closed' };
  }

  const isChallenger = duel.challenger_id === userId;
  const proofField   = isChallenger ? 'challenger_proof' : 'target_proof';
  const valueField   = isChallenger ? 'challenger_proof_value' : 'target_proof_value';

  const proof = JSON.stringify({
    url:          proof_url         ?? null,
    description:  proof_description ?? null,
    value:        proof_value       ?? null,
    submitted_at: new Date().toISOString(),
  });

  await db
    .prepare(`UPDATE duels SET ${proofField} = ?, ${valueField} = ? WHERE id = ?`)
    .bind(proof, proof_value ?? 0, duelId)
    .run();

  return {
    submitted:  true,
    duel_id:    duelId,
    proof_value: proof_value ?? null,
  };
}

// ── RESOLVE DUEL ─────────────────────────────────────────────

/**
 * Admin resolves the duel — declares winner.
 * Loser tip is recorded as a public tip transaction.
 * Winner gets challenge_win score. Loser gets tip_sent score.
 */
export async function resolveDuel(duelId, winnerId, moderatorId, db) {
  const duel = await db
    .prepare(`SELECT * FROM duels WHERE id = ?`)
    .bind(duelId)
    .first();

  if (!duel)                       return { error: 'Duel not found' };
  if (duel.status === 'resolved')  return { error: 'Duel already resolved' };
  if (duel.status !== 'active')    return { error: 'Duel is not active' };

  // Winner must be one of the two participants
  if (winnerId !== duel.challenger_id && winnerId !== duel.target_id) {
    return { error: 'Winner must be one of the duel participants' };
  }

  const loserId = winnerId === duel.challenger_id
    ? duel.target_id
    : duel.challenger_id;

  const now = new Date().toISOString();

  // Mark duel resolved
  await db
    .prepare(`UPDATE duels SET status = 'resolved', winner_id = ?, resolved_at = ? WHERE id = ?`)
    .bind(winnerId, now, duelId)
    .run();

  // Record loser tip as a public tip transaction
  const tipId = crypto.randomUUID();
  await db
    .prepare(`
      INSERT INTO tips
        (id, sender_id, receiver_id, duel_id, amount, fee_taken, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `)
    .bind(tipId, loserId, winnerId, duelId, duel.duel_tip_amount, now)
    .run();

  // Score: winner gets challenge_win points
  await addScoreEvent(
    winnerId,
    'challenge_win',
    null,
    { challenge_id: duelId, note: `Won duel: ${duel.title}` },
    db,
  );

  // Score: loser gets tip_sent points (generous even in defeat)
  await addScoreEvent(
    loserId,
    'tip_sent',
    null,
    { tip_id: tipId, note: `Lost duel: ${duel.title} — tip sent to winner` },
    db,
  );

  // Get usernames for response
  const winner = await db
    .prepare(`SELECT username FROM users WHERE id = ?`)
    .bind(winnerId)
    .first();
  const loser = await db
    .prepare(`SELECT username FROM users WHERE id = ?`)
    .bind(loserId)
    .first();

  return {
    resolved:         true,
    duel_id:          duelId,
    winner_id:        winnerId,
    winner_username:  winner?.username,
    loser_id:         loserId,
    loser_username:   loser?.username,
    tip_amount:       duel.duel_tip_amount,
    tip_id:           tipId,
  };
}

// ── GET DUELS ────────────────────────────────────────────────

/**
 * Get all active/pending duels — public feed for drama and FOMO.
 */
export async function getActiveDuels(limit, offset, db) {
  const { results } = await db
    .prepare(`
      SELECT
        d.id, d.title, d.duel_tip_amount, d.status, d.ends_at, d.created_at,
        uc.username as challenger_username, uc.league as challenger_league,
        ut.username as target_username,     ut.league as target_league
      FROM duels d
      JOIN users uc ON uc.id = d.challenger_id
      JOIN users ut ON ut.id = d.target_id
      WHERE d.status IN ('pending', 'active')
      ORDER BY d.created_at DESC
      LIMIT ? OFFSET ?
    `)
    .bind(limit ?? 20, offset ?? 0)
    .all();

  return results;
}

/**
 * Get a single duel by ID.
 */
export async function getDuelById(duelId, db) {
  return await db
    .prepare(`
      SELECT
        d.*,
        uc.username as challenger_username, uc.league as challenger_league,
        ut.username as target_username,     ut.league as target_league
      FROM duels d
      JOIN users uc ON uc.id = d.challenger_id
      JOIN users ut ON ut.id = d.target_id
      WHERE d.id = ?
    `)
    .bind(duelId)
    .first();
}