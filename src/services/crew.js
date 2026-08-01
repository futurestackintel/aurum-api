// ============================================================
// CREW BATTLES SERVICE — Module Chat F Feature 6
// Fix (Finding 3): all three entry points receive the CLERK id
// from the route layer (requireAuth), but wallets/crews/crew_members
// are keyed on the INTERNAL DB user id. Resolve clerk_id -> id
// before any read/write against those tables.
// ============================================================

import { addScoreEvent } from './aurumScore.js';

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
  await db
    .prepare(`
      INSERT INTO crew_join_requests (id, crew_id, user_id, type, status, created_at)
      VALUES (?, ?, ?, 'invite', 'pending', ?)
    `)
    .bind(id, crewId, targetUserId, nowISO())
    .run();

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

  const membership = await db.prepare(`SELECT id FROM crew_members WHERE user_id = ?`).bind(userId).first();
  if (membership) return { error: 'You are already a member of a crew' };

  const existing = await db
    .prepare(`SELECT id FROM crew_join_requests WHERE crew_id = ? AND user_id = ? AND status = 'pending'`)
    .bind(crewId, userId)
    .first();
  if (existing) return { error: 'You already have a pending invite or request for this crew' };

  const id = crypto.randomUUID();
  await db
    .prepare(`
      INSERT INTO crew_join_requests (id, crew_id, user_id, type, status, created_at)
      VALUES (?, ?, ?, 'request', 'pending', ?)
    `)
    .bind(id, crewId, userId, nowISO())
    .run();

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

  await db.batch([
    db.prepare(`DELETE FROM crew_members WHERE id = ?`).bind(target.id),
    db.prepare(`UPDATE crews SET member_count = member_count - 1 WHERE id = ?`).bind(crewId),
  ]);

  return { kicked: true, crew_id: crewId, target_user_id: targetUserId };
}

// ── LOCK / UNLOCK CREW (captain only) ─────────────────────────

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

  return { crew_id: crewId, target_user_id: targetUserId, role: newRole };
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
         prize_pool_usd, entry_contribution_usd, status, ends_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).bind(
      battleId,
      challengerCrewId,
      targetCrew.id,
      title.trim(),
      entry_contribution_usd,
      entry_contribution_usd,
      endsAtDate.toISOString(),
      now,
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

  if (winnerCrewId !== battle.challenger_crew_id && winnerCrewId !== battle.target_crew_id) {
    return { error: 'Winner must be one of the battling crews' };
  }

  const now          = nowISO();
  const prizePool    = battle.prize_pool_usd ?? 0;

  await db
    .prepare(`
      UPDATE crew_battles
      SET status = 'resolved', winner_crew_id = ?
      WHERE id = ?
    `)
    .bind(winnerCrewId, battleId)
    .run();

  // Credit prize pool into the winning crew's shared wallet
  const crewWallet = await getOrCreateCrewWallet(winnerCrewId, db);
  const newBalance = crewWallet.balance_usd + prizePool;

  await db
    .prepare(`
      UPDATE crew_wallets
      SET balance_usd = ?, total_funded_usd = total_funded_usd + ?, updated_at = ?
      WHERE id = ?
    `)
    .bind(newBalance, prizePool, now, crewWallet.id)
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
      prizePool,
      newBalance,
      moderatorId ?? null,
      `Prize payout for battle: ${battle.title}`,
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
    .prepare(`SELECT * FROM crews WHERE id = ?`)
    .bind(crewId)
    .first();

  if (!crew) return null;

  const { results: members } = await db
    .prepare(`
      SELECT cm.user_id, cm.role, cm.joined_at, u.username, u.league
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

export async function getCrews(limit, offset, db) {
  const { results } = await db
    .prepare(`
      SELECT id, name, description, member_count, created_at
      FROM crews
      ORDER BY member_count DESC, created_at DESC
      LIMIT ? OFFSET ?
    `)
    .bind(limit ?? 20, offset ?? 0)
    .all();

  return results;
}
