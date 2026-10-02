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
import { notificationEnabled } from './notifications.js';

const DUEL_EXPIRY_HOURS   = 48;
const DEFAULT_DUEL_DAYS   = 7;
const MIN_DUEL_TIP_AMOUNT = 5;
const DUEL_PLATFORM_FEE_RATE = 0.05; // 5%, matches regular tips/challenges

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

    const {
    target_username, title, description, duel_tip_amount,
    duel_type, quick_game_type,
  } = body;

  if (!target_username)                          return { error: 'target_username is required' };
  if (!title || title.trim().length === 0)       return { error: 'title is required' };
  if (!duel_tip_amount || duel_tip_amount < MIN_DUEL_TIP_AMOUNT) {
    return { error: `Minimum duel tip amount is $${MIN_DUEL_TIP_AMOUNT}` };
  }

  const duelType = duel_type === 'quick' ? 'quick' : 'proof';
  const VALID_QUICK_GAMES = ['reflex_tap', 'trivia'];
  if (duelType === 'quick' && !VALID_QUICK_GAMES.includes(quick_game_type)) {
    return { error: `quick_game_type must be one of: ${VALID_QUICK_GAMES.join(', ')}` };
  }
  const quickGameType = duelType === 'quick' ? quick_game_type : null;

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

  // Escrow the challenger's stake right now — money must actually be
  // there before a duel can be created, not just checked later at payout.
  const challengerWallet = await db
    .prepare(`SELECT balance_usd FROM wallets WHERE user_id = ?`)
    .bind(challengerId)
    .first();

  if (!challengerWallet || challengerWallet.balance_usd < duel_tip_amount) {
    return { error: 'Insufficient wallet balance to stake this duel' };
  }

  const now       = new Date();
  const expiresAt = new Date(now.getTime() + DUEL_EXPIRY_HOURS * 60 * 60 * 1000);
  const duelId    = crypto.randomUUID();

  await db.batch([
    db.prepare(`
      UPDATE wallets SET balance_usd = balance_usd - ?, updated_at = ?
      WHERE user_id = ?
    `).bind(duel_tip_amount, now.toISOString(), challengerId),

    db.prepare(`
      INSERT INTO duels
        (id, challenger_id, target_id, title, description,
         duel_tip_amount, status, expires_at, created_at,
         duel_type, quick_game_type)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `).bind(
      duelId,
      challengerId,
      target.id,
      title.trim(),
      description ?? null,
      duel_tip_amount,
      expiresAt.toISOString(),
      now.toISOString(),
      duelType,
      quickGameType,
    ),
  ]);
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
      duel_type:       duelType,
      quick_game_type: quickGameType,
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
    // Refund the challenger's escrowed stake — the duel never happened.
    await db.batch([
      db.prepare(`UPDATE duels SET status = 'expired' WHERE id = ?`).bind(duelId),
      db.prepare(`
        UPDATE wallets SET balance_usd = balance_usd + ?, updated_at = ?
        WHERE user_id = ?
      `).bind(duel.duel_tip_amount, nowISO(), duel.challenger_id),
    ]);
    return { error: 'Duel invitation has expired' };
  }

  // Escrow the target's stake now, matching the challenger's stake
  // already escrowed at creation. Both stakes must be collected before
  // the duel can go active.
  const targetWallet = await db
    .prepare(`SELECT balance_usd FROM wallets WHERE user_id = ?`)
    .bind(userId)
    .first();

  if (!targetWallet || targetWallet.balance_usd < duel.duel_tip_amount) {
    return { error: 'Insufficient wallet balance to accept this stake' };
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
      UPDATE wallets SET balance_usd = balance_usd - ?, updated_at = ?
      WHERE user_id = ?
    `).bind(duel.duel_tip_amount, now.toISOString(), userId),

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

  await db.batch([
    db.prepare(`UPDATE duels SET status = 'declined' WHERE id = ?`).bind(duelId),
    db.prepare(`
      UPDATE wallets SET balance_usd = balance_usd + ?, updated_at = ?
      WHERE user_id = ?
    `).bind(duel.duel_tip_amount, nowISO(), duel.challenger_id),
  ]);

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
    if (!(await notificationEnabled(watcher.user_id, 'challenge_updates', db))) continue;
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
// Auto-resolve removed — voting just records the vote now; the
// winner is only tallied once, at window close (see closeDuelWindow).

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

  return {
    voted:     true,
    duel_id:   duelId,
    voted_for: participantId,
  };
}

// ── FEATURE: SUBMIT QUICK DUEL SCORE ─────────────────────────
// Records one participant's score for a Quick Duel (duel_type =
// 'quick'). Blind-then-reveal: scores are stored but neither
// player's score is exposed until BOTH have submitted, at which
// point the higher score wins and payout is released immediately
// via the existing releaseDuelEscrow — no vote or dispute window,
// since the game itself is the proof.

export async function submitQuickDuelScore(duelId, clerkId, score, db) {
  const userId = await resolveUserId(clerkId, db);
  if (!userId) return { error: 'User not found' };

  if (typeof score !== 'number' || score < 0) {
    return { error: 'A valid score is required' };
  }

  const duel = await db
    .prepare(`SELECT * FROM duels WHERE id = ?`)
    .bind(duelId)
    .first();

  if (!duel)                       return { error: 'Duel not found' };
  if (duel.duel_type !== 'quick')  return { error: 'This duel is not a Quick Duel' };
  if (duel.status !== 'active')    return { error: 'Duel is not active' };
  if (duel.challenger_id !== userId && duel.target_id !== userId) {
    return { error: 'You are not a participant in this duel' };
  }

  const isChallenger = duel.challenger_id === userId;
  const now          = nowISO();

  let result = await db
    .prepare(`SELECT * FROM quick_duel_results WHERE duel_id = ?`)
    .bind(duelId)
    .first();

  if (!result) {
    await db.prepare(`
      INSERT INTO quick_duel_results (id, duel_id, created_at)
      VALUES (?, ?, ?)
    `).bind(crypto.randomUUID(), duelId, now).run();

    result = await db
      .prepare(`SELECT * FROM quick_duel_results WHERE duel_id = ?`)
      .bind(duelId)
      .first();
  }

  const alreadySubmitted = isChallenger
    ? result.challenger_submitted_at
    : result.target_submitted_at;

  if (alreadySubmitted) {
    return { error: 'You have already submitted a score for this duel' };
  }

  const scoreField     = isChallenger ? 'challenger_score'          : 'target_score';
  const submittedField = isChallenger ? 'challenger_submitted_at'   : 'target_submitted_at';

  await db.prepare(`
    UPDATE quick_duel_results SET ${scoreField} = ?, ${submittedField} = ? WHERE duel_id = ?
  `).bind(score, now, duelId).run();

  const updated = await db
    .prepare(`SELECT * FROM quick_duel_results WHERE duel_id = ?`)
    .bind(duelId)
    .first();

  const bothIn = updated.challenger_submitted_at && updated.target_submitted_at;

  if (!bothIn) {
    return { submitted: true, duel_id: duelId, waiting_on_opponent: true };
  }

  // Both scores are in — resolve immediately, no vote/dispute window
  let winnerId;
  if (updated.challenger_score > updated.target_score)      winnerId = duel.challenger_id;
  else if (updated.target_score > updated.challenger_score) winnerId = duel.target_id;
  else {
    // True tie — needs admin review, same path as a tied vote duel
    await db.prepare(`
      UPDATE duels SET status = 'tied', dispute_status = 'reported', resolved_at = ? WHERE id = ?
    `).bind(now, duelId).run();
    return {
      submitted: true, duel_id: duelId, both_submitted: true, tied: true,
      needs_admin_review: true,
    };
  }

  const payout = await releaseDuelEscrow(duelId, winnerId, duel, db);
  if (payout.error) return payout;

  await db.prepare(`
    UPDATE duels
    SET winner_id = ?, status = 'resolved', resolved_at = ?
    WHERE id = ?
  `).bind(winnerId, now, duelId).run();

  return {
    submitted:        true,
    duel_id:          duelId,
    both_submitted:   true,
    winner_id:        winnerId,
    challenger_score: updated.challenger_score,
    target_score:     updated.target_score,
    payout,
  };
}

// ── CLOSE DUEL WINDOW ────────────────────────────────────────
// Triggered by cron when duel.ends_at has passed and status is
// still 'active'. Winner = simple majority of duel_votes. Does
// NOT release any payout — that only happens after the dispute
// window closes uncontested (see finaliseDuelPayouts) or an admin
// resolves a report via decideDuelDispute.

export async function closeDuelWindow(duelId, db) {
  const duel = await db
    .prepare(`SELECT * FROM duels WHERE id = ?`)
    .bind(duelId)
    .first();

  if (!duel)                     return { error: 'Duel not found' };
  if (duel.status !== 'active')  return { error: `Duel is not active (status: ${duel.status})` };

  const challengerVotes = duel.community_vote_challenger ?? 0;
  const targetVotes     = duel.community_vote_target ?? 0;

  let winnerId = null;
  if (challengerVotes > targetVotes)      winnerId = duel.challenger_id;
  else if (targetVotes > challengerVotes) winnerId = duel.target_id;
  // Tie → winnerId stays null, goes to admin review instead of a dispute window

  const now             = nowISO();
  const disputeDeadline = new Date(Date.now() + 4.5 * 60 * 60 * 1000).toISOString();

  if (!winnerId) {
    await db.prepare(`
      UPDATE duels SET status = 'tied', dispute_status = 'reported', resolved_at = ? WHERE id = ?
    `).bind(now, duelId).run();

    return { duel_id: duelId, tied: true, needs_admin_review: true };
  }

  await db.prepare(`
    UPDATE duels
    SET winner_id = ?, dispute_status = 'window_open', dispute_deadline = ?
    WHERE id = ?
  `).bind(winnerId, disputeDeadline, duelId).run();

  return {
    duel_id:          duelId,
    winner_id:        winnerId,
    dispute_deadline: disputeDeadline,
  };
}

// ── REPORT DUEL CHEATING ─────────────────────────────────────
// Only the losing participant can report, only while the dispute
// window is open. Holds the payout by moving dispute_status to
// 'reported' — finaliseDuelPayouts will skip any duel in this
// state, and it becomes visible in the admin dispute queue instead.

export async function reportDuelCheating(duelId, clerkId, reason, db) {
  const userId = await resolveUserId(clerkId, db);
  if (!userId) return { error: 'User not found' };

  const duel = await db
    .prepare(`SELECT * FROM duels WHERE id = ?`)
    .bind(duelId)
    .first();

  if (!duel)                                return { error: 'Duel not found' };
  if (duel.dispute_status !== 'window_open') return { error: 'This duel is not open for reporting' };
  if (!duel.winner_id)                      return { error: 'Duel has no winner yet' };
  if (duel.winner_id === userId)            return { error: 'Only the losing participant can report' };
  if (userId !== duel.challenger_id && userId !== duel.target_id) {
    return { error: 'You are not a participant in this duel' };
  }
  if (new Date(duel.dispute_deadline) <= new Date()) {
    return { error: 'The dispute window has closed' };
  }
  if (!reason || reason.trim().length === 0) {
    return { error: 'A reason is required to report' };
  }

  await db.prepare(`
    UPDATE duels
    SET dispute_status = 'reported', dispute_reported_by = ?, dispute_reason = ?
    WHERE id = ?
  `).bind(userId, reason.trim(), duelId).run();

  return { reported: true, duel_id: duelId };
}

// ── ADMIN: DECIDE DUEL DISPUTE ────────────────────────────────
// decision: 'upheld' (report was valid — flip the winner to the
// original loser and release escrow to them) or 'rejected' (report
// was invalid — release escrow to the original winner as normal).
// Mirrors the shape of decideAppeal() in disputeResolution.js.

export async function decideDuelDispute(duelId, decision, adminId, db, winnerId = null) {
  const duel = await db
    .prepare(`SELECT * FROM duels WHERE id = ?`)
    .bind(duelId)
    .first();

  if (!duel) return { error: 'Duel not found' };

  // Tied duel: admin must supply an explicit winner_id — 'upheld'/'rejected' don't apply
  if (duel.status === 'tied') {
    if (!winnerId) {
      return { error: 'winner_id is required to resolve a tied duel' };
    }
    if (winnerId !== duel.challenger_id && winnerId !== duel.target_id) {
      return { error: 'winner_id must be one of the two duel participants' };
    }
    const payout = await releaseDuelEscrow(duelId, winnerId, duel, db);
    if (payout.error) return payout;

    await db.prepare(`
      UPDATE duels
      SET winner_id = ?, dispute_status = 'resolved', status = 'resolved', resolved_at = ?
      WHERE id = ?
    `).bind(winnerId, nowISO(), duelId).run();

    return { resolved: true, duel_id: duelId, winner_id: winnerId, decision: 'tie_resolved' };
  }

  // Reported-cheating dispute path (not a tie)
  if (!['upheld', 'rejected'].includes(decision)) {
    return { error: 'decision must be upheld or rejected' };
  }
  if (duel.dispute_status !== 'reported') {
    return { error: 'This duel has no pending dispute' };
  }

  let finalWinnerId = duel.winner_id;

  if (decision === 'upheld') {
    // Report was valid — flip winner to whoever was NOT the original winner
    finalWinnerId = duel.winner_id === duel.challenger_id
      ? duel.target_id
      : duel.challenger_id;
  }

  const payout = await releaseDuelEscrow(duelId, finalWinnerId, duel, db);
  if (payout.error) return payout;

  await db.prepare(`
    UPDATE duels
    SET winner_id = ?, dispute_status = 'resolved', status = 'resolved', resolved_at = ?
    WHERE id = ?
  `).bind(finalWinnerId, nowISO(), duelId).run();

  return { resolved: true, duel_id: duelId, winner_id: finalWinnerId, decision };
}

// ── SHARED PAYOUT LOGIC ───────────────────────────────────────
// Called by both decideDuelDispute (admin path) and
// finaliseDuelPayouts (auto-release cron, Stage 4). Credits the
// winner with both stakes + both escrowed audience tip totals in
// one wallet update, and marks all related tips as completed.

export async function releaseDuelEscrow(duelId, winnerId, duel, db) {
  if (duel.payout_released) return { error: 'Payout already released for this duel' };

    const loserId = winnerId === duel.challenger_id ? duel.target_id : duel.challenger_id;
  const now     = nowISO();

  // Both stakes were already escrowed out of both wallets at creation
  // (challenger) and acceptance (target) — see createDuel/acceptDuel.
  // Nothing needs debiting from anyone here; the full pot just needs
  // to be paid out to the winner.
  const totalEscrow =
    (duel.duel_tip_amount * 2) +
    (duel.audience_tips_challenger ?? 0) +
    (duel.audience_tips_target ?? 0);

  const platformFee = Math.round(totalEscrow * DUEL_PLATFORM_FEE_RATE * 100) / 100;
  const netPayout    = totalEscrow - platformFee;

  await db.batch([
    db.prepare(`
      UPDATE wallets SET balance_usd = balance_usd + ?, updated_at = ?
      WHERE user_id = ?
    `).bind(netPayout, now, winnerId),
    db.prepare(`
      UPDATE tips
      SET platform_fee_cents = ROUND(amount_cents * ?),
          receiver_net_cents = amount_cents - ROUND(amount_cents * ?)
      WHERE duel_id = ? AND status = 'escrowed'
    `).bind(DUEL_PLATFORM_FEE_RATE, DUEL_PLATFORM_FEE_RATE, duelId),

    db.prepare(`
      UPDATE tips SET status = 'completed', completed_at = ? WHERE duel_id = ?
    `).bind(now, duelId),

    db.prepare(`
      UPDATE duels SET payout_released = 1 WHERE id = ?
    `).bind(duelId),
  ]);

  await addScoreEvent(
    winnerId, 'challenge_win', null,
    { challenge_id: duelId, note: `Won duel: ${duel.title}` },
    db,
  );

  return { winner_id: winnerId, loser_id: loserId, total_payout: netPayout, platform_fee: platformFee };
}

// ── CRON: PROCESS DUEL WINDOWS + PAYOUTS ─────────────────────
// Runs every 15 minutes (see wrangler.jsonc + index.js scheduled()).
// Two jobs: (1) close any active duel whose window has ended,
// tallying votes; (2) release escrow for any duel whose dispute
// window has closed uncontested.

export async function processDuelCron(db) {
  const now = nowISO();

  // Job 0 — refund and expire pending duels nobody ever accepted/declined
  const { results: toExpire } = await db
    .prepare(`SELECT id, challenger_id, duel_tip_amount FROM duels WHERE status = 'pending' AND expires_at <= ?`)
    .bind(now)
    .all();

  for (const row of toExpire) {
    try {
      await db.batch([
        db.prepare(`UPDATE duels SET status = 'expired' WHERE id = ?`).bind(row.id),
        db.prepare(`
          UPDATE wallets SET balance_usd = balance_usd + ?, updated_at = ?
          WHERE user_id = ?
        `).bind(row.duel_tip_amount, now, row.challenger_id),
      ]);
    } catch (err) {
      console.error(`processDuelCron: expire+refund failed for ${row.id}:`, err);
    }
  }

  // Job 1 — close windows that have ended
  const { results: toClose } = await db
    .prepare(`SELECT id FROM duels WHERE status = 'active' AND ends_at <= ?`)
    .bind(now)
    .all();

  for (const row of toClose) {
    try {
      await closeDuelWindow(row.id, db);
    } catch (err) {
      console.error(`processDuelCron: closeDuelWindow failed for ${row.id}:`, err);
    }
  }

  // Job 2 — release escrow for uncontested duels past their dispute deadline
  const { results: toRelease } = await db
    .prepare(`
      SELECT * FROM duels
      WHERE dispute_status = 'window_open'
        AND dispute_deadline <= ?
        AND payout_released = 0
    `)
    .bind(now)
    .all();

  for (const duel of toRelease) {
    try {
      const payout = await releaseDuelEscrow(duel.id, duel.winner_id, duel, db);
      if (!payout.error) {
        await db.prepare(`
          UPDATE duels SET dispute_status = 'resolved', status = 'resolved', resolved_at = ? WHERE id = ?
        `).bind(nowISO(), duel.id).run();
      }
    } catch (err) {
      console.error(`processDuelCron: releaseDuelEscrow failed for ${duel.id}:`, err);
    }
  }

  return { closed: toClose.length, released: toRelease.length };
}

// ── GET ACTIVE DUELS ─────────────────────────────────────────

export async function getActiveDuels(limit, offset, viewerId, db) {
  const now = nowISO();
  const { results } = await db
    .prepare(`
      SELECT
        d.id, d.title, d.duel_tip_amount, d.status,
        d.ends_at, d.created_at, d.announced_at,
        d.is_public_announced, d.stream_ready, d.stream_url,
        d.audience_tips_challenger, d.audience_tips_target,
        d.community_vote_challenger, d.community_vote_target,
        d.winner_id, d.dispute_status, d.dispute_deadline,
        d.challenger_id, d.target_id, d.resolved_at,
        d.duel_type, d.quick_game_type,
        CASE
          WHEN d.winner_id = d.challenger_id THEN uc.username
          WHEN d.winner_id = d.target_id     THEN ut.username
          ELSE NULL
        END AS winner_username,
        CASE WHEN d.challenger_id = ? THEN 1 ELSE 0 END AS is_challenger,
        CASE WHEN d.target_id     = ? THEN 1 ELSE 0 END AS is_opponent,
        CASE
          WHEN d.dispute_status = 'window_open'
           AND d.winner_id IS NOT NULL
           AND ? IN (d.challenger_id, d.target_id)
           AND ? != d.winner_id
          THEN 1 ELSE 0
        END AS is_loser,
        CASE
          WHEN d.ends_at IS NOT NULL
            THEN MAX(0, CAST((julianday(d.ends_at) - julianday(?)) * 86400 AS INTEGER))
          ELSE NULL
        END AS time_remaining_seconds,
        uc.username AS challenger_username, uc.league AS challenger_league,
        uc.avatar_url AS challenger_avatar_url,
        ut.username AS target_username,     ut.league AS target_league,
        ut.avatar_url AS target_avatar_url
      FROM duels d
      JOIN users uc ON uc.id = d.challenger_id
      JOIN users ut ON ut.id = d.target_id
      WHERE d.status IN ('pending', 'active', 'resolved', 'tied')
      ORDER BY d.created_at DESC
      LIMIT ? OFFSET ?
    `)
    .bind(viewerId, viewerId, viewerId, viewerId, now, limit ?? 20, offset ?? 0)
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
        uc.avatar_url AS challenger_avatar_url,
        ut.username AS target_username,     ut.league AS target_league,
        ut.avatar_url AS target_avatar_url
      FROM duels d
      JOIN users uc ON uc.id = d.challenger_id
      JOIN users ut ON ut.id = d.target_id
      WHERE d.id = ?
    `)
    .bind(now, duelId)
    .first();
}
