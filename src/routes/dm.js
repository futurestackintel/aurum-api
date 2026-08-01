import { getOrCreateDmChannel, sendDmMessage } from '../services/dm.js';
import { requireAuth } from '../middleware/auth.js';

export async function handleDmRoutes(path, method, request, env) {
  const db = env.DB;

  // ── POST /api/dm/channels — start or find a DM channel ──────
  if (path === '/api/dm/channels' && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const body = await request.json();
      if (!body.target_user_id) return jsonResponse({ error: 'target_user_id is required' }, 400);

      const result = await getOrCreateDmChannel(user.id, body.target_user_id, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result, result.created ? 201 : 200);
    } catch (err) {
      console.error('Get/create DM channel error:', err);
      return jsonResponse({ error: 'Unable to open conversation. Please try again.' }, 500);
    }
  }

  // ── POST /api/dm/channels/:id/messages — send a DM ──────────
  const messageMatch = path.match(/^\/api\/dm\/channels\/([^/]+)\/messages$/);
  if (messageMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const body = await request.json();
      const result = await sendDmMessage(messageMatch[1], user.id, body.content, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);

      const doId = env.DM_ROOM.idFromName(messageMatch[1]);
      const doStub = env.DM_ROOM.get(doId);
      await doStub.fetch('https://internal/broadcast', {
        method: 'POST',
        body: JSON.stringify({
          id: result.message_id,
          channelId: messageMatch[1],
          senderId: user.id,
          content: body.content,
          createdAt: new Date().toISOString(),
        }),
      });

      return jsonResponse({ id: result.message_id, success: true }, 200);
    } catch (err) {
      console.error('Send DM error:', err);
      return jsonResponse({ error: 'Unable to send message. Please try again.' }, 500);
    }
  }

  return null;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
