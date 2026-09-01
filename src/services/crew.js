// ============================================================
// CREW BATTLES SERVICE — Module Chat F Feature 6
// Fix (Finding 3): all three entry points receive the CLERK id
// from the route layer (requireAuth), but wallets/crews/crew_members
// are keyed on the INTERNAL DB user id. Resolve clerk_id -> id
// before any read/write against those tables.
// ============================================================

import { addScoreEvent } from './aurumScore.js';
import { calcNetPayout } from './battleShared.js';

function nowISO() {
  return new Date().toISOString();
}

async function getOrCreateCrewWallet(crewId, db) {
  let wallet = await db
    .prepare(`SELECT * FROM crew_wallets WHERE crew_id = ?`)
    .bind(crewId)
    .first();

  if (!wallet) {
    const now = nowISO();
    const walletId = crypto.randomUUID();
    await db
      .prepare(`
        INSERT INTO crew_wallets (id, crew_id, balance_usd, total_funded_usd, total_spent_usd, created_at, updated_at)
        VALUES (?, ?, 0, 0, 0, ?, ?)
      `)
      .bind(walletId, crewId, now, now)
      .run();
    wallet = { id: walletId, crew_id: crewId, balance_usd: 0, total_funded_usd: 0, total_spent_usd: 0, created_at: now, updated_at: now };
  }

  return wallet;
}

// ── INITIATE CREW SPEND (captain only) ───────────────────────

export async function initiateCrewSpend(crewId, clerkId, body, db) {
  const userRow = await db
    .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
    .bind(clerkId)
    .first();
  if (!userRow) return { error: 'User not found' };
  const userId = userRow.id;

  const { amount_usd, reason } = body;

  if (!amount_usd || amount_usd <= 0) return { error: 'amount_usd must be a positive number' };
  if (!reason || reason.trim().length === 0) return { error: 'A reason is required for every crew spend' };

  const membership = await db
    .prepare(`SELECT role FROM crew_members WHERE crew_id = ? AND user_id = ?`)
    .bind(crewId, userId)
    .first();

  if (!membership) return { error: 'You are not a member of this crew' };
  if (membership.role !== 'captain') return { error: 'Only the crew captain can initiate a spend' };

  const crewRow = await db.prepare(`SELECT is_frozen FROM crews WHERE id = ?`).bind(crewId).first();
  if (crewRow?.is_frozen) return { error: 'This crew\'s wallet is frozen — spends are blocked until an admin lifts the freeze' };

  const wallet = await getOrCreateCrewWallet(crewId, db);
  if (wallet.balance_usd < amount_usd) {
    return { error: `Crew wallet balance ($${wallet.balance_usd}) is less than the requested spend ($${amount_usd})` };
  }

  const { results: moderators } = await db
    .prepare(`SELECT user_id FROM crew_members WHERE crew_id = ? AND role = 'moderator'`)
    .bind(crewId)
    .all();

  const now = nowISO();
  const txnId = crypto.randomUUID();
  const requiredCosigns = moderators.length;

  if (requiredCosigns === 0) {
    // No moderators to co-sign — execute immediately
    const newBalance = wallet.balance_usd - amount_usd;

    await db.batch([
      db.prepare(`
        UPDATE crew_wallets SET balance_usd = ?, total_spent_usd = total_spent_usd + ?, updated_at = ?
        WHERE id = ?
      `).bind(newBalance, amount_usd, now, wallet.id),

      db.prepare(`
        INSERT INTO crew_wallet_transactions
          (id, crew_id, crew_wallet_id, type, amount_usd, balance_after_usd, initiated_by, reason, status, required_cosigns, created_at)
        VALUES (?, ?, ?, 'spend', ?, ?, ?, ?, 'executed', 0, ?)
      `).bind(txnId, crewId, wallet.id, amount_usd, newBalance, userId, reason.trim(), now),
    ]);

    return { spend: { id: txnId, status: 'executed', amount_usd, reason: reason.trim(), note: 'No moderators in this crew — spend executed immediately' } };
  }

  // Moderators exist — spend waits for all of them to co-sign
  await db
    .prepare(`
      INSERT INTO crew_wallet_transactions
        (id, crew_id, crew_wallet_id, type, amount_usd, balance_after_usd, initiated_by, reason, status, required_cosigns, created_at)
      VALUES (?, ?, ?, 'spend', ?, NULL, ?, ?, 'pending_cosign', ?, ?)
    `)
    .bind(txnId, crewId, wallet.id, amount_usd, userId, reason.trim(), requiredCosigns, now)
    .run();

  return {
    spend: {
      id: txnId,
      status: 'pending_cosign',
      amount_usd,
      reason: reason.trim(),
      required_cosigns: requiredCosigns,
      cosigns_received: 0,
    },
  };
}

// ── CO-SIGN CREW SPEND (moderator only) ───────────────────────

export async function cosignCrewSpend(transactionId, clerkId, db) {
  const userRow = await db
    .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
    .bind(clerkId)
    .first();
  if (!userRow) return { error: 'User not found' };
  const userId = userRow.id;

  const txn = await db
    .prepare(`SELECT * FROM crew_wallet_transactions WHERE id = ?`)
    .bind(transactionId)
    .first();

  if (!txn) return { error: 'Spend not found' };
  if (txn.status !== 'pending_cosign') return { error: `This spend is already ${txn.status}` };

  const membership = await db
    .prepare(`SELECT role FROM crew_members WHERE crew_id = ? AND user_id = ?`)
    .bind(txn.crew_id, userId)
    .first();

  if (!membership || membership.role !== 'moderator') {
    return { error: 'Only a crew moderator can co-sign a spend' };
  }

  const already = await db
    .prepare(`SELECT id FROM crew_wallet_cosigns WHERE transaction_id = ? AND moderator_id = ?`)
    .bind(transactionId, userId)
    .first();

  if (already) return { error: 'You have already co-signed this spend' };

  await db
    .prepare(`
      INSERT INTO crew_wallet_cosigns (id, transaction_id, moderator_id, signed_at)
      VALUES (?, ?, ?, ?)
    `)
    .bind(crypto.randomUUID(), transactionId, userId, nowISO())
    .run();

  const { results: signs } = await db
    .prepare(`SELECT moderator_id FROM crew_wallet_cosigns WHERE transaction_id = ?`)
    .bind(transactionId)
    .all();

  if (signs.length < txn.required_cosigns) {
    return {
      spend: {
        id: transactionId,
        status: 'pending_cosign',
        required_cosigns: txn.required_cosigns,
        cosigns_received: signs.length,
      },
    };
  }

  // All moderators have signed — execute the spend now
  // All moderators have signed — execute the spend now
  const crewRow = await db.prepare(`SELECT is_frozen FROM crews WHERE id = ?`).bind(txn.crew_id).first();
  if (crewRow?.is_frozen) {
    return { error: 'This crew\'s wallet is frozen — the spend has all required co-signs but cannot execute until an admin lifts the freeze', all_cosigns_received: true };
  }

  const wallet = await db
    .prepare(`SELECT * FROM crew_wallets WHERE id = ?`)
    .bind(txn.crew_wallet_id)
    .first();

  if (wallet.balance_usd < txn.amount_usd) {
    return { error: 'Crew wallet balance has dropped below this spend amount since it was initiated — cannot execute' };
  }

  const now = nowISO();
  const newBalance = wallet.balance_usd - txn.amount_usd;

  await db.batch([
    db.prepare(`
      UPDATE crew_wallets SET balance_usd = ?, total_spent_usd = total_spent_usd + ?, updated_at = ?
      WHERE id = ?
    `).bind(newBalance, txn.amount_usd, now, wallet.id),

    db.prepare(`
      UPDATE crew_wallet_transactions SET status = 'executed', balance_after_usd = ?
      WHERE id = ?
    `).bind(newBalance, transactionId),
  ]);

  return {
    spend: {
      id: transactionId,
      status: 'executed',
      amount_usd: txn.amount_usd,
      balance_after_usd: newBalance,
    },
  };
}

// ── VETO CREW SPEND (any single moderator) ────────────────────

