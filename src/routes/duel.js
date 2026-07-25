// ============================================================
// CHALLENGER DUEL ROUTES — Final Fix Chat
// Finding 7 pattern applied here too: streakMiddleware(...) is
// now awaited (was previously fired without await inside a
// try/catch — if async and throwing, the rejection escaped the
// catch instead of producing a clean 500).
// GET  /api/duels                         — list active/pending duels
// POST /api/duels                         — create a duel challenge
// GET  /api/duels/:id                     — get single duel
// POST /api/duels/:id/accept              — target accepts duel
// POST /api/duels/:id/decline             — target declines duel
// POST /api/duels/:id/proof               — submit achievement proof
// POST /api/duels/:id/resolve             — admin: declare winner
// POST /api/duels/:id/announce            — Feature 3: public announcement
// POST /api/duels/:id/notify              — Feature 3: subscribe to updates
// POST /api/duels/:id/stream/ready        — admin: set stream ready
// POST /api/duels/:id/tip/:participantId  — Feature 4: audience tip
// POST /api/duels/:id/vote/:participantId — Feature 5: community vote
// ============================================================

import {
  createDuel,
  acceptDuel,
  declineDuel,
  submitDuelProof,
  getActiveDuels,
  getDuelById,
  announceDuel,
  watchDuel,
  setStreamReady,
  audienceTip,
  castDuelVote,
  reportDuelCheating,
  decideDuelDispute,
} from '../services/duel.js';

import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { streakMiddleware }          from '../services/streak.js';

