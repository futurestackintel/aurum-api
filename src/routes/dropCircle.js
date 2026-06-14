// ============================================================
// DROP CIRCLE ROUTES
// GET  /api/challenges                      — list open challenges
// POST /api/challenges                      — create challenge
// GET  /api/challenges/:id                  — get single challenge
// POST /api/challenges/:id/join             — join + fund entry
// POST /api/challenges/:id/proof            — submit achievement proof
// POST /api/challenges/:id/score/:userId    — admin: score an entry
// POST /api/challenges/:id/resolve          — admin: resolve winner
// ============================================================

import {
  createChallenge,
  joinChallenge,
  submitProof,
  scoreEntry,
  resolveChallenge,
  getChallenges,
  getChallengeById,
} from '../services/dropCircle.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { streakMiddleware }          from '../services/streak.js';

export async function handleChallengeRoutes(path, method, request, env) {
  const db = env.DB;

  // ── GET /api/challenges ─────────────────────────────────
  if (path === '/api/challenges' && method === 'GET') {
    try {
      const url    = new URL(request.url);
      const limit  = parseInt(url.searchParams.get('limit')  ?? '20');
      const offset = parseInt(url.searchParams.get('offset') ?? '0');
      const challenges = await getChallenges(limit, offset, db);
      return jsonResponse({ challenges });
    } catch (err) {
      console.error("Get challenges error:", err);
      return jsonResponse({ error: "Unable to load challenges. Please try again." }, 500);
    }
  }

  // ── POST /api/challenges ────────────────────────────────
  if (path === '/api/challenges' && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      streakMiddleware(user.id, db);
      const body   = await request.json();
      const result = await createChallenge(user.id, body, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result, 201);
    } catch (err) {
      console.error("Create challenge error:", err);
      return jsonResponse({ error: "Unable to create challenge. Please try again." }, 500);
    }
  }

  // ── GET /api/challenges/:id ─────────────────────────────
  const singleMatch = path.match(/^\/api\/challenges\/([^/]+)$/);
  if (singleMatch && method === 'GET') {
    try {
      const challenge = await getChallengeById(singleMatch[1], db);
      if (!challenge) return jsonResponse({ error: 'Challenge not found' }, 404);
      return jsonResponse({ challenge });
    } catch (err) {
      console.error("Get challenge error:", err);
      return jsonResponse({ error: "Unable to load challenge. Please try again." }, 500);
    }
  }

  // ── POST /api/challenges/:id/join ───────────────────────
  const joinMatch = path.match(/^\/api\/challenges\/([^/]+)\/join$/);
  if (joinMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      streakMiddleware(user.id, db);
      const result = await joinChallenge(joinMatch[1], user.id, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error("Join challenge error:", err);
      return jsonResponse({ error: "Unable to join challenge. Please try again." }, 500);
    }
  }

  // ── POST /api/challenges/:id/proof ──────────────────────
  const proofMatch = path.match(/^\/api\/challenges\/([^/]+)\/proof$/);
  if (proofMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const body   = await request.json();
      const result = await submitProof(proofMatch[1], user.id, body, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error("Submit proof error:", err);
      return jsonResponse({ error: "Unable to submit proof. Please try again." }, 500);
    }
  }

  // ── POST /api/challenges/:id/score/:userId — admin ──────
  const scoreMatch = path.match(/^\/api\/challenges\/([^/]+)\/score\/([^/]+)$/);
  if (scoreMatch && method === 'POST') {
    const admin = await requireAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, 403);

    try {
      const body = await request.json();
      if (body.score === undefined) return jsonResponse({ error: 'score is required' }, 400);
      const result = await scoreEntry(scoreMatch[1], scoreMatch[2], body.score, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error("Score entry error:", err);
      return jsonResponse({ error: "Unable to score entry. Please try again." }, 500);
    }
  }

  // ── POST /api/challenges/:id/resolve — admin ────────────
  const resolveMatch = path.match(/^\/api\/challenges\/([^/]+)\/resolve$/);
  if (resolveMatch && method === 'POST') {
    const admin = await requireAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, 403);

    try {
      const result = await resolveChallenge(resolveMatch[1], admin.id, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    } catch (err) {
      console.error("Resolve challenge error:", err);
      return jsonResponse({ error: "Unable to resolve challenge. Please try again." }, 500);
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