export async function vetoCrewSpend(transactionId, clerkId, reasonBody, db) {
  const userRow = await db
    .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
    .bind(clerkId)
    .first();
  if (!userRow) return { error: 'User not found' };
  const userId = userRow.id;

  const txn = await db
    .prepare(`SELECT * FROM crew_wallet_transactions WHERE id = ?`)
    .bind(transactionId)
    .first();

  if (!txn) return { error: 'Spend not found' };
  if (txn.status !== 'pending_cosign') return { error: `This spend is already ${txn.status}` };

  const membership = await db
    .prepare(`SELECT role FROM crew_members WHERE crew_id = ? AND user_id = ?`)
    .bind(txn.crew_id, userId)
    .first();

  if (!membership || membership.role !== 'moderator') {
    return { error: 'Only a crew moderator can veto a spend' };
  }

  await db
    .prepare(`
      UPDATE crew_wallet_transactions
      SET status = 'vetoed', reason = reason || ' [VETOED: ' || ? || ']'
      WHERE id = ?
    `)
    .bind((reasonBody?.veto_reason ?? 'no reason given').trim(), transactionId)
    .run();

  return { spend: { id: transactionId, status: 'vetoed' } };
}

// ── INVITE TO CREW (captain only) ────────────────────────────

export async function inviteToCrew(crewId, clerkId, targetUserId, db) {
  const userRow = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(clerkId).first();
  if (!userRow) return { error: 'User not found' };
  const userId = userRow.id;

  const membership = await db
    .prepare(`SELECT role FROM crew_members WHERE crew_id = ? AND user_id = ?`)
    .bind(crewId, userId)
    .first();
  if (!membership || membership.role !== 'captain') return { error: 'Only the crew captain can send invites' };

  const targetMembership = await db
    .prepare(`SELECT id FROM crew_members WHERE user_id = ?`)
    .bind(targetUserId)
    .first();
  if (targetMembership) return { error: 'That user is already in a crew' };

  const existing = await db
    .prepare(`SELECT id FROM crew_join_requests WHERE crew_id = ? AND user_id = ? AND status = 'pending'`)
    .bind(crewId, targetUserId)
    .first();
  if (existing) return { error: 'There is already a pending invite or request for this user' };

    const id = crypto.randomUUID();
  const now = nowISO();
  const crewRow = await db.prepare(`SELECT name FROM crews WHERE id = ?`).bind(crewId).first();

  await db.batch([
    db.prepare(`
      INSERT INTO crew_join_requests (id, crew_id, user_id, type, status, created_at)
      VALUES (?, ?, ?, 'invite', 'pending', ?)
    `).bind(id, crewId, targetUserId, now),

    db.prepare(`
      INSERT INTO notifications (id, user_id, type, title, body, action_url, created_at)
      VALUES (?, ?, 'crew_invite', 'Crew Invite', ?, '/crews', ?)
    `).bind(
      crypto.randomUUID(),
      targetUserId,
      `You've been invited to join ${crewRow?.name || 'a crew'}.`,
      now,
    ),
  ]);

  return { invite: { id, crew_id: crewId, target_user_id: targetUserId, status: 'pending' } };
}

  return { invite: { id, crew_id: crewId, target_user_id: targetUserId, status: 'pending' } };
}

// ── REQUEST TO JOIN CREW (any user) ──────────────────────────

export async function requestToJoinCrew(crewId, clerkId, db) {
  const userRow = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(clerkId).first();
  if (!userRow) return { error: 'User not found' };
  const userId = userRow.id;

    const crew = await db.prepare(`SELECT * FROM crews WHERE id = ?`).bind(crewId).first();
  if (!crew) return { error: 'Crew not found' };
  if (crew.is_locked) return { error: 'This crew is locked and not accepting join requests' };

  const kicked = await db
    .prepare(`SELECT id FROM crew_kicks WHERE crew_id = ? AND user_id = ?`)
    .bind(crewId, userId)
    .first();
  if (kicked) return { error: 'You were removed from this crew and need an invite from the captain to rejoin' };

  const membership = await db.prepare(`SELECT id FROM crew_members WHERE user_id = ?`).bind(userId).first();
  if (membership) return { error: 'You are already a member of a crew' };

  const existing = await db
    .prepare(`SELECT id FROM crew_join_requests WHERE crew_id = ? AND user_id = ? AND status = 'pending'`)
    .bind(crewId, userId)
    .first();
  if (existing) return { error: 'You already have a pending invite or request for this crew' };

    const id = crypto.randomUUID();
  const now = nowISO();

  const captainRow = await db
    .prepare(`SELECT user_id FROM crew_members WHERE crew_id = ? AND role = 'captain'`)
    .bind(crewId)
    .first();

  const statements = [
    db.prepare(`
      INSERT INTO crew_join_requests (id, crew_id, user_id, type, status, created_at)
      VALUES (?, ?, ?, 'request', 'pending', ?)
    `).bind(id, crewId, userId, now),
  ];

  if (captainRow) {
    statements.push(
      db.prepare(`
        INSERT INTO notifications (id, user_id, type, title, body, action_url, created_at)
        VALUES (?, ?, 'crew_join_request', 'Join Request', ?, '/crews', ?)
      `).bind(
        crypto.randomUUID(),
        captainRow.user_id,
        `Someone requested to join ${crew.name}.`,
        now,
      )
    );
  }

  await db.batch(statements);

  return { request: { id, crew_id: crewId, status: 'pending' } };
}

// ── RESPOND TO JOIN REQUEST/INVITE ───────────────────────────

export async function respondToJoinRequest(requestId, clerkId, accept, db) {
  const userRow = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(clerkId).first();
  if (!userRow) return { error: 'User not found' };
  const userId = userRow.id;

  const jr = await db.prepare(`SELECT * FROM crew_join_requests WHERE id = ?`).bind(requestId).first();
  if (!jr) return { error: 'Join request not found' };
  if (jr.status !== 'pending') return { error: `This ${jr.type} is already ${jr.status}` };

  if (jr.type === 'invite') {
    if (jr.user_id !== userId) return { error: 'Only the invited user can respond to this invite' };
  } else {
    const membership = await db
      .prepare(`SELECT role FROM crew_members WHERE crew_id = ? AND user_id = ?`)
      .bind(jr.crew_id, userId)
      .first();
    if (!membership || membership.role !== 'captain') return { error: 'Only the crew captain can approve join requests' };
  }

  const now = nowISO();

  if (!accept) {
    await db
      .prepare(`UPDATE crew_join_requests SET status = 'declined', responded_at = ? WHERE id = ?`)
      .bind(now, requestId)
      .run();
    return { request: { id: requestId, status: 'declined' } };
  }

  const alreadyInCrew = await db.prepare(`SELECT id FROM crew_members WHERE user_id = ?`).bind(jr.user_id).first();
  if (alreadyInCrew) return { error: 'That user is already in a crew' };

  await db.batch([
    db.prepare(`UPDATE crew_join_requests SET status = 'accepted', responded_at = ? WHERE id = ?`).bind(now, requestId),
    db.prepare(`
      INSERT INTO crew_members (id, crew_id, user_id, role, joined_at)
      VALUES (?, ?, ?, 'member', ?)
    `).bind(crypto.randomUUID(), jr.crew_id, jr.user_id, now),
    db.prepare(`UPDATE crews SET member_count = member_count + 1 WHERE id = ?`).bind(jr.crew_id),
  ]);

  return { request: { id: requestId, status: 'accepted', crew_id: jr.crew_id } };
}

// ── GET MY PENDING CREW INVITES (invites sent to me) ──────────

export async function getMyPendingCrewInvites(clerkId, db) {
  const userRow = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(clerkId).first();
  if (!userRow) return { error: 'User not found' };

  const { results } = await db
    .prepare(`
      SELECT jr.id, jr.crew_id, jr.created_at, c.name AS crew_name, c.description AS crew_description
      FROM crew_join_requests jr
      JOIN crews c ON c.id = jr.crew_id
      WHERE jr.user_id = ? AND jr.type = 'invite' AND jr.status = 'pending'
      ORDER BY jr.created_at DESC
    `)
    .bind(userRow.id)
    .all();

  return { invites: results };
}

// ── GET PENDING JOIN REQUESTS FOR MY CREW (captain only) ───────

