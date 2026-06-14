// ============================================================
// PROOF OF STAKE SYSTEM
// Post creation locks a stake into treasury.
// Community flags suspicious posts.
// Moderation resolves: stake returned (verified) or slashed (fake).
// Score updated on both outcomes.
// ============================================================

import { addScoreEvent } from './aurumScore.js';

// Stake tiers — minimum stake based on claim size
export const STAKE_TIERS = {
  micro:    { min: 5,    max: 49,   label: 'Micro Claim'   },
  standard: { min: 50,   max: 299,  label: 'Standard Claim' },
  major:    { min: 300,  max: 999,  label: 'Major Claim'   },
  elite:    { min: 1000, max: null, label: 'Elite Claim'   },
};

// How many flags before a post is auto-suspended pending moderation
const AUTO_SUSPEND_FLAG_COUNT = 5;

// ── POST CREATION ────────────────────────────────────────────

/**
 * Create a new Ledger post with stake locked in treasury.
 * Returns post in the exact shape the frontend expects.
 */
export async function createPost(userId, body, db) {
  const { content, stake_amount, media_url } = body;

  // Validate
  if (!content || content.trim().length === 0) {
    return { error: 'Post content is required' };
  }
  if (!stake_amount || stake_amount < 5) {
    return { error: 'Minimum stake is $5' };
  }

  const now    = new Date().toISOString();
  const postId = crypto.randomUUID();

  // Get user info for response shape
  const user = await db
    .prepare(`SELECT username, league, aurum_score FROM users WHERE id = ?`)
    .bind(userId)
    .first();

  if (!user) return { error: 'User not found' };

  // Check if user has any verified badges
  const badge = await db
    .prepare(`SELECT badge_type FROM badges WHERE user_id = ? LIMIT 1`)
    .bind(userId)
    .first();

  // Insert post — stake_status starts as 'locked'
  await db
    .prepare(`
      INSERT INTO posts
        (id, user_id, content, media_url, stake_amount, stake_status, tips_received, created_at)
      VALUES (?, ?, ?, ?, ?, 'locked', 0, ?)
    `)
    .bind(postId, userId, content.trim(), media_url ?? null, stake_amount, now)
    .run();

  // Lock stake in treasury ledger
  await db
    .prepare(`
      INSERT INTO treasury_ledger
        (id, post_id, user_id, amount, type, status, created_at)
      VALUES (?, ?, ?, ?, 'post_stake', 'locked', ?)
    `)
    .bind(crypto.randomUUID(), postId, userId, stake_amount, now)
    .run();

  // Return in exact shape frontend expects
  return {
    post: {
      id:           postId,
      username:     user.username,
      league:       user.league,
      verified:     !!badge,
      content:      content.trim(),
      stake_amount: stake_amount,
      stake_status: 'locked',
      tips_received: 0,
      created_at:   now,
    },
  };
}

// ── COMMUNITY FLAGGING ───────────────────────────────────────

/**
 * Flag a post as potentially fake.
 * Any authenticated member can flag once per post.
 * After AUTO_SUSPEND_FLAG_COUNT flags → post suspended pending moderation.
 */
export async function flagPost(postId, flaggedByUserId, reason, db) {
  // Check post exists
  const post = await db
    .prepare(`SELECT id, user_id, stake_status FROM posts WHERE id = ?`)
    .bind(postId)
    .first();

  if (!post) return { error: 'Post not found' };
  if (post.stake_status === 'slashed') return { error: 'Post already resolved as fake' };
  if (post.stake_status === 'returned') return { error: 'Post already verified' };

  // Prevent self-flagging
  if (post.user_id === flaggedByUserId) {
    return { error: 'You cannot flag your own post' };
  }

  // Prevent duplicate flags from same user
  const existing = await db
    .prepare(`SELECT id FROM post_flags WHERE post_id = ? AND flagged_by = ?`)
    .bind(postId, flaggedByUserId)
    .first();

  if (existing) return { error: 'You have already flagged this post' };

  const now = new Date().toISOString();

  // Insert flag
  await db
    .prepare(`
      INSERT INTO post_flags (id, post_id, flagged_by, reason, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .bind(crypto.randomUUID(), postId, flaggedByUserId, reason ?? null, now)
    .run();

  // Count total flags
  const { results } = await db
    .prepare(`SELECT COUNT(*) as count FROM post_flags WHERE post_id = ?`)
    .bind(postId)
    .all();

  const flagCount = results[0]?.count ?? 0;

  // Auto-suspend if threshold reached
  if (flagCount >= AUTO_SUSPEND_FLAG_COUNT && post.stake_status === 'locked') {
    await db
      .prepare(`UPDATE posts SET stake_status = 'suspended' WHERE id = ?`)
      .bind(postId)
      .run();
  }

  return {
    flagged:     true,
    flag_count:  flagCount,
    suspended:   flagCount >= AUTO_SUSPEND_FLAG_COUNT,
  };
}

// ── MODERATION RESOLUTION ────────────────────────────────────

/**
 * Resolve a flagged post — admin only.
 * verdict: 'verified' → stake returned + score boost
 * verdict: 'fake'     → stake slashed + score penalty
 */
export async function resolvePost(postId, verdict, moderatorId, db) {
  if (!['verified', 'fake'].includes(verdict)) {
    return { error: 'verdict must be verified or fake' };
  }

  const post = await db
    .prepare(`SELECT id, user_id, stake_amount, stake_status FROM posts WHERE id = ?`)
    .bind(postId)
    .first();

  if (!post) return { error: 'Post not found' };

  if (['returned', 'slashed'].includes(post.stake_status)) {
    return { error: 'Post has already been resolved' };
  }

  const now        = new Date().toISOString();
  const newStatus  = verdict === 'verified' ? 'returned' : 'slashed';

  // Update post stake_status
  await db
    .prepare(`UPDATE posts SET stake_status = ? WHERE id = ?`)
    .bind(newStatus, postId)
    .run();

  // Update treasury record
  await db
    .prepare(`
      UPDATE treasury_ledger
      SET status = ?, released_at = ?
      WHERE post_id = ? AND type = 'post_stake'
    `)
    .bind(newStatus, now, postId)
    .run();

  // Log moderation decision
  await db
    .prepare(`
      INSERT INTO moderation_log
        (id, post_id, moderator_id, verdict, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .bind(crypto.randomUUID(), postId, moderatorId, verdict, now)
    .run();

  // Apply score consequence
  if (verdict === 'verified') {
    await addScoreEvent(
      post.user_id,
      'verified_achievement_post',
      null,
      { post_id: postId, note: 'Post verified by moderation' },
      db,
    );
  } else {
    await addScoreEvent(
      post.user_id,
      'post_flagged_fake',
      null,
      { post_id: postId, note: 'Post ruled fake by moderation — stake slashed' },
      db,
    );
  }

  return {
    resolved:     true,
    post_id:      postId,
    verdict,
    stake_amount: post.stake_amount,
    stake_status: newStatus,
  };
}

/**
 * Get all posts — returns in exact shape frontend Ledger expects.
 */
export async function getLedgerPosts(limit, offset, db) {
  const { results } = await db
    .prepare(`
      SELECT
        p.id, p.content, p.stake_amount, p.stake_status,
        p.tips_received, p.created_at,
        u.username, u.league,
        EXISTS (
          SELECT 1 FROM badges b WHERE b.user_id = p.user_id LIMIT 1
        ) as verified
      FROM posts p
      JOIN users u ON u.id = p.user_id
      WHERE p.stake_status != 'slashed'
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `)
    .bind(limit ?? 20, offset ?? 0)
    .all();

  return results;
}