import { getOrCreateDmChannel, sendDmMessage, getDmChannels, getDmMessages } from '../services/dm.js';
import { requireAuth, requireAuthFromQuery } from '../middleware/auth.js';
import { setReaction, removeReaction, getReactionsForMessages } from '../services/reactions.js';
export async function handleDmRoutes(path, method, request, env) {
  const db = env.DB;

  // ── POST /api/dm/channels — start or find a DM channel ──────
  if (path === '/api/dm/channels' && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const body = await request.json();
      if (!body.target_user_id) return jsonResponse({ error: 'target_user_id is required' }, 400);
      const userRow = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(user.id).first();
      if (!userRow) return jsonResponse({ error: 'User not found' }, 404);
      const result = await getOrCreateDmChannel(userRow.id, body.target_user_id, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result, result.created ? 201 : 200);
    } catch (err) {
      console.error('Get/create DM channel error:', err);
      return jsonResponse({ error: 'Unable to open conversation. Please try again.' }, 500);
    }
  }

	// ── GET /api/dm/channels ── list my DM conversations ─────────
  if (path === '/api/dm/channels' && method === 'GET') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const userRow = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(user.id).first();
      if (!userRow) return jsonResponse({ error: 'User not found' }, 404);
      const channels = await getDmChannels(userRow.id, db);
      return jsonResponse({ channels });
    } catch (err) {
      console.error('List DM channels error:', err);
      return jsonResponse({ error: 'Unable to load conversations. Please try again.' }, 500);
    }
  }

  // ── GET /api/dm/channels/:id/messages ── message history ──────
  const dmHistoryMatch = path.match(/^\/api\/dm\/channels\/([^/]+)\/messages$/);
  if (dmHistoryMatch && method === 'GET') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const userRow = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(user.id).first();
      if (!userRow) return jsonResponse({ error: 'User not found' }, 404);
      const channel = await db
        .prepare(`SELECT id FROM dm_channels WHERE id = ? AND (user_a_id = ? OR user_b_id = ?)`)
        .bind(dmHistoryMatch[1], userRow.id, userRow.id)
        .first();
      if (!channel) return jsonResponse({ error: 'You are not part of this conversation' }, 403);

      const url = new URL(request.url);
      const before = url.searchParams.get('before');
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const messages = await getDmMessages(dmHistoryMatch[1], limit, before, db);
      return jsonResponse({ messages });
    } catch (err) {
      console.error('Get DM history error:', err);
      return jsonResponse({ error: 'Unable to load messages. Please try again.' }, 500);
    }
  }

	// ── GET /api/dm/channels/:id/ws ── live DM WebSocket connection ──
  const wsMatch = path.match(/^\/api\/dm\/channels\/([^/]+)\/ws$/);
  if (wsMatch && method === 'GET') {
    const user = await requireAuthFromQuery(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    const userRow = await db
      .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
      .bind(user.id)
      .first();
    if (!userRow) return jsonResponse({ error: 'User not found' }, 404);

    const channel = await db
      .prepare(`SELECT id FROM dm_channels WHERE id = ? AND (user_a_id = ? OR user_b_id = ?)`)
      .bind(wsMatch[1], userRow.id, userRow.id)
      .first();
    if (!channel) return jsonResponse({ error: 'You are not part of this conversation' }, 403);

    const doId = env.DM_ROOM.idFromName(wsMatch[1]);
    const doStub = env.DM_ROOM.get(doId);
    return doStub.fetch(request);
  }

  // ── POST /api/dm/channels/:id/messages — send a DM ──────────
  const messageMatch = path.match(/^\/api\/dm\/channels\/([^/]+)\/messages$/);
  if (messageMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const body = await request.json();
      const userRow = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(user.id).first();
      if (!userRow) return jsonResponse({ error: 'User not found' }, 404);
      const result = await sendDmMessage(messageMatch[1], userRow.id, body.content, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      const doId = env.DM_ROOM.idFromName(messageMatch[1]);
      const doStub = env.DM_ROOM.get(doId);
      await doStub.fetch('https://internal/broadcast', {
        method: 'POST',
        body: JSON.stringify({
          id: result.message_id,
          channelId: messageMatch[1],
          senderId: userRow.id,
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

  // ── POST /api/dm-messages/:id/reactions — set my reaction ──
  const dmReactionMatch = path.match(/^\/api\/dm-messages\/([^/]+)\/reactions$/);
  if (dmReactionMatch && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const body = await request.json();
      if (!body.emoji) return jsonResponse({ error: 'emoji is required' }, 400);
      const userRow = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(user.id).first();
      if (!userRow) return jsonResponse({ error: 'User not found' }, 404);
      const result = await setReaction('dm', dmReactionMatch[1], userRow.id, body.emoji, db);
      if (result.error) return jsonResponse({ error: result.error }, 400);

      const msgRow = await db.prepare(`SELECT channel_id FROM dm_messages WHERE id = ?`).bind(dmReactionMatch[1]).first();
      if (msgRow) {
        const doId = env.DM_ROOM.idFromName(msgRow.channel_id);
        const doStub = env.DM_ROOM.get(doId);
        await doStub.fetch('https://internal/broadcast', {
          method: 'POST',
          body: JSON.stringify({
            type: 'reaction',
            messageId: dmReactionMatch[1],
            userId: userRow.id,
            emoji: body.emoji,
            action: 'set',
          }),
        });
      }
      return jsonResponse({ success: true }, 200);
    } catch (err) {
      console.error('Set DM reaction error:', err);
      return jsonResponse({ error: 'Unable to react. Please try again.' }, 500);
    }
  }

	// ── POST /api/dm-messages/reactions/batch — fetch reactions for many messages ──
  if (path === '/api/dm-messages/reactions/batch' && method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const body = await request.json();
      const messageIds = Array.isArray(body.message_ids) ? body.message_ids : [];
      const userRow = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(user.id).first();
      if (!userRow) return jsonResponse({ error: 'User not found' }, 404);
      const reactions = await getReactionsForMessages('dm', messageIds, userRow.id, db);
      return jsonResponse({ reactions });
    } catch (err) {
      console.error('Batch fetch DM reactions error:', err);
      return jsonResponse({ error: 'Unable to load reactions. Please try again.' }, 500);
    }
  }

  // ── DELETE /api/dm-messages/:id/reactions — remove my reaction ──
  if (dmReactionMatch && method === 'DELETE') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    try {
      const userRow = await db.prepare(`SELECT id FROM users WHERE clerk_id = ?`).bind(user.id).first();
      if (!userRow) return jsonResponse({ error: 'User not found' }, 404);
      await removeReaction('dm', dmReactionMatch[1], userRow.id, db);

      const msgRow = await db.prepare(`SELECT channel_id FROM dm_messages WHERE id = ?`).bind(dmReactionMatch[1]).first();
      if (msgRow) {
        const doId = env.DM_ROOM.idFromName(msgRow.channel_id);
        const doStub = env.DM_ROOM.get(doId);
        await doStub.fetch('https://internal/broadcast', {
          method: 'POST',
          body: JSON.stringify({
            type: 'reaction',
            messageId: dmReactionMatch[1],
            userId: userRow.id,
            action: 'remove',
          }),
        });
      }
      return jsonResponse({ success: true }, 200);
    } catch (err) {
      console.error('Remove DM reaction error:', err);
      return jsonResponse({ error: 'Unable to remove reaction. Please try again.' }, 500);
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
