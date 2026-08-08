export async function getOrCreateDmChannel(userAId, userBId, db) {
  if (userAId === userBId) {
    return { error: 'Cannot start a DM with yourself' };
  }

  // Consistent ordering so (A,B) and (B,A) always map to the same row
  const [firstId, secondId] = [userAId, userBId].sort();

  const existing = await db
    .prepare(`SELECT id FROM dm_channels WHERE user_a_id = ? AND user_b_id = ?`)
    .bind(firstId, secondId)
    .first();

  if (existing) return { channel_id: existing.id, created: false };

  const channelId = crypto.randomUUID();
  await db
    .prepare(`INSERT INTO dm_channels (id, user_a_id, user_b_id) VALUES (?, ?, ?)`)
    .bind(channelId, firstId, secondId)
    .run();

  return { channel_id: channelId, created: true };
}

export async function getDmChannels(userId, db) {
  const { results } = await db.prepare(`
    SELECT
      c.id AS channel_id,
      CASE WHEN c.user_a_id = ? THEN c.user_b_id ELSE c.user_a_id END AS other_user_id,
      u.username AS other_username,
      (SELECT content FROM dm_messages WHERE channel_id = c.id AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1) AS last_message,
      (SELECT created_at FROM dm_messages WHERE channel_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message_at
    FROM dm_channels c
    JOIN users u ON u.id = (CASE WHEN c.user_a_id = ? THEN c.user_b_id ELSE c.user_a_id END)
    WHERE c.user_a_id = ? OR c.user_b_id = ?
    ORDER BY last_message_at DESC
  `).bind(userId, userId, userId, userId).all();
  return results;
}

export async function getDmMessages(channelId, limit, before, db) {
  const params = [channelId];
  let query = `
    SELECT id, sender_id, content, created_at, deleted_at
    FROM dm_messages
    WHERE channel_id = ?
  `;
  if (before) {
    query += ` AND created_at < ?`;
    params.push(before);
  }
  query += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit || 50);
  const { results } = await db.prepare(query).bind(...params).all();
  return results.map(m => ({
    id: m.id,
    sender_id: m.sender_id,
    content: m.deleted_at ? null : m.content,
    deleted: !!m.deleted_at,
    created_at: m.created_at,
  }));
}

export async function sendDmMessage(channelId, senderId, content, db) {
  const channel = await db
    .prepare(`SELECT user_a_id, user_b_id FROM dm_channels WHERE id = ?`)
    .bind(channelId)
    .first();

  if (!channel) return { error: 'Channel not found' };
  if (senderId !== channel.user_a_id && senderId !== channel.user_b_id) {
    return { error: 'You are not a participant in this conversation' };
  }
  if (!content || content.trim().length === 0) {
    return { error: 'Message cannot be empty' };
  }

  const messageId = crypto.randomUUID();
  await db
    .prepare(`INSERT INTO dm_messages (id, channel_id, sender_id, content) VALUES (?, ?, ?, ?)`)
    .bind(messageId, channelId, senderId, content)
    .run();

  const recipientId = senderId === channel.user_a_id ? channel.user_b_id : channel.user_a_id;
  const senderRow = await db.prepare(`SELECT username FROM users WHERE id = ?`).bind(senderId).first();
  await db.prepare(`
      INSERT INTO notifications (id, user_id, type, title, body, action_url, created_at)
      VALUES (?, ?, 'dm_received', 'New message', ?, ?, ?)
    `)
    .bind(
      crypto.randomUUID(),
      recipientId,
      `${senderRow?.username || 'Someone'} sent you a message.`,
      `/messages/${channelId}`,
      new Date().toISOString(),
    )
    .run();

  return { message_id: messageId };
}
