// ============================================================
// AURUM COMMENTS SERVICE
// Uses the existing post_comments table (id, post_id, user_id,
// parent_comment_id, content, moderation_status, created_at,
// deleted_at). Threading is supported via parent_comment_id —
// a null parent means a top-level comment, a non-null parent
// means a reply to that comment.
//
// Design decisions (per user):
//   - Full threading (replies to replies) supported.
//   - Free to comment — no stake required.
//   - Only the comment's author can delete it (soft delete via
//     deleted_at, matching the pattern already used elsewhere,
//     e.g. posts.deleted_at, users.deleted_at).
// ============================================================

const MAX_COMMENT_LENGTH = 1000;

function nowISO() {
  return new Date().toISOString();
}

async function resolveUserId(clerkId, db) {
  const row = await db
    .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
    .bind(clerkId)
    .first();
  return row?.id ?? null;
}

// ── CREATE COMMENT (top-level or reply) ──────────────────────

export async function createComment(postId, clerkId, body, db) {
  const userId = await resolveUserId(clerkId, db);
  if (!userId) return { error: 'User not found' };

  const { content, parent_comment_id } = body;

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return { error: 'Comment content is required' };
  }
  if (content.trim().length > MAX_COMMENT_LENGTH) {
    return { error: `Comment must be ${MAX_COMMENT_LENGTH} characters or fewer` };
  }

  const post = await db
    .prepare(`SELECT id, user_id FROM posts WHERE id = ? AND deleted_at IS NULL`)
    .bind(postId)
    .first();

  if (!post) return { error: 'Post not found' };

  // If replying, confirm the parent comment exists, belongs to
  // this same post, and isn't itself deleted.
  if (parent_comment_id) {
    const parent = await db
      .prepare(`
        SELECT id FROM post_comments
        WHERE id = ? AND post_id = ? AND deleted_at IS NULL
      `)
      .bind(parent_comment_id, postId)
      .first();

    if (!parent) return { error: 'Parent comment not found' };
  }

  const now       = nowISO();
  const commentId = crypto.randomUUID();

  await db
    .prepare(`
      INSERT INTO post_comments
        (id, post_id, user_id, parent_comment_id, content,
         moderation_status, created_at)
      VALUES (?, ?, ?, ?, ?, 'approved', ?)
    `)
    .bind(
      commentId,
      postId,
      userId,
      parent_comment_id ?? null,
      content.trim(),
      now,
    )
    .run();

  // Keep posts.comment_count in sync — used across the app for
  // display counts (e.g. ledger feed cards).
  await db
    .prepare(`
      UPDATE posts SET comment_count = comment_count + 1
      WHERE id = ?
    `)
    .bind(postId)
    .run();

  // Notify the post author, unless they're commenting on their
  // own post. If this is a reply, also notify the parent
  // comment's author (if different from both the post author
  // and the replier) so reply threads actually reach people.
  const notifyTargets = new Set();
  if (post.user_id !== userId) notifyTargets.add(post.user_id);

  if (parent_comment_id) {
    const parentAuthor = await db
      .prepare(`SELECT user_id FROM post_comments WHERE id = ?`)
      .bind(parent_comment_id)
      .first();
    if (parentAuthor && parentAuthor.user_id !== userId) {
      notifyTargets.add(parentAuthor.user_id);
    }
  }

  for (const targetUserId of notifyTargets) {
    await db
      .prepare(`
        INSERT INTO notifications
          (id, user_id, type, title, body, reference_id, created_at)
        VALUES (?, ?, 'post_comment', 'New comment', ?, ?, ?)
      `)
      .bind(
        crypto.randomUUID(),
        targetUserId,
        parent_comment_id
          ? 'Someone replied to your comment'
          : 'Someone commented on your post',
        postId,
        now,
      )
      .run();
  }

  const author = await db
    .prepare(`SELECT username, league FROM users WHERE id = ?`)
    .bind(userId)
    .first();

  return {
    comment: {
      id: commentId,
      post_id: postId,
      parent_comment_id: parent_comment_id ?? null,
      content: content.trim(),
      created_at: now,
      user_id: userId,
      username: author?.username ?? null,
      league: author?.league ?? null,
      replies: [],
    },
  };
}

// ── GET COMMENTS FOR A POST (threaded) ────────────────────────

export async function getCommentsForPost(postId, db) {
  const post = await db
    .prepare(`SELECT id FROM posts WHERE id = ? AND deleted_at IS NULL`)
    .bind(postId)
    .first();

  if (!post) return { error: 'Post not found' };

  const { results: rows } = await db
    .prepare(`
      SELECT
        pc.id, pc.parent_comment_id, pc.content, pc.created_at,
        pc.user_id, u.username, u.league
      FROM post_comments pc
      JOIN users u ON u.id = pc.user_id
      WHERE pc.post_id = ?
        AND pc.deleted_at IS NULL
        AND pc.moderation_status = 'approved'
      ORDER BY pc.created_at ASC
    `)
    .bind(postId)
    .all();

  // Build the reply tree in memory — comment volume per post is
  // small enough that this is simpler and fast enough compared
  // to a recursive CTE (D1/SQLite support WITH RECURSIVE, but
  // this keeps the query portable and easy to reason about).
  const byId = new Map();
  const roots = [];

  for (const row of rows) {
    byId.set(row.id, { ...row, replies: [] });
  }

  for (const row of rows) {
    const node = byId.get(row.id);
    if (row.parent_comment_id && byId.has(row.parent_comment_id)) {
      byId.get(row.parent_comment_id).replies.push(node);
    } else {
      roots.push(node);
    }
  }

  return {
    comments: roots,
    total: rows.length,
  };
}

// ── DELETE COMMENT (author only, soft delete) ─────────────────

export async function deleteComment(commentId, clerkId, db) {
  const userId = await resolveUserId(clerkId, db);
  if (!userId) return { error: 'User not found' };

  const comment = await db
    .prepare(`
      SELECT id, post_id, user_id FROM post_comments
      WHERE id = ? AND deleted_at IS NULL
    `)
    .bind(commentId)
    .first();

  if (!comment) return { error: 'Comment not found' };

  if (comment.user_id !== userId) {
    return { error: 'You can only delete your own comments' };
  }

  const now = nowISO();

  await db
    .prepare(`UPDATE post_comments SET deleted_at = ? WHERE id = ?`)
    .bind(now, commentId)
    .run();

  await db
    .prepare(`
      UPDATE posts
      SET comment_count = MAX(comment_count - 1, 0)
      WHERE id = ?
    `)
    .bind(comment.post_id)
    .run();

  return { deleted: true, comment_id: commentId };
}