export async function getPendingJoinRequestsForCrew(crewId, clerkId, db) {
  const userRow = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(clerkId).first();
  if (!userRow) return { error: 'User not found' };

  const membership = await db
    .prepare(`SELECT role FROM crew_members WHERE crew_id = ? AND user_id = ?`)
    .bind(crewId, userRow.id)
    .first();
  if (!membership || membership.role !== 'captain') {
    return { error: 'Only the crew captain can view join requests' };
  }

  const { results } = await db
    .prepare(`
      SELECT jr.id, jr.user_id, jr.created_at, u.username, u.league, u.avatar_url
      FROM crew_join_requests jr
      JOIN users u ON u.id = jr.user_id
      WHERE jr.crew_id = ? AND jr.type = 'request' AND jr.status = 'pending'
      ORDER BY jr.created_at DESC
    `)
    .bind(crewId)
    .all();

  return { requests: results };
}

// ── LEAVE CREW (with captaincy succession) ───────────────────

export async function leaveCrew(clerkId, db) {
  const userRow = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(clerkId).first();
  if (!userRow) return { error: 'User not found' };
  const userId = userRow.id;

  const membership = await db.prepare(`SELECT * FROM crew_members WHERE user_id = ?`).bind(userId).first();
  if (!membership) return { error: 'You are not in a crew' };

  const crewId = membership.crew_id;
  const now = nowISO();

  if (membership.role !== 'captain') {
    await db.batch([
      db.prepare(`DELETE FROM crew_members WHERE id = ?`).bind(membership.id),
      db.prepare(`UPDATE crews SET member_count = member_count - 1 WHERE id = ?`).bind(crewId),
    ]);
    return { left: true, crew_id: crewId };
  }

  // Captain is leaving — find successor
  let successor = await db
    .prepare(`SELECT * FROM crew_members WHERE crew_id = ? AND role = 'moderator' AND user_id != ? ORDER BY joined_at ASC LIMIT 1`)
    .bind(crewId, userId)
    .first();

  if (!successor) {
    successor = await db
      .prepare(`SELECT * FROM crew_members WHERE crew_id = ? AND role = 'member' AND user_id != ? ORDER BY joined_at ASC LIMIT 1`)
      .bind(crewId, userId)
      .first();
  }

  if (!successor) {
    // Captain was the only member
    await db.batch([
      db.prepare(`DELETE FROM crew_members WHERE id = ?`).bind(membership.id),
      db.prepare(`UPDATE crews SET member_count = 0 WHERE id = ?`).bind(crewId),
    ]);
    return { left: true, crew_id: crewId, note: 'Crew now has no members' };
  }

  await db.batch([
    db.prepare(`DELETE FROM crew_members WHERE id = ?`).bind(membership.id),
    db.prepare(`UPDATE crew_members SET role = 'captain' WHERE id = ?`).bind(successor.id),
    db.prepare(`UPDATE crews SET member_count = member_count - 1 WHERE id = ?`).bind(crewId),
  ]);

  return { left: true, crew_id: crewId, new_captain_id: successor.user_id };
}

// ── KICK MEMBER (captain only) ────────────────────────────────

export async function kickMember(crewId, clerkId, targetUserId, db) {
  const userRow = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(clerkId).first();
  if (!userRow) return { error: 'User not found' };
  const userId = userRow.id;

  const membership = await db
    .prepare(`SELECT role FROM crew_members WHERE crew_id = ? AND user_id = ?`)
    .bind(crewId, userId)
    .first();
  if (!membership || membership.role !== 'captain') return { error: 'Only the crew captain can remove a member' };
  if (targetUserId === userId) return { error: 'Use leave-crew to remove yourself' };

  const target = await db
    .prepare(`SELECT * FROM crew_members WHERE crew_id = ? AND user_id = ?`)
    .bind(crewId, targetUserId)
    .first();
  if (!target) return { error: 'That user is not a member of this crew' };

  const crewRow = await db.prepare(`SELECT name FROM crews WHERE id = ?`).bind(crewId).first();

    const kickedAt = nowISO();

  await db.batch([
    db.prepare(`DELETE FROM crew_members WHERE id = ?`).bind(target.id),
    db.prepare(`UPDATE crews SET member_count = member_count - 1 WHERE id = ?`).bind(crewId),
    db.prepare(`
      INSERT INTO crew_kicks (id, crew_id, user_id, kicked_at)
      VALUES (?, ?, ?, ?)
    `).bind(crypto.randomUUID(), crewId, targetUserId, kickedAt),
  ]);

  await db.prepare(`
      INSERT INTO notifications (id, user_id, type, title, body, action_url, created_at)
      VALUES (?, ?, 'crew_kicked', 'Removed from crew', ?, ?, ?)
    `)
    .bind(
      crypto.randomUUID(),
      targetUserId,
      `You were removed from ${crewRow?.name || 'a crew'}.`,
      '/crews',
      new Date().toISOString(),
    )
    .run();

  return { kicked: true, crew_id: crewId, target_user_id: targetUserId };
}

// ── LOCK / UNLOCK CREW (captain only) ────────────────────────
export async function setCrewLocked(crewId, clerkId, locked, db) {
  const userRow = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(clerkId).first();
  if (!userRow) return { error: 'User not found' };
  const userId = userRow.id;

  const membership = await db
    .prepare(`SELECT role FROM crew_members WHERE crew_id = ? AND user_id = ?`)
    .bind(crewId, userId)
    .first();
  if (!membership || membership.role !== 'captain') return { error: 'Only the crew captain can lock or unlock the crew' };

  await db.prepare(`UPDATE crews SET is_locked = ? WHERE id = ?`).bind(locked ? 1 : 0, crewId).run();

  return { crew_id: crewId, is_locked: !!locked };
}

// ── PROMOTE / DEMOTE MODERATOR (captain only) ─────────────────

