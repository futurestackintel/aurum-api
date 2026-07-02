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