export async function handleDuelRoutes(path, method, request, env) {
  const db = env.DB;

  // ── GET /api/duels ──────────────────────────────────────
  // Auth is optional — duels stay publicly viewable. If a valid
  // token is present, resolve the viewer's internal id so
  // is_challenger/is_opponent/is_loser can be computed per row.
  if (path === '/api/duels' && method === 'GET') {
    try {
      const url    = new URL(request.url);
      const limit  = parseInt(url.searchParams.get('limit')  ?? '20');
      const offset = parseInt(url.searchParams.get('offset') ?? '0');

      let viewerId = null;
      const authedUser = await requireAuth(request, env);
      if (!authedUser.error) {
        const dbUser = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(authedUser.id).first();
        viewerId = dbUser?.id ?? null;
      }

      const duels = await getActiveDuels(limit, offset, viewerId, db);
      return jsonResponse({ duels });
    } catch (err) {
      console.error('Get duels error:', err);
      return jsonResponse({ error: 'Unable to load duels. Please try again.' }, 500);
    }
  }

  // ── POST /api/duels ─────────────────────────────────────
  if (path === '/api/duels' && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      await streakMiddleware(user.id, db);
      const body   = await request.json();
      const result = await createDuel(user.id, body, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result, 201);
    } catch (err) {
      console.error('Create duel error:', err);
      return jsonResponse({ error: 'Unable to create duel. Please try again.' }, 500);
    }
  }

  // ── GET /api/duels/:id ──────────────────────────────────
  const singleMatch = path.match(/^\/api\/duels\/([^/]+)$/);
  if (singleMatch && method === 'GET') {
    try {
      const duel = await getDuelById(singleMatch[1], db);
      if (!duel) return jsonResponse({ error: 'Duel not found' }, 404);
      return jsonResponse({ duel });
    } catch (err) {
      console.error('Get duel error:', err);
      return jsonResponse({ error: 'Unable to load duel. Please try again.' }, 500);
    }
  }

  // ── POST /api/duels/:id/accept ──────────────────────────
  const acceptMatch = path.match(/^\/api\/duels\/([^/]+)\/accept$/);
  if (acceptMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      await streakMiddleware(user.id, db);
      const result = await acceptDuel(acceptMatch[1], user.id, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Accept duel error:', err);
      return jsonResponse({ error: 'Unable to accept duel. Please try again.' }, 500);
    }
  }

  // ── POST /api/duels/:id/decline ─────────────────────────
  const declineMatch = path.match(/^\/api\/duels\/([^/]+)\/decline$/);
  if (declineMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const result = await declineDuel(declineMatch[1], user.id, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Decline duel error:', err);
      return jsonResponse({ error: 'Unable to decline duel. Please try again.' }, 500);
    }
  }

  // ── POST /api/duels/:id/proof ───────────────────────────
  const proofMatch = path.match(/^\/api\/duels\/([^/]+)\/proof$/);
  if (proofMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const body   = await request.json();
      const result = await submitDuelProof(proofMatch[1], user.id, body, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Submit duel proof error:', err);
      return jsonResponse({ error: 'Unable to submit proof. Please try again.' }, 500);
    }
  }

  // ── POST /api/duels/:id/announce ────────────────────────
  const announceMatch = path.match(/^\/api\/duels\/([^/]+)\/announce$/);
  if (announceMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const result = await announceDuel(announceMatch[1], user.id, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Announce duel error:', err);
      return jsonResponse({ error: 'Unable to announce duel. Please try again.' }, 500);
    }
  }

  // ── POST /api/duels/:id/notify ──────────────────────────
  const notifyMatch = path.match(/^\/api\/duels\/([^/]+)\/notify$/);
  if (notifyMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const result = await watchDuel(notifyMatch[1], user.id, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Watch duel error:', err);
      return jsonResponse({ error: 'Unable to subscribe to duel. Please try again.' }, 500);
    }
  }

  // ── POST /api/duels/:id/stream/ready — admin ────────────
  const streamMatch = path.match(/^\/api\/duels\/([^/]+)\/stream\/ready$/);
  if (streamMatch && method === 'POST') {
    const admin = await requireAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, 403);

    try {
      const body   = await request.json();
      const result = await setStreamReady(streamMatch[1], body, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Stream ready error:', err);
      return jsonResponse({ error: 'Unable to set stream ready. Please try again.' }, 500);
    }
  }

  // ── POST /api/duels/:id/tip/:participantId ──────────────
  const tipMatch = path.match(/^\/api\/duels\/([^/]+)\/tip\/([^/]+)$/);
  if (tipMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const body   = await request.json();
      const result = await audienceTip(tipMatch[1], tipMatch[2], user.id, body, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Audience tip error:', err);
      return jsonResponse({ error: 'Unable to send tip. Please try again.' }, 500);
    }
  }

  // ── POST /api/duels/:id/vote/:participantId ─────────────
  const voteMatch = path.match(/^\/api\/duels\/([^/]+)\/vote\/([^/]+)$/);
  if (voteMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const result = await castDuelVote(voteMatch[1], voteMatch[2], user.id, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Cast vote error:', err);
      return jsonResponse({ error: 'Unable to cast vote. Please try again.' }, 500);
    }
  }

// ── POST /api/duels/:id/report ──────────────────────────
  const reportMatch = path.match(/^\/api\/duels\/([^/]+)\/report$/);
  if (reportMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const body   = await request.json();
      const result = await reportDuelCheating(reportMatch[1], user.id, body.reason, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Report duel error:', err);
      return jsonResponse({ error: 'Unable to submit report. Please try again.' }, 500);
    }
  }

  // ── POST /api/duels/:id/dispute-decision — admin ────────
  const disputeDecisionMatch = path.match(/^\/api\/duels\/([^/]+)\/dispute-decision$/);
  if (disputeDecisionMatch && method === 'POST') {
    const admin = await requireAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, 403);

    try {
      const body = await request.json();
      if (!body.decision) return jsonResponse({ error: 'decision is required' }, 400);
      const result = await decideDuelDispute(disputeDecisionMatch[1], body.decision, admin.id, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error('Decide duel dispute error:', err);
      return jsonResponse({ error: 'Unable to decide dispute. Please try again.' }, 500);
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
