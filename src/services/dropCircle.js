// ============================================================
// DROP CIRCLE (ARENA) — FULL LIFECYCLE
// Rewritten for Module Chat F to match actual DB schema.
// Key schema facts:
//   challenges uses: challenge_type, entry_fee_cents, pool_total_cents,
//     participant_count, max_participants, status ('draft','open','active',
//     'voting','completed','cancelled'), starts_at (required)
//   treasury_ledger uses: total_held_cents, platform_fee_cents,
//     winner_payout_cents, paystack_transfer_id
//   challenge_entries uses: entry_amount (dollars float, legacy col)
// New features: gold buttons, boosts, free entry, creator-join fix,
//   pool sync in batch, getChallenges ordered by boost then gold then date
// ============================================================

import { addScoreEvent } from './aurumScore.js';

const PLATFORM_FEE_PERCENT = 5;

// ── HELPERS ──────────────────────────────────────────────────

function nowISO() {
  return new Date().toISOString();
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── STAGE 1: CREATE CHALLENGE ────────────────────────────────

export async function createChallenge(userId, body, db) {
  const {
    title,
    type,
    entry_fee,
    ends_at,
    starts_at,
    description,
    max_entries,
    verification_method,
  } = body;

  if (!title || title.trim().length === 0) return { error: 'Title is required' };
  if (!entry_fee || entry_fee < 5)          return { error: 'Minimum entry fee is $5' };
  if (!ends_at)                             return { error: 'End date is required' };
  if (!type)                                return { error: 'Challenge type is required' };

  const validTypes = ['revenue', 'deals_closed', 'growth', 'savings', 'custom', 'charity_brawl'];
  if (!validTypes.includes(type)) {
    return { error: `type must be one of: ${validTypes.join(', ')}` };
  }

  const validVerification = ['proof_upload', 'honor_system', 'admin_verified'];
  const verificationMethod = verification_method ?? 'proof_upload';
  if (!validVerification.includes(verificationMethod)) {
    return { error: `verification_method must be one of: ${validVerification.join(', ')}` };
  }

  const endsAtDate   = new Date(ends_at);
  if (endsAtDate <= new Date()) return { error: 'ends_at must be in the future' };

  const startsAtDate = starts_at ? new Date(starts_at) : new Date();
  const now          = nowISO();
  const challengeId  = crypto.randomUUID();

  // Resolve internal user ID from Clerk ID
  const userRow = await db
    .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
    .bind(userId)
    .first();
  if (!userRow) return { error: 'User not found' };
  const internalUserId = userRow.id;

  // entry_fee stored as cents in DB
  const entryFeeCents = Math.round(entry_fee * 100);

  await db
    .prepare(`
      INSERT INTO challenges
        (id, creator_id, title, description, challenge_type, verification_method,
         entry_fee_cents, pool_total_cents, max_participants, participant_count,
         status, starts_at, ends_at, moderation_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 'open', ?, ?, 'approved', ?, ?)
    `)
    .bind(
      challengeId,
      internalUserId,
      title.trim(),
      description ?? '',
      type,
      verificationMethod,
      entryFeeCents,
      max_entries ?? null,
      startsAtDate.toISOString(),
      endsAtDate.toISOString(),
      now,
      now,
    )
    .run();

  // Initialize treasury record
  await db
    .prepare(`
      INSERT INTO treasury_ledger
        (id, challenge_id, total_held_cents, platform_fee_cents,
         winner_payout_cents, status, created_at, updated_at)
      VALUES (?, ?, 0, 0, 0, 'holding', ?, ?)
    `)
    .bind(crypto.randomUUID(), challengeId, now, now)
    .run();

  return {
    challenge: {
      id:          challengeId,
      title:       title.trim(),
      type,
      status:      'open',
      pool_amount: 0,
      entry_fee,
      entries:     0,
      ends_at:     endsAtDate.toISOString(),
    },
  };
}

// ── STAGE 2: JOIN AND FUND POOL ──────────────────────────────

export async function joinChallenge(challengeId, userId, db) {
  const challenge = await db
    .prepare(`SELECT * FROM challenges WHERE id = ?`)
    .bind(challengeId)
    .first();

  if (!challenge)                  return { error: 'Challenge not found' };
  if (challenge.status !== 'open') return { error: 'Challenge is not open for entries' };
  if (new Date(challenge.ends_at) <= new Date()) {
    return { error: 'Challenge has expired' };
  }

  // Fix — creator cannot join own challenge
  if (userId === challenge.creator_id) {
    return { error: 'Challenge creators cannot enter their own challenge' };
  }

  // Check max participants
  if (challenge.max_participants) {
    if (challenge.participant_count >= challenge.max_participants) {
      return { error: 'Challenge is full' };
    }
  }

  // Prevent duplicate entry
  const existing = await db
    .prepare(`SELECT id FROM challenge_entries WHERE challenge_id = ? AND user_id = ?`)
    .bind(challengeId, userId)
    .first();
  if (existing) return { error: 'You have already joined this challenge' };

  // Check wallet balance
  const wallet = await db
    .prepare(`SELECT balance_usd FROM wallets WHERE user_id = ?`)
    .bind(userId)
    .first();

  const entryFeeUsd = (challenge.entry_fee_cents ?? 0) / 100;

  if (!wallet || wallet.balance_usd < entryFeeUsd) {
    return { error: `Insufficient wallet balance. Entry fee is $${entryFeeUsd.toFixed(2)}` };
  }

  const now     = nowISO();
  const entryId = crypto.randomUUID();
  const newPool = (challenge.pool_total_cents ?? 0) + (challenge.entry_fee_cents ?? 0);

  // Wrap pool sync in D1 batch
  await db.batch([
    db.prepare(`
      INSERT INTO challenge_entries
        (id, challenge_id, user_id, entry_amount, achievement_proof, score, joined_at)
      VALUES (?, ?, ?, ?, NULL, 0, ?)
    `).bind(entryId, challengeId, userId, entryFeeUsd, now),

    db.prepare(`
      UPDATE challenges
      SET pool_total_cents = ?, participant_count = participant_count + 1, updated_at = ?
      WHERE id = ?
    `).bind(newPool, now, challengeId),

    db.prepare(`
      UPDATE treasury_ledger
      SET total_held_cents = ?, updated_at = ?
      WHERE challenge_id = ? AND status = 'holding'
    `).bind(newPool, now, challengeId),

    db.prepare(`
      UPDATE wallets
      SET balance_usd = balance_usd - ?, updated_at = ?
      WHERE user_id = ?
    `).bind(entryFeeUsd, now, userId),
  ]);

  return {
    joined:       true,
    entry_id:     entryId,
    challenge_id: challengeId,
    entry_fee:    entryFeeUsd,
    pool_amount:  newPool / 100,
  };
}

// ── STAGE 3: SUBMIT ACHIEVEMENT PROOF ───────────────────────

export async function submitProof(challengeId, userId, body, db) {
  const { proof_url, proof_description, proof_value } = body;

  if (!proof_url && !proof_description) {
    return { error: 'proof_url or proof_description is required' };
  }

  const entry = await db
    .prepare(`
      SELECT ce.*, c.status, c.ends_at
      FROM challenge_entries ce
      JOIN challenges c ON c.id = ce.challenge_id
      WHERE ce.challenge_id = ? AND ce.user_id = ?
    `)
    .bind(challengeId, userId)
    .first();

  if (!entry)                        return { error: 'You are not entered in this challenge' };
  if (entry.status === 'completed')  return { error: 'Challenge already resolved' };

  const proof = JSON.stringify({
    url:          proof_url         ?? null,
    description:  proof_description ?? null,
    value:        proof_value       ?? null,
    submitted_at: nowISO(),
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

export async function resolveChallenge(challengeId, moderatorId, db) {
  const challenge = await db
    .prepare(`SELECT * FROM challenges WHERE id = ?`)
    .bind(challengeId)
    .first();

  if (!challenge)                         return { error: 'Challenge not found' };
  if (challenge.status === 'completed')   return { error: 'Challenge already resolved' };
  if (challenge.status === 'cancelled')   return { error: 'Challenge was cancelled' };

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

  const winner          = entries[0];
  const poolCents       = challenge.pool_total_cents ?? 0;
  const platformFeeCents = Math.floor(poolCents * (PLATFORM_FEE_PERCENT / 100));
  const winnerPayoutCents = poolCents - platformFeeCents;
  const winnerPayoutUsd   = winnerPayoutCents / 100;
  const now             = nowISO();

  await db.batch([
    db.prepare(`
      UPDATE challenges
      SET status = 'completed', winner_id = ?, winner_announced_at = ?, updated_at = ?
      WHERE id = ?
    `).bind(winner.user_id, now, now, challengeId),

    db.prepare(`
      UPDATE treasury_ledger
      SET status = 'released', released_at = ?,
          winner_payout_cents = ?, platform_fee_cents = ?, updated_at = ?
      WHERE challenge_id = ? AND status = 'holding'
    `).bind(now, winnerPayoutCents, platformFeeCents, now, challengeId),

    db.prepare(`
      INSERT INTO challenge_payouts
        (id, challenge_id, winner_id, pool_amount, platform_fee,
         winner_payout, resolved_at, moderator_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(), challengeId, winner.user_id,
      poolCents / 100, platformFeeCents / 100, winnerPayoutUsd,
      now, moderatorId,
    ),

    // Credit winner wallet
    db.prepare(`
      UPDATE wallets SET balance_usd = balance_usd + ?, updated_at = ?
      WHERE user_id = ?
    `).bind(winnerPayoutUsd, now, winner.user_id),
  ]);

  // Score events outside batch (addScoreEvent does its own writes)
  await addScoreEvent(
    winner.user_id, 'challenge_win', null,
    { challenge_id: challengeId, note: `Won Drop Circle: ${challenge.title}` },
    db,
  );

  for (const entry of entries.slice(1)) {
    await addScoreEvent(
      entry.user_id, 'verified_achievement_post', 10,
      { challenge_id: challengeId, note: `Participated in Drop Circle: ${challenge.title}` },
      db,
    );
  }

  return {
    resolved:        true,
    challenge_id:    challengeId,
    winner_id:       winner.user_id,
    winner_username: winner.username,
    pool_amount:     poolCents / 100,
    platform_fee:    platformFeeCents / 100,
    winner_payout:   winnerPayoutUsd,
    total_entries:   entries.length,
  };
}

// ── FEATURE 1: GOLD BUTTON ───────────────────────────────────

export async function giveGoldButton(challengeId, userId, db) {
  const challenge = await db
    .prepare(`SELECT id, status FROM challenges WHERE id = ?`)
    .bind(challengeId)
    .first();

  if (!challenge)                  return { error: 'Challenge not found' };
  if (challenge.status !== 'open') return { error: 'Challenge is not open' };

  const existing = await db
    .prepare(`SELECT id FROM challenge_gold_buttons WHERE challenge_id = ? AND user_id = ?`)
    .bind(challengeId, userId)
    .first();

  if (existing) return { error: 'You have already given a gold button to this challenge' };

  await db
    .prepare(`
      INSERT INTO challenge_gold_buttons (id, challenge_id, user_id, created_at)
      VALUES (?, ?, ?, ?)
    `)
    .bind(crypto.randomUUID(), challengeId, userId, nowISO())
    .run();

  await addScoreEvent(
    userId, 'gold_button_given', null,
    { challenge_id: challengeId, note: 'Gave gold button to a challenge' },
    db,
  );

  return { gold_button: true, challenge_id: challengeId };
}

// ── FEATURE 2: CHALLENGE BOOST ───────────────────────────────

export async function boostChallenge(challengeId, userId, body, db) {
  const { amount_usd } = body;

  if (!amount_usd || amount_usd <= 0) return { error: 'amount_usd is required and must be positive' };

  const challenge = await db
    .prepare(`SELECT id, status FROM challenges WHERE id = ?`)
    .bind(challengeId)
    .first();

  if (!challenge)                  return { error: 'Challenge not found' };
  if (challenge.status !== 'open') return { error: 'Challenge is not open' };

  // Check wallet
  const wallet = await db
    .prepare(`SELECT balance_usd FROM wallets WHERE user_id = ?`)
    .bind(userId)
    .first();

  if (!wallet || wallet.balance_usd < amount_usd) {
    return { error: `Insufficient wallet balance. Boost costs $${amount_usd.toFixed(2)}` };
  }

  const now       = nowISO();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  await db.batch([
    db.prepare(`
      INSERT INTO challenge_boosts (id, challenge_id, user_id, amount_usd, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(crypto.randomUUID(), challengeId, userId, amount_usd, expiresAt, now),

    db.prepare(`
      UPDATE wallets SET balance_usd = balance_usd - ?, updated_at = ?
      WHERE user_id = ?
    `).bind(amount_usd, now, userId),
  ]);

  await addScoreEvent(
    userId, 'challenge_boost_purchased', null,
    { challenge_id: challengeId, note: `Boosted challenge for $${amount_usd}` },
    db,
  );

  return {
    boosted:      true,
    challenge_id: challengeId,
    amount_usd,
    expires_at:   expiresAt,
  };
}

// ── FEATURE 7a: FREE MONTHLY CHALLENGE ENTRY ─────────────────

export async function freeMonthlyEntry(userId, db) {
  // Explorer tier only
  const user = await db
    .prepare(`SELECT tier FROM users WHERE id = ?`)
    .bind(userId)
    .first();

  if (!user)               return { error: 'User not found' };
  if (user.tier !== 'explorer') {
    return { error: 'Free monthly entry is for Explorer tier members only' };
  }

  const monthKey = new Date().toISOString().slice(0, 7); // 'YYYY-MM'

  const existing = await db
    .prepare(`SELECT id FROM free_challenge_entries WHERE user_id = ? AND month_key = ?`)
    .bind(userId, monthKey)
    .first();

  if (existing) {
    return { error: `You have already used your free entry for ${monthKey}` };
  }

  // Find or create the monthly free challenge
  let freeChallenge = await db
    .prepare(`
      SELECT id FROM challenges
      WHERE challenge_type = 'custom'
        AND status = 'open'
        AND entry_fee_cents = 0
        AND title LIKE 'Free Monthly Challenge%'
      ORDER BY created_at DESC
      LIMIT 1
    `)
    .bind()
    .first();

  if (!freeChallenge) {
    // Auto-create this month's free challenge
    const result = await createChallenge(
      'system',
      {
        title:               `Free Monthly Challenge — ${monthKey}`,
        type:                'custom',
        entry_fee:           0,
        ends_at:             new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString(),
        description:         'Monthly free challenge open to all Explorer members.',
        verification_method: 'proof_upload',
      },
      db,
    );
    // createChallenge returns { challenge: { id } }
    freeChallenge = { id: result.challenge?.id };
  }

  if (!freeChallenge?.id) return { error: 'Could not find or create free monthly challenge' };

  const now = nowISO();

  await db.batch([
    db.prepare(`
      INSERT INTO challenge_entries
        (id, challenge_id, user_id, entry_amount, achievement_proof, score, joined_at)
      VALUES (?, ?, ?, 0, NULL, 0, ?)
    `).bind(crypto.randomUUID(), freeChallenge.id, userId, now),

    db.prepare(`
      UPDATE challenges
      SET participant_count = participant_count + 1, updated_at = ?
      WHERE id = ?
    `).bind(now, freeChallenge.id),

    db.prepare(`
      INSERT INTO free_challenge_entries (id, user_id, month_key, challenge_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(crypto.randomUUID(), userId, monthKey, freeChallenge.id, now),
  ]);

  return {
    entered:      true,
    challenge_id: freeChallenge.id,
    month:        monthKey,
    prize:        '50 Aurum Score points for winner',
  };
}

// ── GET CHALLENGES (Arena feed) ──────────────────────────────

/**
 * Order: boosted (active boost) → gold button count → created_at
 */
export async function getChallenges(limit, offset, db) {
  const now = nowISO();

  const { results } = await db
    .prepare(`
      SELECT
        c.id, c.title, c.challenge_type as type, c.status,
        c.pool_total_cents / 100.0  AS pool_amount,
        c.entry_fee_cents  / 100.0  AS entry_fee,
        c.ends_at,
        c.participant_count         AS entries,
        COUNT(DISTINCT cgb.id)      AS gold_buttons,
        MAX(CASE WHEN cb.expires_at > ? THEN 1 ELSE 0 END) AS is_boosted
      FROM challenges c
      LEFT JOIN challenge_gold_buttons cgb ON cgb.challenge_id = c.id
      LEFT JOIN challenge_boosts cb        ON cb.challenge_id  = c.id
      WHERE c.status = 'open'
      GROUP BY c.id
      ORDER BY is_boosted DESC, gold_buttons DESC, c.created_at DESC
      LIMIT ? OFFSET ?
    `)
    .bind(now, limit ?? 20, offset ?? 0)
    .all();

  return results;
}

// ── GET SINGLE CHALLENGE ─────────────────────────────────────

export async function getChallengeById(challengeId, db) {
  const challenge = await db
    .prepare(`
      SELECT
        c.*,
        c.pool_total_cents / 100.0 AS pool_amount,
        c.entry_fee_cents  / 100.0 AS entry_fee,
        c.participant_count        AS entries
      FROM challenges c
      WHERE c.id = ?
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

  const { results: goldButtons } = await db
    .prepare(`SELECT COUNT(*) as count FROM challenge_gold_buttons WHERE challenge_id = ?`)
    .bind(challengeId)
    .all();

  return {
    ...challenge,
    entry_list:   entryList,
    gold_buttons: goldButtons[0]?.count ?? 0,
  };
}