export async function setModeratorRole(crewId, clerkId, targetUserId, makeModerator, db) {
  const userRow = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(clerkId).first();
  if (!userRow) return { error: 'User not found' };
  const userId = userRow.id;

  const membership = await db
    .prepare(`SELECT role FROM crew_members WHERE crew_id = ? AND user_id = ?`)
    .bind(crewId, userId)
    .first();
  if (!membership || membership.role !== 'captain') return { error: 'Only the crew captain can promote or demote moderators' };

  const target = await db
    .prepare(`SELECT * FROM crew_members WHERE crew_id = ? AND user_id = ?`)
    .bind(crewId, targetUserId)
    .first();
  if (!target) return { error: 'That user is not a member of this crew' };
  if (target.role === 'captain') return { error: 'Cannot change the captain\'s role this way' };

  const newRole = makeModerator ? 'moderator' : 'member';
  if (target.role === newRole) return { error: `That member is already a ${newRole}` };

  await db.prepare(`UPDATE crew_members SET role = ? WHERE id = ?`).bind(newRole, target.id).run();

  const crewRow = await db.prepare(`SELECT name FROM crews WHERE id = ?`).bind(crewId).first();
  await db.prepare(`
      INSERT INTO notifications (id, user_id, type, title, body, action_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      crypto.randomUUID(),
      targetUserId,
      makeModerator ? 'crew_promoted' : 'crew_demoted',
      makeModerator ? 'Promoted to Moderator' : 'Moderator role removed',
      makeModerator
        ? `You were promoted to Moderator in ${crewRow?.name || 'your crew'}.`
        : `You are no longer a Moderator in ${crewRow?.name || 'your crew'}.`,
      `/crews/${crewId}`,
      new Date().toISOString(),
    )
    .run();

  return { crew_id: crewId, target_user_id: targetUserId, role: newRole };
}

// ── DISBAND CREW (captain only) ───────────────────────────────

export async function disbandCrew(crewId, clerkId, db) {
  const userRow = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(clerkId).first();
  if (!userRow) return { error: 'User not found' };
  const userId = userRow.id;

  const membership = await db
    .prepare(`SELECT role FROM crew_members WHERE crew_id = ? AND user_id = ?`)
    .bind(crewId, userId)
    .first();
  if (!membership || membership.role !== 'captain') return { error: 'Only the crew captain can disband the crew' };

  const crew = await db.prepare(`SELECT * FROM crews WHERE id = ?`).bind(crewId).first();
  if (!crew) return { error: 'Crew not found' };

  const wallet = await db.prepare(`SELECT * FROM crew_wallets WHERE crew_id = ?`).bind(crewId).first();

  const { results: members } = await db
    .prepare(`SELECT user_id FROM crew_members WHERE crew_id = ?`)
    .bind(crewId)
    .all();

  const now = nowISO();
  const statements = [];
  let splitAmount = 0;
  let perMember = 0;

  if (wallet && wallet.balance_usd > 0 && members.length > 0) {
    splitAmount = wallet.balance_usd;
    perMember = Math.floor((splitAmount / members.length) * 100) / 100; // round down to cents
    const distributed = perMember * members.length;
    const remainder = Math.round((splitAmount - distributed) * 100) / 100; // goes to captain

    for (const member of members) {
      const amount = member.user_id === userId ? perMember + remainder : perMember;
      if (amount <= 0) continue;

      statements.push(
        db.prepare(`
          UPDATE wallets SET balance_usd = balance_usd + ?, updated_at = ? WHERE user_id = ?
        `).bind(amount, now, member.user_id)
      );
      statements.push(
        db.prepare(`
          INSERT INTO wallet_transactions
            (id, wallet_id, user_id, type, amount_usd, balance_after_usd, reference, description, created_at)
          SELECT ?, id, ?, 'challenge_payout', ?,
                 (SELECT balance_usd FROM wallets WHERE user_id = ?), ?, ?, ?
          FROM wallets WHERE user_id = ?
        `).bind(
          crypto.randomUUID(), member.user_id, amount, member.user_id,
          crewId, `Crew disband payout from "${crew.name}"`, now, member.user_id
        )
      );
    }

    statements.push(
      db.prepare(`
        UPDATE crew_wallets SET balance_usd = 0, total_spent_usd = total_spent_usd + ?, updated_at = ?
        WHERE crew_id = ?
      `).bind(splitAmount, now, crewId)
    );
    statements.push(
      db.prepare(`
        INSERT INTO crew_wallet_transactions
          (id, crew_id, crew_wallet_id, type, amount_usd, balance_after_usd, initiated_by, reason, status, required_cosigns, created_at)
        VALUES (?, ?, ?, 'disband_split', ?, 0, ?, ?, 'executed', 0, ?)
      `).bind(crypto.randomUUID(), crewId, wallet.id, splitAmount, userId, `Crew disbanded — balance split among ${members.length} member(s)`, now)
    );
  }

  statements.push(db.prepare(`DELETE FROM crew_members WHERE crew_id = ?`).bind(crewId));
  statements.push(db.prepare(`DELETE FROM crews WHERE id = ?`).bind(crewId));

  await db.batch(statements);

  return {
    disbanded: true,
    crew_id: crewId,
    members_paid: members.length,
    total_split_usd: splitAmount,
  };
}

// ── EDIT CREW RULES (captain only) ────────────────────────────

export async function setCrewRules(crewId, clerkId, rules, db) {
  const userRow = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(clerkId).first();
  if (!userRow) return { error: 'User not found' };
  const userId = userRow.id;

  const membership = await db
    .prepare(`SELECT role FROM crew_members WHERE crew_id = ? AND user_id = ?`)
    .bind(crewId, userId)
    .first();
  if (!membership || membership.role !== 'captain') return { error: 'Only the crew captain can edit crew rules' };

  if (rules && rules.length > 2000) return { error: 'Rules must be 2000 characters or less' };

  await db.prepare(`UPDATE crews SET rules = ? WHERE id = ?`).bind(rules?.trim() ?? null, crewId).run();

  return { crew_id: crewId, rules: rules?.trim() ?? null };
}

// ── MUTE MEMBER (captain or moderator) ─────────────────────────

export async function muteMember(crewId, clerkId, targetUserId, durationHours, reason, db) {
  const userRow = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(clerkId).first();
  if (!userRow) return { error: 'User not found' };
  const userId = userRow.id;

  const membership = await db
    .prepare(`SELECT role FROM crew_members WHERE crew_id = ? AND user_id = ?`)
    .bind(crewId, userId)
    .first();
  if (!membership || (membership.role !== 'captain' && membership.role !== 'moderator')) {
    return { error: 'Only a crew captain or moderator can mute a member' };
  }

  if (!durationHours || durationHours <= 0) return { error: 'durationHours must be a positive number' };
  if (!reason || reason.trim().length === 0) return { error: 'A reason is required to mute a member' };

  const target = await db
    .prepare(`SELECT role FROM crew_members WHERE crew_id = ? AND user_id = ?`)
    .bind(crewId, targetUserId)
    .first();
  if (!target) return { error: 'That user is not a member of this crew' };
  if (target.role === 'captain') return { error: 'Cannot mute the crew captain' };

  const now = nowISO();
  const mutedUntil = new Date(Date.now() + durationHours * 60 * 60 * 1000).toISOString();
  const id = crypto.randomUUID();

  await db
    .prepare(`
      INSERT INTO crew_mutes (id, crew_id, user_id, reason, muted_until, muted_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(id, crewId, targetUserId, reason.trim(), mutedUntil, userId, now)
    .run();

  return { mute: { id, crew_id: crewId, target_user_id: targetUserId, muted_until: mutedUntil, reason: reason.trim() } };
}

// ── CHECK IF MUTED (helper — used elsewhere to gate posting/battles) ──

export async function isMemberMuted(crewId, userId, db) {
  const activeMute = await db
    .prepare(`
      SELECT id, muted_until, reason FROM crew_mutes
      WHERE crew_id = ? AND user_id = ? AND muted_until > ?
      ORDER BY muted_until DESC LIMIT 1
    `)
    .bind(crewId, userId, nowISO())
    .first();

return activeMute ? { muted: true, muted_until: activeMute.muted_until, reason: activeMute.reason } : { muted: false };
}

export async function deleteCrewMessage(messageId, clerkId, db) {
  const userRow = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(clerkId).first();
  if (!userRow) return { error: 'User not found' };
  const userId = userRow.id;

  const message = await db
    .prepare(`SELECT crew_id, deleted_at FROM crew_messages WHERE id = ?`)
    .bind(messageId)
    .first();

  if (!message) return { error: 'Message not found' };
  if (message.deleted_at) return { error: 'Message already deleted' };

  const member = await db
    .prepare(`SELECT role FROM crew_members WHERE crew_id = ? AND user_id = ?`)
    .bind(message.crew_id, userId)
    .first();

  if (!member || (member.role !== 'captain' && member.role !== 'moderator')) {
    return { error: 'Only the Captain or a Moderator can delete crew messages' };
  }

  await db
    .prepare(`UPDATE crew_messages SET deleted_at = ?, deleted_by = ? WHERE id = ?`)
    .bind(new Date().toISOString(), userId, messageId)
    .run();

  return { deleted: true, message_id: messageId };
}

export async function getCrewMessages(crewId, limit, before, db) {
  const params = [crewId];
  let query = `
    SELECT
      m.id, m.sender_id, m.content, m.created_at, m.deleted_at, m.reply_to_message_id,
      r.content AS reply_content, r.deleted_at AS reply_deleted_at,
      ru.username AS reply_sender_username
    FROM crew_messages m
    LEFT JOIN crew_messages r ON r.id = m.reply_to_message_id
    LEFT JOIN users ru ON ru.id = r.sender_id
    WHERE m.crew_id = ?
  `;

  if (before) {
    query += ` AND m.created_at < ?`;
    params.push(before);
  }

  query += ` ORDER BY m.created_at DESC LIMIT ?`;
  params.push(limit || 50);

  const { results } = await db.prepare(query).bind(...params).all();

  return results.map(m => ({
    id: m.id,
    sender_id: m.sender_id,
    content: m.deleted_at ? null : m.content,
    deleted: !!m.deleted_at,
    created_at: m.created_at,
    reply_to: m.reply_to_message_id ? {
      id: m.reply_to_message_id,
      sender_username: m.reply_sender_username,
      content: m.reply_deleted_at ? null : (m.reply_content || '').slice(0, 80),
      deleted: !!m.reply_deleted_at,
    } : null,
  }));
}

// ── CAST CREW BATTLE VOTE (anyone except battle participants) ──

export async function castCrewBattleVote(battleId, clerkId, votedCrewId, db) {
  const userRow = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(clerkId).first();
  if (!userRow) return { error: 'User not found' };
  const userId = userRow.id;

  const battle = await db.prepare(`SELECT * FROM crew_battles WHERE id = ?`).bind(battleId).first();
  if (!battle) return { error: 'Crew battle not found' };
  if (battle.status !== 'active') return { error: 'This battle is not open for voting yet' };
  if (new Date(battle.ends_at) <= new Date()) return { error: 'Voting has closed for this battle' };

  if (votedCrewId !== battle.challenger_crew_id && votedCrewId !== battle.target_crew_id) {
    return { error: 'voted_crew_id must be one of the battling crews' };
  }

  const isParticipant = await db
    .prepare(`
      SELECT id FROM crew_members
      WHERE user_id = ? AND (crew_id = ? OR crew_id = ?)
    `)
    .bind(userId, battle.challenger_crew_id, battle.target_crew_id)
    .first();
  if (isParticipant) return { error: 'Members of either battling crew cannot vote on this battle' };

  const existing = await db
    .prepare(`SELECT id FROM crew_battle_votes WHERE battle_id = ? AND voter_id = ?`)
    .bind(battleId, userId)
    .first();
  if (existing) return { error: 'You have already voted on this battle' };

  await db
    .prepare(`
      INSERT INTO crew_battle_votes (id, battle_id, voter_id, voted_crew_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .bind(crypto.randomUUID(), battleId, userId, votedCrewId, nowISO())
    .run();

  return { voted: true, battle_id: battleId, voted_crew_id: votedCrewId };
}

// ── CLOSE CREW BATTLE WINDOW (tally votes, open dispute window) ──

export async function closeCrewBattleWindow(battleId, db) {
  const battle = await db.prepare(`SELECT * FROM crew_battles WHERE id = ?`).bind(battleId).first();
  if (!battle) return { error: 'Crew battle not found' };
  if (battle.status !== 'active') return { error: 'Battle is not active' };
  if (new Date(battle.ends_at) > new Date()) return { error: 'Battle voting window has not ended yet' };

  const challengerVotes = await db
    .prepare(`SELECT COUNT(*) as c FROM crew_battle_votes WHERE battle_id = ? AND voted_crew_id = ?`)
    .bind(battleId, battle.challenger_crew_id)
    .first();
  const targetVotes = await db
    .prepare(`SELECT COUNT(*) as c FROM crew_battle_votes WHERE battle_id = ? AND voted_crew_id = ?`)
    .bind(battleId, battle.target_crew_id)
    .first();

  const now = nowISO();

  if (challengerVotes.c === targetVotes.c) {
    await db
      .prepare(`UPDATE crew_battles SET status = 'active', dispute_status = 'admin_review' WHERE id = ?`)
      .bind(battleId)
      .run();
    return { battle_id: battleId, result: 'tie', dispute_status: 'admin_review' };
  }

  const winnerCrewId = challengerVotes.c > targetVotes.c ? battle.challenger_crew_id : battle.target_crew_id;
  const disputeDeadline = new Date(Date.now() + 4.5 * 60 * 60 * 1000).toISOString();

  await db
    .prepare(`
      UPDATE crew_battles
      SET status = 'active', winner_crew_id = ?, dispute_status = 'awaiting_dispute', dispute_deadline = ?
      WHERE id = ?
    `)
    .bind(winnerCrewId, disputeDeadline, battleId)
    .run();

  return { battle_id: battleId, winner_crew_id: winnerCrewId, dispute_status: 'awaiting_dispute', dispute_deadline: disputeDeadline };
}

// ── REPORT CREW BATTLE DISPUTE (losing crew's captain only) ────

export async function reportCrewBattleDispute(battleId, clerkId, reason, db) {
  const userRow = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(clerkId).first();
  if (!userRow) return { error: 'User not found' };
  const userId = userRow.id;

  const battle = await db.prepare(`SELECT * FROM crew_battles WHERE id = ?`).bind(battleId).first();
  if (!battle) return { error: 'Crew battle not found' };
  if (battle.dispute_status !== 'awaiting_dispute') return { error: 'This battle is not awaiting a dispute report' };
  if (new Date(battle.dispute_deadline) <= new Date()) return { error: 'The dispute window has closed' };

  const losingCrewId = battle.winner_crew_id === battle.challenger_crew_id
    ? battle.target_crew_id
    : battle.challenger_crew_id;

  const membership = await db
    .prepare(`SELECT role FROM crew_members WHERE crew_id = ? AND user_id = ?`)
    .bind(losingCrewId, userId)
    .first();
  if (!membership || membership.role !== 'captain') {
    return { error: 'Only the losing crew\'s captain can report a dispute' };
  }

  if (!reason || reason.trim().length === 0) return { error: 'A reason is required to report a dispute' };

    await db
    .prepare(`
      UPDATE crew_battles
      SET dispute_status = 'disputed', dispute_reported_by = ?, dispute_reason = ?
      WHERE id = ?
    `)
    .bind(userId, reason.trim(), battleId)
    .run();

  return { battle_id: battleId, dispute_status: 'disputed' };
}

// ── ADMIN: DECIDE CREW BATTLE DISPUTE ─────────────────────────
// Mirrors decideDuelDispute. Two paths: a tied battle sitting in
// dispute_status='admin_review' needs an explicit winnerCrewId
// (no 'upheld'/'rejected' applies); a reported-cheating battle
// sitting in dispute_status='disputed' takes a decision instead.

export async function decideCrewBattleDispute(battleId, decision, adminId, db, winnerCrewId = null) {
  const battle = await db.prepare(`SELECT * FROM crew_battles WHERE id = ?`).bind(battleId).first();
  if (!battle) return { error: 'Crew battle not found' };

  // Tied battle: admin must supply an explicit winner
  if (battle.dispute_status === 'admin_review') {
    if (!winnerCrewId) {
      return { error: 'winner_crew_id is required to resolve a tied battle' };
    }
    if (winnerCrewId !== battle.challenger_crew_id && winnerCrewId !== battle.target_crew_id) {
      return { error: 'winner_crew_id must be one of the two battling crews' };
    }
    const result = await resolveCrewBattle(battleId, winnerCrewId, adminId, db);
    if (result.error) return result;

    return { resolved: true, battle_id: battleId, winner_crew_id: winnerCrewId, decision: 'tie_resolved' };
  }

  // Reported-cheating dispute path (not a tie)
  if (!['upheld', 'rejected'].includes(decision)) {
    return { error: 'decision must be upheld or rejected' };
  }
  if (battle.dispute_status !== 'disputed') {
    return { error: 'This battle has no pending dispute' };
  }
  if (!battle.winner_crew_id) {
    return { error: 'Battle has no winner yet' };
  }

  let finalWinnerCrewId = battle.winner_crew_id;

  if (decision === 'upheld') {
    // Report was valid — flip winner to whichever crew was NOT the original winner
    finalWinnerCrewId = battle.winner_crew_id === battle.challenger_crew_id
      ? battle.target_crew_id
      : battle.challenger_crew_id;
  }

  const result = await resolveCrewBattle(battleId, finalWinnerCrewId, adminId, db);
  if (result.error) return result;

  return { resolved: true, battle_id: battleId, winner_crew_id: finalWinnerCrewId, decision };
}

// ── PROCESS CREW BATTLE CRON (close windows, auto-release uncontested) ──

export async function processCrewBattleCron(db) {
  const now = nowISO();

  // Job 0 — refund and cancel stale pending battles nobody ever accepted/declined
  const { results: toExpire } = await db
    .prepare(`SELECT id, challenger_paid_by, entry_contribution_usd FROM crew_battles WHERE status = 'pending' AND ends_at <= ?`)
    .bind(now)
    .all();

  for (const row of toExpire) {
    try {
      await db.batch([
        db.prepare(`UPDATE crew_battles SET status = 'cancelled' WHERE id = ?`).bind(row.id),
        db.prepare(`
          UPDATE wallets SET balance_usd = balance_usd + ?, updated_at = ?
          WHERE user_id = ?
        `).bind(row.entry_contribution_usd, now, row.challenger_paid_by),
      ]);
    } catch (err) {
      console.error(`processCrewBattleCron: expire+refund failed for ${row.id}:`, err);
    }
  }

  // Job 1 — close any active battles whose voting window has ended
  const { results: toClose } = await db
    .prepare(`
      SELECT id FROM crew_battles
      WHERE status = 'active' AND dispute_status = 'none' AND ends_at <= ?
    `)
    .bind(now)
    .all();

  for (const b of toClose) {
    await closeCrewBattleWindow(b.id, db);
  }

  // Auto-release payouts for battles past their dispute deadline with no report
  const { results: toRelease } = await db
    .prepare(`
      SELECT * FROM crew_battles
      WHERE dispute_status = 'awaiting_dispute' AND dispute_deadline <= ?
    `)
    .bind(now)
    .all();

  const released = [];
  for (const battle of toRelease) {
    const result = await resolveCrewBattle(battle.id, battle.winner_crew_id, null, db);
    if (!result.error) {
      await db.prepare(`UPDATE crew_battles SET dispute_status = 'none' WHERE id = ?`).bind(battle.id).run();
      released.push(battle.id);
    }
  }

  return { closed: toClose.length, released: released.length };
}

// ── FREEZE / UNFREEZE CREW (admin only) ───────────────────────

export async function freezeCrew(crewId, adminId, reason, db) {
  const crew = await db.prepare(`SELECT * FROM crews WHERE id = ?`).bind(crewId).first();
  if (!crew) return { error: 'Crew not found' };
  if (crew.is_frozen) return { error: 'Crew is already frozen' };
  if (!reason || reason.trim().length === 0) return { error: 'A reason is required to freeze a crew' };

  const now = nowISO();
  await db
    .prepare(`
      UPDATE crews
      SET is_frozen = 1, freeze_reason = ?, frozen_by = ?, frozen_at = ?
      WHERE id = ?
    `)
    .bind(reason.trim(), adminId, now, crewId)
    .run();

  return { crew_id: crewId, is_frozen: true, freeze_reason: reason.trim() };
}

export async function unfreezeCrew(crewId, adminId, db) {
  const crew = await db.prepare(`SELECT * FROM crews WHERE id = ?`).bind(crewId).first();
  if (!crew) return { error: 'Crew not found' };
  if (!crew.is_frozen) return { error: 'Crew is not currently frozen' };

  await db
    .prepare(`
      UPDATE crews
      SET is_frozen = 0, freeze_reason = NULL, frozen_by = NULL, frozen_at = NULL
      WHERE id = ?
    `)
    .bind(crewId)
    .run();

  return { crew_id: crewId, is_frozen: false };
}

// ── LIST CREW WALLET TRANSACTIONS ─────────────────────────────
export async function getCrewWalletTransactions(crewId, limit, db) {
  const { results } = await db
    .prepare(`
      SELECT t.id, t.type, t.amount_usd, t.balance_after_usd, t.reason, t.status,
             t.required_cosigns, t.created_at, u.username AS initiated_by_username
      FROM crew_wallet_transactions t
      LEFT JOIN users u ON u.id = t.initiated_by
      WHERE t.crew_id = ?
      ORDER BY t.created_at DESC
      LIMIT ?
    `)
    .bind(crewId, limit ?? 30)
    .all();
  return results;
}
// ── FLAG CREW SPEND (regular members only, 48hr window) ──────
export async function flagCrewSpend(transactionId, clerkId, reason, db) {
  const userRow = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(clerkId).first();
  if (!userRow) return { error: 'User not found' };
  const userId = userRow.id;

  const txn = await db.prepare(`SELECT * FROM crew_wallet_transactions WHERE id = ?`).bind(transactionId).first();
  if (!txn) return { error: 'Spend not found' };
  if (txn.status !== 'executed') return { error: 'Only an executed spend can be flagged' };

  const hoursSinceExecution = (Date.now() - new Date(txn.created_at).getTime()) / (1000 * 60 * 60);
  if (hoursSinceExecution > 48) return { error: 'The 48-hour flagging window for this spend has passed' };

  const membership = await db
    .prepare(`SELECT role FROM crew_members WHERE crew_id = ? AND user_id = ?`)
    .bind(txn.crew_id, userId)
    .first();
  if (!membership) return { error: 'You are not a member of this crew' };
  if (membership.role !== 'member') return { error: 'Only regular members can flag a spend — captains and moderators already had direct input on it' };

  if (!reason || reason.trim().length === 0) return { error: 'A reason is required to flag a spend' };

  const existing = await db
    .prepare(`SELECT id FROM crew_spend_flags WHERE transaction_id = ? AND flagged_by = ?`)
    .bind(transactionId, userId)
    .first();
  if (existing) return { error: 'You have already flagged this spend' };

  const id = crypto.randomUUID();
  await db
    .prepare(`
      INSERT INTO crew_spend_flags (id, transaction_id, flagged_by, reason, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `)
    .bind(id, transactionId, userId, reason.trim(), nowISO())
    .run();

  return { flag: { id, transaction_id: transactionId, status: 'pending' } };
}

// ── RESOLVE CREW SPEND FLAG (admin only) ────────────────────────

export async function resolveCrewSpendFlag(flagId, adminId, decision, adminNotes, db) {
  if (!['dismissed', 'actioned'].includes(decision)) return { error: 'decision must be dismissed or actioned' };

  const flag = await db.prepare(`SELECT * FROM crew_spend_flags WHERE id = ?`).bind(flagId).first();
  if (!flag) return { error: 'Flag not found' };
  if (flag.status !== 'pending') return { error: `This flag is already ${flag.status}` };

  await db
    .prepare(`
      UPDATE crew_spend_flags
      SET status = ?, admin_notes = ?, resolved_by = ?, resolved_at = ?
      WHERE id = ?
    `)
    .bind(decision, adminNotes ?? null, adminId, nowISO(), flagId)
    .run();

  return { flag_id: flagId, status: decision };
}

// ── CREATE CREW ──────────────────────────────────────────────
export async function createCrew(clerkId, body, db) {
  const userRow = await db
    .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
    .bind(clerkId)
    .first();
  if (!userRow) return { error: 'User not found' };
  const userId = userRow.id;

  const { name, description } = body;

  if (!name || name.trim().length === 0) return { error: 'Crew name is required' };
  if (name.trim().length > 50)           return { error: 'Crew name must be 50 characters or less' };

  // Check name is not taken
  const existing = await db
    .prepare(`SELECT id FROM crews WHERE name = ?`)
    .bind(name.trim())
    .first();

  if (existing) return { error: 'A crew with that name already exists' };

  // Check user is not already in a crew
  const membership = await db
    .prepare(`SELECT id FROM crew_members WHERE user_id = ?`)
    .bind(userId)
    .first();

  if (membership) return { error: 'You are already a member of a crew' };

  const now    = nowISO();
  const crewId = crypto.randomUUID();

  await db.batch([
    db.prepare(`
      INSERT INTO crews (id, name, creator_id, description, member_count, created_at)
      VALUES (?, ?, ?, ?, 1, ?)
    `).bind(crewId, name.trim(), userId, description ?? null, now),

    db.prepare(`
      INSERT INTO crew_members (id, crew_id, user_id, role, joined_at)
      VALUES (?, ?, ?, 'captain', ?)
    `).bind(crypto.randomUUID(), crewId, userId, now),
  ]);

  return {
    crew: {
      id:          crewId,
      name:        name.trim(),
      description: description ?? null,
      member_count: 1,
      created_at:  now,
    },
  };
}

// ── JOIN CREW ────────────────────────────────────────────────

export async function joinCrew(crewId, clerkId, db) {
  const userRow = await db
    .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
    .bind(clerkId)
    .first();
  if (!userRow) return { error: 'User not found' };
  const userId = userRow.id;

      const crew = await db
    .prepare(`SELECT * FROM crews WHERE id = ?`)
    .bind(crewId)
    .first();
  if (!crew) return { error: 'Crew not found' };
  if (crew.is_locked) return { error: 'This crew is locked and not accepting join requests' };

  const kicked = await db
    .prepare(`SELECT id FROM crew_kicks WHERE crew_id = ? AND user_id = ?`)
    .bind(crewId, userId)
    .first();
  if (kicked) return { error: 'You were removed from this crew and need an invite from the captain to rejoin' };

  // Check user not already in any crew
  const membership = await db
    .prepare(`SELECT id FROM crew_members WHERE user_id = ?`)
    .bind(userId)
    .first();

  if (membership) return { error: 'You are already a member of a crew' };

  const now = nowISO();

  await db.batch([
    db.prepare(`
      INSERT INTO crew_members (id, crew_id, user_id, role, joined_at)
      VALUES (?, ?, ?, 'member', ?)
    `).bind(crypto.randomUUID(), crewId, userId, now),

    db.prepare(`
      UPDATE crews SET member_count = member_count + 1 WHERE id = ?
    `).bind(crewId),
  ]);

  return {
    joined:   true,
    crew_id:  crewId,
    crew_name: crew.name,
  };
}
// ── CREATE CREW BATTLE ───────────────────────────────────────

export async function createCrewBattle(challengerCrewId, clerkId, body, db) {
  const userRow = await db
    .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
    .bind(clerkId)
    .first();
  if (!userRow) return { error: 'User not found' };
  const userId = userRow.id;

  const { target_crew_name, title, entry_contribution_usd, ends_at } = body;

  if (!target_crew_name)                    return { error: 'target_crew_name is required' };
  if (!title || title.trim().length === 0)  return { error: 'title is required' };
  if (!entry_contribution_usd || entry_contribution_usd <= 0) {
    return { error: 'entry_contribution_usd must be a positive number' };
  }
  if (!ends_at) return { error: 'ends_at is required' };

  const endsAtDate = new Date(ends_at);
  if (endsAtDate <= new Date()) return { error: 'ends_at must be in the future' };

  // Verify caller is captain of challenger crew
  const membership = await db
    .prepare(`SELECT role FROM crew_members WHERE crew_id = ? AND user_id = ?`)
    .bind(challengerCrewId, userId)
    .first();

  if (!membership)                  return { error: 'You are not a member of this crew' };
  if (membership.role !== 'captain') return { error: 'Only the crew captain can start a battle' };
  const muteStatus = await isMemberMuted(challengerCrewId, userId, db);
  if (muteStatus.muted) {
    return { error: `You are muted until ${muteStatus.muted_until}`, reason: muteStatus.reason };
  }
  // Look up target crew
  const targetCrew = await db
    .prepare(`SELECT * FROM crews WHERE name = ?`)
    .bind(target_crew_name.trim())
    .first();

  if (!targetCrew)                          return { error: `Crew "${target_crew_name}" not found` };
  if (targetCrew.id === challengerCrewId)   return { error: 'A crew cannot battle itself' };

  // Check no active battle between these two crews
  const existingBattle = await db
    .prepare(`
      SELECT id FROM crew_battles
      WHERE ((challenger_crew_id = ? AND target_crew_id = ?)
          OR (challenger_crew_id = ? AND target_crew_id = ?))
        AND status IN ('pending', 'active')
    `)
    .bind(challengerCrewId, targetCrew.id, targetCrew.id, challengerCrewId)
    .first();

  if (existingBattle) return { error: 'An active battle already exists between these crews' };

  // Check challenger crew wallet — captain pays entry on behalf of crew
  const wallet = await db
    .prepare(`SELECT balance_usd FROM wallets WHERE user_id = ?`)
    .bind(userId)
    .first();

  if (!wallet || wallet.balance_usd < entry_contribution_usd) {
    return { error: `Insufficient wallet balance. Entry contribution is $${entry_contribution_usd}` };
  }

    const now      = nowISO();
  const battleId = crypto.randomUUID();

  await db.batch([
    db.prepare(`
      INSERT INTO crew_battles
        (id, challenger_crew_id, target_crew_id, title,
         prize_pool_usd, entry_contribution_usd, status, ends_at, created_at,
         challenger_paid_by)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).bind(
      battleId,
      challengerCrewId,
      targetCrew.id,
      title.trim(),
      entry_contribution_usd,
      entry_contribution_usd,
      endsAtDate.toISOString(),
      now,
      userId,
    ),

    // Deduct entry from captain wallet
    db.prepare(`
      UPDATE wallets SET balance_usd = balance_usd - ?, updated_at = ?
      WHERE user_id = ?
    `).bind(entry_contribution_usd, now, userId),
  ]);

    return {
    battle: {
      id:                    battleId,
      title:                 title.trim(),
      challenger_crew_id:    challengerCrewId,
      target_crew_id:        targetCrew.id,
      target_crew_name:      targetCrew.name,
      entry_contribution_usd,
      prize_pool_usd:        entry_contribution_usd,
      status:                'pending',
      ends_at:               endsAtDate.toISOString(),
      created_at:            now,
    },
  };
}

// ── ACCEPT CREW BATTLE (target crew's captain only) ───────────
// Mirrors acceptDuel: the target crew must match the challenger's
// stake before the battle goes active. Until this is called, the
// battle sits in 'pending' with only the challenger's money at risk.

export async function acceptCrewBattle(battleId, clerkId, db) {
  const userRow = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(clerkId).first();
  if (!userRow) return { error: 'User not found' };
  const userId = userRow.id;

  const battle = await db.prepare(`SELECT * FROM crew_battles WHERE id = ?`).bind(battleId).first();
  if (!battle)                          return { error: 'Crew battle not found' };
  if (battle.status !== 'pending')      return { error: `Battle is already ${battle.status}` };
  if (battle.target_accepted_at)        return { error: 'Battle has already been accepted' };
  if (new Date(battle.ends_at) <= new Date()) {
    return { error: 'Battle voting window has already ended' };
  }

  const membership = await db
    .prepare(`SELECT role FROM crew_members WHERE crew_id = ? AND user_id = ?`)
    .bind(battle.target_crew_id, userId)
    .first();
  if (!membership)                   return { error: 'You are not a member of the target crew' };
  if (membership.role !== 'captain') return { error: 'Only the target crew\'s captain can accept a battle' };

  const muteStatus = await isMemberMuted(battle.target_crew_id, userId, db);
  if (muteStatus.muted) {
    return { error: `You are muted until ${muteStatus.muted_until}`, reason: muteStatus.reason };
  }

  const wallet = await db.prepare(`SELECT balance_usd FROM wallets WHERE user_id = ?`).bind(userId).first();
  if (!wallet || wallet.balance_usd < battle.entry_contribution_usd) {
    return { error: `Insufficient wallet balance. Entry contribution is $${battle.entry_contribution_usd}` };
  }

  const now         = nowISO();
  const newPrizePool = battle.entry_contribution_usd * 2;

  await db.batch([
    db.prepare(`
      UPDATE wallets SET balance_usd = balance_usd - ?, updated_at = ?
      WHERE user_id = ?
    `).bind(battle.entry_contribution_usd, now, userId),

    db.prepare(`
      UPDATE crew_battles
      SET status = 'active', target_accepted_at = ?, target_contribution_usd = ?,
          target_paid_by = ?, prize_pool_usd = ?
      WHERE id = ?
    `).bind(now, battle.entry_contribution_usd, userId, newPrizePool, battleId),
  ]);

  return {
    accepted:       true,
    battle_id:      battleId,
    prize_pool_usd: newPrizePool,
  };
}

// ── DECLINE CREW BATTLE (target crew's captain only) ──────────
// Refunds the challenger's escrowed stake — the battle never happened.

export async function declineCrewBattle(battleId, clerkId, db) {
  const userRow = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(clerkId).first();
  if (!userRow) return { error: 'User not found' };
  const userId = userRow.id;

  const battle = await db.prepare(`SELECT * FROM crew_battles WHERE id = ?`).bind(battleId).first();
  if (!battle)                     return { error: 'Crew battle not found' };
  if (battle.status !== 'pending') return { error: `Battle is already ${battle.status}` };

  const membership = await db
    .prepare(`SELECT role FROM crew_members WHERE crew_id = ? AND user_id = ?`)
    .bind(battle.target_crew_id, userId)
    .first();
  if (!membership)                   return { error: 'You are not a member of the target crew' };
  if (membership.role !== 'captain') return { error: 'Only the target crew\'s captain can decline a battle' };

  const now = nowISO();

  await db.batch([
    db.prepare(`UPDATE crew_battles SET status = 'cancelled' WHERE id = ?`).bind(battleId),
    db.prepare(`
      UPDATE wallets SET balance_usd = balance_usd + ?, updated_at = ?
      WHERE user_id = ?
    `).bind(battle.entry_contribution_usd, now, battle.challenger_paid_by),
  ]);

  return { declined: true, battle_id: battleId };
}

// ── RESOLVE CREW BATTLE (admin — moderatorId not clerk-resolved,
//    kept as-is since it's only used for logging/attribution) ──

export async function resolveCrewBattle(battleId, winnerCrewId, moderatorId, db) {
  const battle = await db
    .prepare(`SELECT * FROM crew_battles WHERE id = ?`)
    .bind(battleId)
    .first();

    if (!battle)                        return { error: 'Crew battle not found' };
  if (battle.status === 'resolved')   return { error: 'Battle already resolved' };
  if (battle.status === 'cancelled')  return { error: 'Battle was cancelled' };
  if (battle.payout_released)         return { error: 'Payout already released for this battle' };

  if (winnerCrewId !== battle.challenger_crew_id && winnerCrewId !== battle.target_crew_id) {
    return { error: 'Winner must be one of the battling crews' };
  }

  const now       = nowISO();
  const prizePool = battle.prize_pool_usd ?? 0;
  const { platformFee, netPayout } = calcNetPayout(prizePool);

  await db
    .prepare(`
      UPDATE crew_battles
      SET status = 'resolved', winner_crew_id = ?, dispute_status = 'none', payout_released = 1
      WHERE id = ?
    `)
    .bind(winnerCrewId, battleId)
    .run();

  // Credit net prize pool (after platform fee) into the winning crew's shared wallet
  const crewWallet = await getOrCreateCrewWallet(winnerCrewId, db);
  const newBalance = crewWallet.balance_usd + netPayout;

  await db
    .prepare(`
      UPDATE crew_wallets
      SET balance_usd = ?, total_funded_usd = total_funded_usd + ?, updated_at = ?
      WHERE id = ?
    `)
    .bind(newBalance, netPayout, now, crewWallet.id)
    .run();

  await db
    .prepare(`
      INSERT INTO crew_wallet_transactions
        (id, crew_id, crew_wallet_id, type, amount_usd, balance_after_usd, initiated_by, reason, status, reference, created_at)
      VALUES (?, ?, ?, 'battle_payout', ?, ?, ?, ?, 'executed', ?, ?)
    `)
    .bind(
      crypto.randomUUID(),
      winnerCrewId,
      crewWallet.id,
      netPayout,
      newBalance,
      moderatorId ?? null,
      `Prize payout for battle: ${battle.title} (5% platform fee: $${platformFee})`,
      battleId,
      now,
    )
    .run();

  // Award crew_battle_win score to all members of winning crew
  const { results: winners } = await db
    .prepare(`SELECT user_id FROM crew_members WHERE crew_id = ?`)
    .bind(winnerCrewId)
    .all();

  for (const member of winners) {
    await addScoreEvent(
      member.user_id,
      'crew_battle_win',
      null,
      { note: `Won crew battle: ${battle.title}` },
      db,
    );
  }

  // Get winning crew info for response
  const winnerCrew = await db
    .prepare(`SELECT name FROM crews WHERE id = ?`)
    .bind(winnerCrewId)
    .first();

  return {
    resolved:          true,
    battle_id:         battleId,
    winner_crew_id:    winnerCrewId,
    winner_crew_name:  winnerCrew?.name,
    prize_pool_usd:    prizePool,
    members_awarded:   winners.length,
  };
}

// ── GET CREW BY ID ───────────────────────────────────────────

export async function getCrewById(crewId, db) {
  const crew = await db
    .prepare(`
      SELECT crews.*, cw.balance_usd, cw.total_funded_usd, cw.total_spent_usd
      FROM crews
      LEFT JOIN crew_wallets cw ON cw.crew_id = crews.id
      WHERE crews.id = ?
    `)
    .bind(crewId)
    .first();
  if (!crew) return null;

  const { results: members } = await db
    .prepare(`
      SELECT cm.user_id, cm.role, cm.joined_at, u.username, u.league, u.avatar_url
      FROM crew_members cm
      JOIN users u ON u.id = cm.user_id
      WHERE cm.crew_id = ?
      ORDER BY cm.role DESC, cm.joined_at ASC
    `)
    .bind(crewId)
    .all();

  return { ...crew, members };
}

// ── GET ALL CREWS ────────────────────────────────────────────

export async function getCrews(limit, offset, clerkId, db) {
  let myCrewId = null;
  if (clerkId) {
    const userRow = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(clerkId).first();
    if (userRow) {
      const membership = await db
        .prepare(`SELECT crew_id FROM crew_members WHERE user_id = ?`)
        .bind(userRow.id)
        .first();
      if (membership) myCrewId = membership.crew_id;
    }
  }

    const { results } = await db
    .prepare(`
      SELECT id, name, description, member_count, created_at, is_locked
      FROM crews
      ORDER BY member_count DESC, created_at DESC
      LIMIT ? OFFSET ?
    `)
    .bind(limit ?? 20, offset ?? 0)
    .all();
	
  return results.map(c => ({ ...c, user_member: c.id === myCrewId }));
}

// ── GET ACTIVE CREW BATTLE (with live vote tally) ─────────────

export async function getActiveCrewBattle(crewId, clerkId, db) {
  const battle = await db
    .prepare(`
      SELECT * FROM crew_battles
      WHERE (challenger_crew_id = ? OR target_crew_id = ?)
        AND status IN ('pending','active')
      ORDER BY created_at DESC LIMIT 1
    `)
    .bind(crewId, crewId)
    .first();
  if (!battle) return { battle: null };

  const [challengerCrew, targetCrew] = await Promise.all([
    db.prepare(`SELECT name FROM crews WHERE id = ?`).bind(battle.challenger_crew_id).first(),
    db.prepare(`SELECT name FROM crews WHERE id = ?`).bind(battle.target_crew_id).first(),
  ]);

  const [challengerVotes, targetVotes] = await Promise.all([
    db.prepare(`SELECT COUNT(*) as c FROM crew_battle_votes WHERE battle_id = ? AND voted_crew_id = ?`)
      .bind(battle.id, battle.challenger_crew_id).first(),
    db.prepare(`SELECT COUNT(*) as c FROM crew_battle_votes WHERE battle_id = ? AND voted_crew_id = ?`)
      .bind(battle.id, battle.target_crew_id).first(),
  ]);

  const totalVotes    = challengerVotes.c + targetVotes.c;
  const challengerPct = totalVotes ? Math.round((challengerVotes.c / totalVotes) * 100) : 50;
  const targetPct     = totalVotes ? 100 - challengerPct : 50;

  let myVote    = null;
  let canVote   = true;
  let canAccept = false;
  if (clerkId) {
    const userRow = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(clerkId).first();
    if (userRow) {
      const isParticipant = await db
        .prepare(`SELECT id FROM crew_members WHERE user_id = ? AND (crew_id = ? OR crew_id = ?)`)
        .bind(userRow.id, battle.challenger_crew_id, battle.target_crew_id)
        .first();
      canVote = !isParticipant;
      const existingVote = await db
        .prepare(`SELECT voted_crew_id FROM crew_battle_votes WHERE battle_id = ? AND voter_id = ?`)
        .bind(battle.id, userRow.id)
        .first();
      if (existingVote) myVote = existingVote.voted_crew_id;

      if (battle.status === 'pending' && !battle.target_accepted_at) {
        const targetMembership = await db
          .prepare(`SELECT role FROM crew_members WHERE crew_id = ? AND user_id = ?`)
          .bind(battle.target_crew_id, userRow.id)
          .first();
        canAccept = targetMembership?.role === 'captain';
      }
    }
  }

  return {
    battle: {
      id: battle.id,
      title: battle.title,
      status: battle.status,
      ends_at: battle.ends_at,
      challenger_crew_id:   battle.challenger_crew_id,
      challenger_crew_name: challengerCrew?.name,
      target_crew_id:       battle.target_crew_id,
      target_crew_name:     targetCrew?.name,
      challenger_votes: challengerVotes.c,
      target_votes:     targetVotes.c,
      challenger_pct:   challengerPct,
      target_pct:       targetPct,
      total_votes:      totalVotes,
      my_vote:    myVote,
      can_vote:   canVote,
      can_accept: canAccept,
    },
  };
}
