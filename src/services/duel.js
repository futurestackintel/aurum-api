// ============================================================
// CHALLENGER DUEL SYSTEM — Final Fix Chat
// Fix 12 (Finding 9): every function below that receives a user id
// from the route layer was using the raw CLERK id directly against
// tables keyed on the INTERNAL DB user id (duels.challenger_id,
// duels.target_id, wallets.user_id, duel_watchers.user_id,
// duel_votes.voter_id). That mismatch meant:
//   - createDuel wrote the wrong id into challenger_id and its own
//     username lookup for the response always failed
//   - acceptDuel / declineDuel / submitDuelProof / announceDuel all
//     compared a Clerk id against an internal id, so a real target
//     user could never successfully act on a duel sent to them
//   - audienceTip / castDuelVote checked/debited the wrong wallet
// Fixed by resolving `SELECT id FROM users WHERE clerk_id = ?`
// at the top of every function that needs it, same pattern used
// in services/crew.js and services/dropCircle.js.
// ============================================================

import { addScoreEvent } from './aurumScore.js';

const DUEL_EXPIRY_HOURS   = 48;
const DEFAULT_DUEL_DAYS   = 7;
const MIN_DUEL_TIP_AMOUNT = 5;

// ── HELPERS ──────────────────────────────────────────────────

function nowISO() {
  return new Date().toISOString();
}

async function resolveUserId(clerkId, db) {
  const row = await db
    .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
    .bind(clerkId)
    .first();
  return row?.id ?? null;
}

// ── CREATE DUEL ──────────────────────────────────────────────

export async function createDuel(clerkId, body, db) {
  const challengerId = await resolveUserId(clerkId, db);
  if (!challengerId) return { error: 'User not found' };

  const { target_username, title, description, duel_tip_amount } = body;

  if (!target_username)                          return { error: 'target_username is required' };
  if (!title || title.trim().length === 0)       return { error: 'title is required' };
  if (!duel_tip_amount || duel_tip_amount < MIN_DUEL_TIP_AMOUNT) {
    return { error: `Minimum duel tip amount is $${MIN_DUEL_TIP_AMOUNT}` };
  }

  const target = await db
    .prepare(`SELECT id, username FROM users WHERE username = ?`)
    .bind(target_username.trim())
    .first();

  if (!target)                    return { error: `User @${target_username} not found` };
  if (target.id === challengerId) return { error: 'You cannot duel yourself' };

  // Prevent duplicate active duel between same two users
  const existing = await db
    .prepare(`
      SELECT id FROM duels
      WHERE ((challenger_id = ? AND target_id = ?)
          OR (challenger_id = ? AND target_id = ?))
        AND status IN ('pending', 'active')
    `)
    .bind(challengerId, target.id, target.id, challengerId)
    .first();

  if (existing) return { error: 'You already have an active duel with this user' };

  const now       = new Date();
  const expiresAt = new Date(now.getTime() + DUEL_EXPIRY_HOURS * 60 * 60 * 1000);
  const duelId    = crypto.randomUUID();

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

  const challenger = await db
    .prepare(`SELECT username FROM users WHERE id = ?`)
    .bind(challengerId)
    .first();

  return {
    duel: {
      id:              duelId,
      challenger:      challenger?.username ?? null,
      target:          target.username,
      title:           title.trim(),
      description:     description ?? null,
      duel_tip_amount,
      status:          'pending',
      expires_at:      expiresAt.toISOString(),
      created_at:      now.toISOString(),
    },
  };
}

// ── ACCEPT DUEL ──────────────────────────────────────────────

