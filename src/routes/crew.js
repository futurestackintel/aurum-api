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
} from '../services/crew.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

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

  return null;
}

// ── Helper ──────────────────────────────────────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
