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

  return { message_id: messageId };
}
