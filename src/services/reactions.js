const VALID_EMOJI = ['🔥', '👑', '💰', '⚔️', '😂', '🖤'];
const VALID_TYPES = ['crew', 'dm'];

async function getMessageRow(messageType, messageId, db) {
  const table = messageType === 'crew' ? 'crew_messages' : 'dm_messages';
  const ownerCol = messageType === 'crew' ? 'sender_id, crew_id' : 'sender_id, channel_id';
  const row = await db
    .prepare(`SELECT id, ${ownerCol} FROM ${table} WHERE id = ? AND deleted_at IS NULL`)
    .bind(messageId)
    .first();
  return row || null;
}

export async function setReaction(messageType, messageId, userId, emoji, db) {
  if (!VALID_TYPES.includes(messageType)) {
    return { error: 'Invalid message type' };
  }
  if (!VALID_EMOJI.includes(emoji)) {
    return { error: 'Invalid emoji' };
  }
  const messageRow = await getMessageRow(messageType, messageId, db);
  if (!messageRow) {
    return { error: 'Message not found' };
  }
  // One reaction per user per message: clear any existing reaction first, then insert the new one
  await db
    .prepare(`DELETE FROM message_reactions WHERE message_type = ? AND message_id = ? AND user_id = ?`)
    .bind(messageType, messageId, userId)
    .run();
  const reactionId = crypto.randomUUID();
  await db
    .prepare(`INSERT INTO message_reactions (id, message_type, message_id, user_id, emoji) VALUES (?, ?, ?, ?, ?)`)
    .bind(reactionId, messageType, messageId, userId, emoji)
    .run();

  // Notify the message author (skip self-reactions)
  if (messageRow.sender_id && messageRow.sender_id !== userId) {
    try {
      const reactorRow = await db.prepare(`SELECT username FROM users WHERE id = ?`).bind(userId).first();
      const reactorName = reactorRow?.username || 'Someone';
      const actionUrl = messageType === 'crew'
        ? `/crews/${messageRow.crew_id}`
        : `/messages/${messageRow.channel_id}`;
      await db.prepare(`
          INSERT INTO notifications (id, user_id, type, title, body, action_url, created_at)
          VALUES (?, ?, 'message_reaction', 'New reaction', ?, ?, ?)
        `)
        .bind(
          crypto.randomUUID(),
          messageRow.sender_id,
          `${reactorName} reacted ${emoji} to your message.`,
          actionUrl,
          new Date().toISOString(),
        )
        .run();
    } catch (err) {
      // Non-fatal — reaction itself already succeeded, notification failure shouldn't break the request
    }
  }

  return { reaction_id: reactionId };
}

export async function removeReaction(messageType, messageId, userId, db) {
  if (!VALID_TYPES.includes(messageType)) {
    return { error: 'Invalid message type' };
  }
  await db
    .prepare(`DELETE FROM message_reactions WHERE message_type = ? AND message_id = ? AND user_id = ?`)
    .bind(messageType, messageId, userId)
    .run();
  return { removed: true };
}

export async function getReactionsForMessages(messageType, messageIds, currentUserId, db) {
  if (!messageIds || messageIds.length === 0) return {};
  const placeholders = messageIds.map(() => '?').join(',');
  const { results } = await db
    .prepare(`
      SELECT message_id, emoji, user_id
      FROM message_reactions
      WHERE message_type = ? AND message_id IN (${placeholders})
    `)
    .bind(messageType, ...messageIds)
    .all();

  const grouped = {};
  for (const row of results) {
    if (!grouped[row.message_id]) grouped[row.message_id] = {};
    if (!grouped[row.message_id][row.emoji]) {
      grouped[row.message_id][row.emoji] = { count: 0, reacted_by_me: false };
    }
    grouped[row.message_id][row.emoji].count += 1;
    if (row.user_id === currentUserId) {
      grouped[row.message_id][row.emoji].reacted_by_me = true;
    }
  }
  return grouped;
}