export async function acceptDuel(duelId, clerkId, db) {
  const userId = await resolveUserId(clerkId, db);
  if (!userId) return { error: 'User not found' };

  const duel = await db
    .prepare(`SELECT * FROM duels WHERE id = ?`)
    .bind(duelId)
    .first();

  if (!duel)                      return { error: 'Duel not found' };
  if (duel.target_id !== userId)  return { error: 'Only the challenged user can accept' };
  if (duel.status !== 'pending')  return { error: `Duel is already ${duel.status}` };
  if (new Date(duel.expires_at) <= new Date()) {
    await db
      .prepare(`UPDATE duels SET status = 'expired' WHERE id = ?`)
      .bind(duelId)
      .run();
    return { error: 'Duel invitation has expired' };
  }

  const now       = new Date();
  const windowHrs = duel.window_hours ?? DEFAULT_DUEL_DAYS * 24;
  const endsAt    = new Date(now.getTime() + windowHrs * 60 * 60 * 1000);

  const [challenger, target] = await Promise.all([
    db.prepare(`SELECT username FROM users WHERE id = ?`).bind(duel.challenger_id).first(),
    db.prepare(`SELECT username FROM users WHERE id = ?`).bind(duel.target_id).first(),
  ]);

  const postId = crypto.randomUUID();
  const postContent =
    `⚔️ Duel: ${duel.title}\n@${challenger?.username ?? 'challenger'} vs @${target?.username ?? 'opponent'}\n` +
    (duel.description ? duel.description : '');

  await db.batch([
    db.prepare(`
      INSERT INTO posts
        (id, user_id, content, achievement_category, stake_amount_cents, duel_id, created_at, updated_at)
      VALUES (?, ?, ?, 'challenge_win', ?, ?, ?, ?)
    `).bind(
      postId,
      duel.challenger_id,
      postContent,
      Math.round(duel.duel_tip_amount * 100),
      duelId,
      now.toISOString(),
      now.toISOString(),
    ),

    db.prepare(`
      UPDATE duels
      SET status = 'active', accepted_at = ?, ends_at = ?, post_id = ?, dispute_status = 'none'
      WHERE id = ?
    `).bind(now.toISOString(), endsAt.toISOString(), postId, duelId),
  ]);

  return {
    accepted: true,
    duel_id:  duelId,
    post_id:  postId,
    ends_at:  endsAt.toISOString(),
  };
}

// ── DECLINE DUEL ─────────────────────────────────────────────

