// ============================================================
// CREW ROUTES — Module Chat F Feature 6
// GET  /api/crews                     — list all crews
// POST /api/crews                     — create a crew
// GET  /api/crews/:id                 — get single crew + members
// POST /api/crews/:id/join            — join a crew
// POST /api/crews/:id/battle          — challenge another crew
// POST /api/crew-battles/:id/resolve  — admin: resolve battle
// ============================================================

import {
  createCrew,
  joinCrew,
  createCrewBattle,
  resolveCrewBattle,
  getCrewById,
  getCrews,
  initiateCrewSpend,
  cosignCrewSpend,
  vetoCrewSpend,
  inviteToCrew,
  requestToJoinCrew,
  respondToJoinRequest,
  leaveCrew,
  kickMember,
  setCrewLocked,
  setModeratorRole,
  disbandCrew,
  setCrewRules,
  muteMember,
  castCrewBattleVote,
  reportCrewBattleDispute,
  freezeCrew,
  unfreezeCrew,
  flagCrewSpend,
  isMemberMuted,
  deleteCrewMessage,
  getCrewMessages,
} from '../services/crew.js';
import { requireAuth, requireAdmin, requireAuthFromQuery } from '../middleware/auth.js';

export async function handleCrewRoutes(path, method, request, env) {
  const db = env.DB;

  // ── GET /api/crews ──────────────────────────────────────
  if (path === '/api/crews' && method === 'GET') {
    try {
      const url    = new URL(request.url);
      const limit  = parseInt(url.searchParams.get('limit')  ?? '20');
      const offset = parseInt(url.searchParams.get('offset') ?? '0');
      const crews  = await getCrews(limit, offset, db);
      return jsonResponse({ crews });
    } catch (err) {
      console.error('Get crews error:', err);
      return jsonResponse({ error: 'Unable to load crews. Please try again.' }, 500);
    }
  }

  // ── POST /api/crews ─────────────────────────────────────
  if (path === '/api/crews' && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const body   = await request.json();
      const result = await createCrew(user.id, body, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result, 201);
    } catch (err) {
      console.error('Create crew error:', err);
      return jsonResponse({ error: 'Unable to create crew. Please try again.' }, 500);
    }
  }

  // ── GET /api/crews/:id ──────────────────────────────────
  const singleMatch = path.match(/^\/api\/crews\/([^/]+)$/);
  if (singleMatch && method === 'GET') {
    try {
      const crew = await getCrewById(singleMatch[1], db);
      if (!crew) return jsonResponse({ error: 'Crew not found' }, 404);
      return jsonResponse({ crew });
    } catch (err) {
      console.error('Get crew error:', err);
      return jsonResponse({ error: 'Unable to load crew. Please try again.' }, 500);
    }
  }

  // ── POST /api/crews/:id/join ────────────────────────────
  const joinMatch = path.match(/^\/api\/crews\/([^/]+)\/join$/);
  if (joinMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const result = await joinCrew(joinMatch[1], user.id, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Join crew error:', err);
      return jsonResponse({ error: 'Unable to join crew. Please try again.' }, 500);
    }
  }

  // ── POST /api/crews/:id/battle ──────────────────────────
  const battleMatch = path.match(/^\/api\/crews\/([^/]+)\/battle$/);
  if (battleMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const body   = await request.json();
      const result = await createCrewBattle(battleMatch[1], user.id, body, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result, 201);
    } catch (err) {
      console.error('Create crew battle error:', err);
      return jsonResponse({ error: 'Unable to create crew battle. Please try again.' }, 500);
    }
  }

  // ── POST /api/crew-battles/:id/resolve — admin ──────────
  const resolveMatch = path.match(/^\/api\/crew-battles\/([^/]+)\/resolve$/);
  if (resolveMatch && method === 'POST') {
    const admin = await requireAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, 403);

    try {
      const body = await request.json();
      if (!body.winner_crew_id) return jsonResponse({ error: 'winner_crew_id is required' }, 400);
      const result = await resolveCrewBattle(resolveMatch[1], body.winner_crew_id, admin.id, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Resolve crew battle error:', err);
      return jsonResponse({ error: 'Unable to resolve crew battle. Please try again.' }, 500);
    }
  }

  // ── POST /api/crews/:id/freeze — admin only ─────────────
  const freezeMatch = path.match(/^\/api\/crews\/([^/]+)\/freeze$/);
  if (freezeMatch && method === 'POST') {
    const admin = await requireAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, 403);

    try {
      const body = await request.json();
      if (!body.reason) return jsonResponse({ error: 'reason is required' }, 400);
      const result = await freezeCrew(freezeMatch[1], admin.id, body.reason, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Freeze crew error:', err);
      return jsonResponse({ error: 'Unable to freeze crew. Please try again.' }, 500);
    }
  }

  // ── POST /api/crews/:id/unfreeze — admin only ───────────
  const unfreezeMatch = path.match(/^\/api\/crews\/([^/]+)\/unfreeze$/);
  if (unfreezeMatch && method === 'POST') {
    const admin = await requireAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, 403);

    try {
      const result = await unfreezeCrew(unfreezeMatch[1], admin.id, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Unfreeze crew error:', err);
      return jsonResponse({ error: 'Unable to unfreeze crew. Please try again.' }, 500);
    }
  }

  // ── POST /api/crew-spends/:id/flag — member flags a spend ───
  const spendFlagMatch = path.match(/^\/api\/crew-spends\/([^/]+)\/flag$/);
  if (spendFlagMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const body = await request.json();
      if (!body.reason) return jsonResponse({ error: 'reason is required' }, 400);
      const result = await flagCrewSpend(spendFlagMatch[1], user.id, body.reason, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result, 201);
    } catch (err) {
      console.error('Flag crew spend error:', err);
      return jsonResponse({ error: 'Unable to flag spend. Please try again.' }, 500);
    }
  }
  // ── POST /api/crews/:id/spend — captain initiates a spend ──
  const spendMatch = path.match(/^\/api\/crews\/([^/]+)\/spend$/);
  if (spendMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const body   = await request.json();
      const result = await initiateCrewSpend(spendMatch[1], user.id, body, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result, 201);
    } catch (err) {
      console.error('Initiate crew spend error:', err);
      return jsonResponse({ error: 'Unable to initiate spend. Please try again.' }, 500);
    }
  }

  // ── POST /api/crew-spends/:id/cosign — moderator co-signs ──
  const cosignMatch = path.match(/^\/api\/crew-spends\/([^/]+)\/cosign$/);
  if (cosignMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const result = await cosignCrewSpend(cosignMatch[1], user.id, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Cosign crew spend error:', err);
      return jsonResponse({ error: 'Unable to co-sign spend. Please try again.' }, 500);
    }
  }

  // ── POST /api/crew-spends/:id/veto — moderator vetoes ──────
  const vetoMatch = path.match(/^\/api\/crew-spends\/([^/]+)\/veto$/);
  if (vetoMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const body   = await request.json().catch(() => ({}));
      const result = await vetoCrewSpend(vetoMatch[1], user.id, body, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Veto crew spend error:', err);
      return jsonResponse({ error: 'Unable to veto spend. Please try again.' }, 500);
    }
  }

  // ── POST /api/crews/:id/invite — captain invites a user ────
  const inviteMatch = path.match(/^\/api\/crews\/([^/]+)\/invite$/);
  if (inviteMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const body = await request.json();
      if (!body.target_user_id) return jsonResponse({ error: 'target_user_id is required' }, 400);
      const result = await inviteToCrew(inviteMatch[1], user.id, body.target_user_id, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result, 201);
    } catch (err) {
      console.error('Invite to crew error:', err);
      return jsonResponse({ error: 'Unable to send invite. Please try again.' }, 500);
    }
  }

  // ── POST /api/crews/:id/request-join — user requests to join ──
  const requestJoinMatch = path.match(/^\/api\/crews\/([^/]+)\/request-join$/);
  if (requestJoinMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const result = await requestToJoinCrew(requestJoinMatch[1], user.id, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result, 201);
    } catch (err) {
      console.error('Request to join crew error:', err);
      return jsonResponse({ error: 'Unable to submit join request. Please try again.' }, 500);
    }
  }

  // ── POST /api/crew-join-requests/:id/respond — accept/decline ──
  const respondMatch = path.match(/^\/api\/crew-join-requests\/([^/]+)\/respond$/);
  if (respondMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const body = await request.json();
      if (typeof body.accept !== 'boolean') return jsonResponse({ error: 'accept (boolean) is required' }, 400);
      const result = await respondToJoinRequest(respondMatch[1], user.id, body.accept, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Respond to join request error:', err);
      return jsonResponse({ error: 'Unable to respond to request. Please try again.' }, 500);
    }
  }

  // ── POST /api/crews/leave — leave current crew ──────────────
  if (path === '/api/crews/leave' && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const result = await leaveCrew(user.id, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Leave crew error:', err);
      return jsonResponse({ error: 'Unable to leave crew. Please try again.' }, 500);
    }
  }

  // ── POST /api/crews/:id/kick — captain removes a member ─────
  const kickMatch = path.match(/^\/api\/crews\/([^/]+)\/kick$/);
  if (kickMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const body = await request.json();
      if (!body.target_user_id) return jsonResponse({ error: 'target_user_id is required' }, 400);
      const result = await kickMember(kickMatch[1], user.id, body.target_user_id, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Kick member error:', err);
      return jsonResponse({ error: 'Unable to remove member. Please try again.' }, 500);
    }
  }

  // ── POST /api/crews/:id/lock — captain locks/unlocks crew ───
  const lockMatch = path.match(/^\/api\/crews\/([^/]+)\/lock$/);
  if (lockMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const body = await request.json();
      if (typeof body.locked !== 'boolean') return jsonResponse({ error: 'locked (boolean) is required' }, 400);
      const result = await setCrewLocked(lockMatch[1], user.id, body.locked, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Lock crew error:', err);
      return jsonResponse({ error: 'Unable to update lock status. Please try again.' }, 500);
    }
  }

  // ── POST /api/crews/:id/moderator — captain promotes/demotes ──
  const modMatch = path.match(/^\/api\/crews\/([^/]+)\/moderator$/);
  if (modMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const body = await request.json();
      if (!body.target_user_id) return jsonResponse({ error: 'target_user_id is required' }, 400);
      if (typeof body.make_moderator !== 'boolean') return jsonResponse({ error: 'make_moderator (boolean) is required' }, 400);
      const result = await setModeratorRole(modMatch[1], user.id, body.target_user_id, body.make_moderator, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Set moderator role error:', err);
      return jsonResponse({ error: 'Unable to update role. Please try again.' }, 500);
    }
  }

  // ── POST /api/crews/:id/disband — captain disbands crew ─────
  const disbandMatch = path.match(/^\/api\/crews\/([^/]+)\/disband$/);
  if (disbandMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const result = await disbandCrew(disbandMatch[1], user.id, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Disband crew error:', err);
      return jsonResponse({ error: 'Unable to disband crew. Please try again.' }, 500);
    }
  }

  // ── POST /api/crews/:id/rules — captain edits crew rules ────
  const rulesMatch = path.match(/^\/api\/crews\/([^/]+)\/rules$/);
  if (rulesMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const body   = await request.json();
      const result = await setCrewRules(rulesMatch[1], user.id, body.rules ?? '', db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Set crew rules error:', err);
      return jsonResponse({ error: 'Unable to update rules. Please try again.' }, 500);
    }
  }

  // ── POST /api/crews/:id/mute — captain/moderator mutes a member ──
  const muteMatch = path.match(/^\/api\/crews\/([^/]+)\/mute$/);
  if (muteMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const body = await request.json();
      if (!body.target_user_id) return jsonResponse({ error: 'target_user_id is required' }, 400);
      if (!body.duration_hours) return jsonResponse({ error: 'duration_hours is required' }, 400);
      if (!body.reason) return jsonResponse({ error: 'reason is required' }, 400);
      const result = await muteMember(muteMatch[1], user.id, body.target_user_id, body.duration_hours, body.reason, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result, 201);
    } catch (err) {
      console.error('Mute member error:', err);
      return jsonResponse({ error: 'Unable to mute member. Please try again.' }, 500);
    }
  }

  // ── POST /api/crew-battles/:id/vote — anyone except participants ──
  const battleVoteMatch = path.match(/^\/api\/crew-battles\/([^/]+)\/vote$/);
  if (battleVoteMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const body = await request.json();
      if (!body.voted_crew_id) return jsonResponse({ error: 'voted_crew_id is required' }, 400);
      const result = await castCrewBattleVote(battleVoteMatch[1], user.id, body.voted_crew_id, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result, 201);
    } catch (err) {
      console.error('Cast crew battle vote error:', err);
      return jsonResponse({ error: 'Unable to cast vote. Please try again.' }, 500);
    }
  }

  // ── POST /api/crew-battles/:id/dispute — losing crew's captain ──
  const battleDisputeMatch = path.match(/^\/api\/crew-battles\/([^/]+)\/dispute$/);
  if (battleDisputeMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const body = await request.json();
      if (!body.reason) return jsonResponse({ error: 'reason is required' }, 400);
      const result = await reportCrewBattleDispute(battleDisputeMatch[1], user.id, body.reason, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Report crew battle dispute error:', err);
      return jsonResponse({ error: 'Unable to report dispute. Please try again.' }, 500);
    }
  }

  // ── POST /api/crews/:id/messages — send a crew chat message ──
  const messageMatch = path.match(/^\/api\/crews\/([^/]+)\/messages$/);
  if (messageMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const body = await request.json();
      if (!body.content || body.content.trim().length === 0) {
        return jsonResponse({ error: 'Message cannot be empty' }, 400);
      }

      const userRow = await db
        .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
        .bind(user.id)
        .first();
      if (!userRow) return jsonResponse({ error: 'User not found' }, 404);
      const userId = userRow.id;
      const muteStatus = await isMemberMuted(messageMatch[1], userId, db);
      if (muteStatus.muted) {
        return jsonResponse({
          error: `You are muted until ${muteStatus.muted_until}`,
          reason: muteStatus.reason,
        }, 403);
      }
      const messageId = crypto.randomUUID();
      await db
        .prepare(`INSERT INTO crew_messages (id, crew_id, sender_id, content) VALUES (?, ?, ?, ?)`)
        .bind(messageId, messageMatch[1], userId, body.content)
        .run();

      // Parse @mentions and insert one row per mentioned user
      const mentionedUsernames = [...body.content.matchAll(/@(\w+)/g)].map(m => m[1]);
      if (mentionedUsernames.length > 0) {
        const uniqueUsernames = [...new Set(mentionedUsernames)];
        for (const username of uniqueUsernames) {
          const mentionedUser = await db
            .prepare(`SELECT id FROM users WHERE username = ?`)
            .bind(username)
            .first();
          if (mentionedUser) {
            await db
              .prepare(`INSERT INTO crew_message_mentions (id, message_id, mentioned_user_id) VALUES (?, ?, ?)`)
              .bind(crypto.randomUUID(), messageId, mentionedUser.id)
              .run();
          }
        }
      }

      const doId = env.CREW_CHAT.idFromName(messageMatch[1]);
      const doStub = env.CREW_CHAT.get(doId);
      await doStub.fetch('https://internal/broadcast', {
        method: 'POST',
        body: JSON.stringify({
          id: messageId,
          crewId: messageMatch[1],
          senderId: userId,
          content: body.content,
          createdAt: new Date().toISOString(),
        }),
      });

      return jsonResponse({ id: messageId, success: true }, 200);
    } catch (err) {
      console.error('Send crew message error:', err);
      return jsonResponse({ error: 'Unable to send message. Please try again.' }, 500);
    }
  }