export async function declineDuel(duelId, clerkId, db) {
  const userId = await resolveUserId(clerkId, db);
  if (!userId) return { error: 'User not found' };

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

export async function submitDuelProof(duelId, clerkId, body, db) {
  const userId = await resolveUserId(clerkId, db);
  if (!userId) return { error: 'User not found' };

  const { proof_url, proof_description, proof_value } = body;

  if (!proof_url && !proof_description) {
    return { error: 'proof_url or proof_description is required' };
  }

  const duel = await db
    .prepare(`SELECT * FROM duels WHERE id = ?`)
    .bind(duelId)
    .first();

  if (!duel)                    return { error: 'Duel not found' };
  if (duel.status !== 'active') return { error: 'Duel is not active' };
  if (duel.challenger_id !== userId && duel.target_id !== userId) {
    return { error: 'You are not a participant in this duel' };
  }
  if (new Date(duel.ends_at) <= new Date()) {
    return { error: 'Duel submission window has closed' };
  }

  const isChallenger = duel.challenger_id === userId;
  const proofField   = isChallenger ? 'challenger_proof'       : 'target_proof';
  const valueField   = isChallenger ? 'challenger_proof_value' : 'target_proof_value';

  const proof = JSON.stringify({
    url:          proof_url         ?? null,
    description:  proof_description ?? null,
    value:        proof_value       ?? null,
    submitted_at: nowISO(),
  });

  await db
    .prepare(`UPDATE duels SET ${proofField} = ?, ${valueField} = ? WHERE id = ?`)
    .bind(proof, proof_value ?? 0, duelId)
    .run();

  return {
    submitted:   true,
    duel_id:     duelId,
    proof_value: proof_value ?? null,
  };
}

// ── RESOLVE DUEL ─────────────────────────────────────────────
// Note: winnerId/loserId here come from duel.challenger_id /
// duel.target_id, which are already internal ids (fixed above at
// creation time), so no additional resolution is needed inside
// this function itself. moderatorId is only used for admin
// attribution and isn't written to any user-id-keyed column here.

export async function resolveDuel(duelId, winnerId, moderatorId, db) {
  const duel = await db
    .prepare(`SELECT * FROM duels WHERE id = ?`)
    .bind(duelId)
    .first();

  if (!duel)                       return { error: 'Duel not found' };
  if (duel.status === 'resolved')  return { error: 'Duel already resolved' };
  if (duel.status !== 'active')    return { error: 'Duel is not active' };

  if (winnerId !== duel.challenger_id && winnerId !== duel.target_id) {
    return { error: 'Winner must be one of the duel participants' };
  }

  const loserId = winnerId === duel.challenger_id
    ? duel.target_id
    : duel.challenger_id;

  const now   = nowISO();
  const tipId = crypto.randomUUID();

  await db.batch([
    db.prepare(`
      UPDATE duels SET status = 'resolved', winner_id = ?, resolved_at = ? WHERE id = ?
    `).bind(winnerId, now, duelId),

    db.prepare(`
      INSERT INTO tips
        (id, sender_id, receiver_id, duel_id, amount_cents, platform_fee_cents,
         receiver_net_cents, is_wallet_tip, status, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, 1, 'completed', ?)
    `).bind(
      tipId, loserId, winnerId, duelId,
      Math.round(duel.duel_tip_amount * 100),
      Math.round(duel.duel_tip_amount * 100),
      now,
    ),

    // Deduct from loser wallet
    db.prepare(`
      UPDATE wallets SET balance_usd = balance_usd - ?, updated_at = ?
      WHERE user_id = ?
    `).bind(duel.duel_tip_amount, now, loserId),

    // Credit winner wallet
    db.prepare(`
      UPDATE wallets SET balance_usd = balance_usd + ?, updated_at = ?
      WHERE user_id = ?
    `).bind(duel.duel_tip_amount, now, winnerId),
  ]);

  await addScoreEvent(
    winnerId, 'challenge_win', null,
    { challenge_id: duelId, note: `Won duel: ${duel.title}` },
    db,
  );

  await addScoreEvent(
    loserId, 'tip_sent', null,
    { tip_id: tipId, note: `Lost duel: ${duel.title} — tip sent to winner` },
    db,
  );

  const winner = await db
    .prepare(`SELECT username FROM users WHERE id = ?`)
    .bind(winnerId)
    .first();
  const loser = await db
    .prepare(`SELECT username FROM users WHERE id = ?`)
    .bind(loserId)
    .first();

  return {
    resolved:        true,
    duel_id:         duelId,
    winner_id:       winnerId,
    winner_username: winner?.username,
    loser_id:        loserId,
    loser_username:  loser?.username,
    tip_amount:      duel.duel_tip_amount,
    tip_id:          tipId,
  };
}

// ── FEATURE 3: ANNOUNCE DUEL ─────────────────────────────────

export async function announceDuel(duelId, clerkId, db) {
  const userId = await resolveUserId(clerkId, db);
  if (!userId) return { error: 'User not found' };

  const duel = await db
    .prepare(`SELECT * FROM duels WHERE id = ?`)
    .bind(duelId)
    .first();

  if (!duel) return { error: 'Duel not found' };
  if (duel.challenger_id !== userId && duel.target_id !== userId) {
    return { error: 'Only duel participants can announce a duel' };
  }
  if (duel.status !== 'active') return { error: 'Duel must be active to announce' };
  if (duel.is_public_announced) return { error: 'Duel has already been announced' };

  const now = nowISO();

  await db
    .prepare(`
      UPDATE duels
      SET is_public_announced = 1, announced_at = ?
      WHERE id = ?
    `)
    .bind(now, duelId)
    .run();

  // Notify all watchers
  const { results: watchers } = await db
    .prepare(`SELECT user_id FROM duel_watchers WHERE duel_id = ?`)
    .bind(duelId)
    .all();

  for (const watcher of watchers) {
    await db
      .prepare(`
        INSERT INTO notifications
          (id, user_id, type, title, body, action_url, created_at)
        VALUES (?, ?, 'duel_announced', 'Duel Announced', ?, ?, ?)
      `)
      .bind(
        crypto.randomUUID(),
        watcher.user_id,
        `The duel "${duel.title}" has been publicly announced.`,
        `/duels/${duelId}`,
        now,
      )
      .run();
  }

  return {
    announced:   true,
    duel_id:     duelId,
    announced_at: now,
    watchers_notified: watchers.length,
  };
}

// ── FEATURE 3: SUBSCRIBE TO DUEL UPDATES ────────────────────

export async function watchDuel(duelId, clerkId, db) {
  const userId = await resolveUserId(clerkId, db);
  if (!userId) return { error: 'User not found' };

  const duel = await db
    .prepare(`SELECT id FROM duels WHERE id = ?`)
    .bind(duelId)
    .first();

  if (!duel) return { error: 'Duel not found' };

  const existing = await db
    .prepare(`SELECT id FROM duel_watchers WHERE duel_id = ? AND user_id = ?`)
    .bind(duelId, userId)
    .first();

  if (existing) return { error: 'You are already watching this duel' };

  await db
    .prepare(`
      INSERT INTO duel_watchers (id, duel_id, user_id, created_at)
      VALUES (?, ?, ?, ?)
    `)
    .bind(crypto.randomUUID(), duelId, userId, nowISO())
    .run();

  return { watching: true, duel_id: duelId };
}

// ── FEATURE 3: ADMIN SET STREAM READY ───────────────────────
// No user-id resolution needed — admin-only action, no user-keyed
// column touched.

export async function setStreamReady(duelId, body, db) {
  const { stream_url } = body;

  const duel = await db
    .prepare(`SELECT id FROM duels WHERE id = ?`)
    .bind(duelId)
    .first();

  if (!duel) return { error: 'Duel not found' };

  await db
    .prepare(`
      UPDATE duels SET stream_ready = 1, stream_url = ?
      WHERE id = ?
    `)
    .bind(stream_url ?? null, duelId)
    .run();

  return { stream_ready: true, duel_id: duelId, stream_url: stream_url ?? null };
}

// ── FEATURE 4: AUDIENCE TIP ──────────────────────────────────
// participantId arrives from the frontend as duel.challenger_id /
// duel.target_id (already internal ids, per duelHTML in arena.js),
// so only tipperId (the route-layer Clerk id) needs resolving.

export async function audienceTip(duelId, participantId, clerkId, body, db) {
  const tipperId = await resolveUserId(clerkId, db);
  if (!tipperId) return { error: 'User not found' };

  const { amount_usd } = body;

  if (!amount_usd || amount_usd <= 0) {
    return { error: 'amount_usd is required and must be positive' };
  }

  const duel = await db
    .prepare(`SELECT * FROM duels WHERE id = ?`)
    .bind(duelId)
    .first();

  if (!duel)                    return { error: 'Duel not found' };
  if (duel.status !== 'active') return { error: 'Duel is not active' };

  if (participantId !== duel.challenger_id && participantId !== duel.target_id) {
    return { error: 'participant must be one of the duel participants' };
  }

  if (tipperId === participantId) {
    return { error: 'You cannot tip yourself' };
  }

  // Check wallet
  const wallet = await db
    .prepare(`SELECT balance_usd FROM wallets WHERE user_id = ?`)
    .bind(tipperId)
    .first();

  if (!wallet || wallet.balance_usd < amount_usd) {
    return { error: `Insufficient wallet balance` };
  }

  const now   = nowISO();
  const tipId = crypto.randomUUID();
  const amountCents = Math.round(amount_usd * 100);

  const isChallenger   = participantId === duel.challenger_id;
  const tipColumn      = isChallenger
    ? 'audience_tips_challenger'
    : 'audience_tips_target';

  // Escrowed — tip is recorded and the tipper is debited now, but the
  // participant's wallet is NOT credited yet. The full escrowed total
  // (both audience_tips_* columns + both stakes) is released to the
  // winner in one payout when the duel resolves (see finaliseDuelPayouts).
  await db.batch([
    db.prepare(`
      INSERT INTO tips
        (id, sender_id, receiver_id, duel_id, amount_cents, platform_fee_cents,
         receiver_net_cents, is_wallet_tip, status, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, 1, 'escrowed', ?)
    `).bind(tipId, tipperId, participantId, duelId, amountCents, amountCents, now),

    db.prepare(`
      UPDATE wallets SET balance_usd = balance_usd - ?, updated_at = ?
      WHERE user_id = ?
    `).bind(amount_usd, now, tipperId),

    db.prepare(`
      UPDATE duels SET ${tipColumn} = ${tipColumn} + ? WHERE id = ?
    `).bind(amount_usd, duelId),
  ]);

  await addScoreEvent(
    tipperId, 'duel_audience_tip', null,
    { tip_id: tipId, note: `Audience tip on duel: ${duel.title}` },
    db,
  );

  return {
    tipped:         true,
    tip_id:         tipId,
    duel_id:        duelId,
    recipient_id:   participantId,
    amount_usd,
  };
}

// ── FEATURE 5: COMMUNITY VOTE ────────────────────────────────
// Same as audienceTip — participantId is already an internal id
// from the frontend; only voterId (Clerk id) needs resolving.

export async function castDuelVote(duelId, participantId, clerkId, db) {
  const voterId = await resolveUserId(clerkId, db);
  if (!voterId) return { error: 'User not found' };

  const duel = await db
    .prepare(`SELECT * FROM duels WHERE id = ?`)
    .bind(duelId)
    .first();

  if (!duel)                    return { error: 'Duel not found' };
  if (duel.status !== 'active') return { error: 'Duel is not active' };

  if (participantId !== duel.challenger_id && participantId !== duel.target_id) {
    return { error: 'You must vote for one of the duel participants' };
  }

  // Participants cannot vote
  if (voterId === duel.challenger_id || voterId === duel.target_id) {
    return { error: 'Duel participants cannot vote on their own duel' };
  }

  // One vote per member
  const existing = await db
    .prepare(`SELECT id FROM duel_votes WHERE duel_id = ? AND voter_id = ?`)
    .bind(duelId, voterId)
    .first();

  if (existing) return { error: 'You have already voted on this duel' };

  const now            = nowISO();
  const isChallenger   = participantId === duel.challenger_id;
  const voteColumn     = isChallenger
    ? 'community_vote_challenger'
    : 'community_vote_target';

  await db.batch([
    db.prepare(`
      INSERT INTO duel_votes (id, duel_id, voter_id, voted_for_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(crypto.randomUUID(), duelId, voterId, participantId, now),

    db.prepare(`
      UPDATE duels SET ${voteColumn} = ${voteColumn} + 1 WHERE id = ?
    `).bind(duelId),
  ]);

  // Reload updated duel to check auto-resolve conditions
  const updated = await db
    .prepare(`SELECT * FROM duels WHERE id = ?`)
    .bind(duelId)
    .first();

  const totalVotes   = (updated.community_vote_challenger ?? 0) + (updated.community_vote_target ?? 0);
  const acceptedAt   = updated.accepted_at ? new Date(updated.accepted_at) : null;
  const hoursElapsed = acceptedAt
    ? (Date.now() - acceptedAt.getTime()) / (1000 * 60 * 60)
    : 0;

  let autoResolved = false;

  if (totalVotes >= 5 && hoursElapsed >= 48) {
    const challengerVotes = updated.community_vote_challenger ?? 0;
    const targetVotes     = updated.community_vote_target ?? 0;
    const challengerPct   = challengerVotes / totalVotes;
    const targetPct       = targetVotes     / totalVotes;

    if (challengerPct > 0.6 || targetPct > 0.6) {
      const autoWinnerId = challengerPct > 0.6
        ? duel.challenger_id
        : duel.target_id;

      await resolveDuel(duelId, autoWinnerId, 'community_vote', db);
      autoResolved = true;
    }
  }

  return {
    voted:         true,
    duel_id:       duelId,
    voted_for:     participantId,
    total_votes:   totalVotes,
    auto_resolved: autoResolved,
  };
}

// ── GET ACTIVE DUELS ─────────────────────────────────────────

export async function getActiveDuels(limit, offset, db) {
  const now = nowISO();

  const { results } = await db
    .prepare(`
      SELECT
        d.id, d.title, d.duel_tip_amount, d.status,
        d.ends_at, d.created_at, d.announced_at,
        d.is_public_announced, d.stream_ready, d.stream_url,
        d.audience_tips_challenger, d.audience_tips_target,
        d.community_vote_challenger, d.community_vote_target,
        CASE
          WHEN d.ends_at IS NOT NULL
            THEN MAX(0, CAST((julianday(d.ends_at) - julianday(?)) * 86400 AS INTEGER))
          ELSE NULL
        END AS time_remaining_seconds,
        uc.username AS challenger_username, uc.league AS challenger_league,
        ut.username AS target_username,     ut.league AS target_league
      FROM duels d
      JOIN users uc ON uc.id = d.challenger_id
      JOIN users ut ON ut.id = d.target_id
      WHERE d.status IN ('pending', 'active')
      ORDER BY d.created_at DESC
      LIMIT ? OFFSET ?
    `)
    .bind(now, limit ?? 20, offset ?? 0)
    .all();

  return results;
}

// ── GET SINGLE DUEL ──────────────────────────────────────────

export async function getDuelById(duelId, db) {
  const now = nowISO();

  return await db
    .prepare(`
      SELECT
        d.*,
        CASE
          WHEN d.ends_at IS NOT NULL
            THEN MAX(0, CAST((julianday(d.ends_at) - julianday(?)) * 86400 AS INTEGER))
          ELSE NULL
        END AS time_remaining_seconds,
        uc.username AS challenger_username, uc.league AS challenger_league,
        ut.username AS target_username,     ut.league AS target_league
      FROM duels d
      JOIN users uc ON uc.id = d.challenger_id
      JOIN users ut ON ut.id = d.target_id
      WHERE d.id = ?
    `)
    .bind(now, duelId)
    .first();
}