// ── GET /api/crews/:id/ws — live chat WebSocket connection ──
  const wsMatch = path.match(/^\/api\/crews\/([^/]+)\/ws$/);
  if (wsMatch && method === 'GET') {
    const user = await requireAuthFromQuery(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    const userRow = await db
      .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
      .bind(user.id)
      .first();
    if (!userRow) return jsonResponse({ error: 'User not found' }, 404);
    const member = await db
      .prepare(`SELECT id FROM crew_members WHERE crew_id = ? AND user_id = ?`)
      .bind(wsMatch[1], userRow.id)
      .first();
    if (!member) return jsonResponse({ error: 'You are not a member of this crew' }, 403);

    const doId = env.CREW_CHAT.idFromName(wsMatch[1]);
    const doStub = env.CREW_CHAT.get(doId);
    return doStub.fetch(request);
  }

  // ── GET /api/crews/:id/messages — fetch message history ─────
  const historyMatch = path.match(/^\/api\/crews\/([^/]+)\/messages$/);
  if (historyMatch && method === 'GET') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const userRow = await db
        .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
        .bind(user.id)
        .first();
      if (!userRow) return jsonResponse({ error: 'User not found' }, 404);
      const member = await db
        .prepare(`SELECT id FROM crew_members WHERE crew_id = ? AND user_id = ?`)
        .bind(historyMatch[1], userRow.id)
        .first();
      if (!member) return jsonResponse({ error: 'You are not a member of this crew' }, 403);
      const url = new URL(request.url);
      const limit = parseInt(url.searchParams.get('limit') ?? '50');
      const before = url.searchParams.get('before');

      const messages = await getCrewMessages(historyMatch[1], limit, before, db);
      return jsonResponse({ messages });
    } catch (err) {
      console.error('Get crew messages error:', err);
      return jsonResponse({ error: 'Unable to load messages. Please try again.' }, 500);
    }
  }

  // ── DELETE /api/crew-messages/:id — captain/moderator deletes ──
  const deleteMessageMatch = path.match(/^\/api\/crew-messages\/([^/]+)$/);
  if (deleteMessageMatch && method === 'DELETE') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const result = await deleteCrewMessage(deleteMessageMatch[1], user.id, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Delete crew message error:', err);
      return jsonResponse({ error: 'Unable to delete message. Please try again.' }, 500);
    }
  }

  return null;
}

// ── Helper ──────────────────────────────────────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
