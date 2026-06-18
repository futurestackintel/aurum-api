// disputeResolution.js
// Admin endpoint logic for ruling on flagged Proof of Stake posts.
// Two outcomes:
//   - verify:  stake returned to user + Aurum Score boost
//   - slash:   stake forfeited to treasury + Aurum Score penalty + notification
// Integrates with existing proofOfStake.js logic from Chat 5.

import { addScoreEvent } from "./aurumScore.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const STAKE_VERIFY_SCORE_BOOST  =  50;
const STAKE_SLASH_SCORE_PENALTY = -100;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get all posts currently under dispute (flagged for fake_achievement).
 * Called from GET /admin/disputes
 * Returns posts with their flag details and user info.
 */
export async function getDisputeQueue(env, limit = 50, offset = 0) {
  const results = await env.DB.prepare(`
    SELECT
      p.id            as post_id,
      p.user_id,
      p.content,
      p.stake_amount,
      p.stake_status,
      p.created_at    as post_created_at,
      u.username,
      u.league,
      u.aurum_score,
      mf.id           as flag_id,
      mf.reason,
      mf.notes        as flag_notes,
      mf.created_at   as flagged_at,
      reporter.username as reporter_username
    FROM posts p
    JOIN users u ON u.id = p.user_id
    JOIN moderation_flags mf
      ON mf.target_id   = p.id
     AND mf.target_type = 'post'
     AND mf.status      = 'pending'
    LEFT JOIN users reporter ON reporter.id = mf.reporter_id
    WHERE p.stake_status = 'locked'
      AND mf.reason IN ('fake_achievement', 'fraud')
    ORDER BY mf.created_at ASC
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all();

  return results.results;
}

/**
 * Admin verifies a disputed post — stake is legitimate.
 * - Returns stake to user
 * - Boosts Aurum Score
 * - Resolves the moderation flag
 * - Notifies user
 * Called from POST /admin/disputes/:postId/verify
 */
export async function verifyDisputedPost(postId, adminId, env) {
  const post = await getLockedPost(postId, env);

  // Return the stake
  await env.DB.prepare(`
    UPDATE posts
    SET stake_status = 'returned'
    WHERE id = ?
  `).bind(postId).run();

  // Boost Aurum Score via score engine
  await addScoreEvent(
    post.user_id,
    "achievement_verified",
    STAKE_VERIFY_SCORE_BOOST,
    { post_id: postId },
    env.DB
  );

  // Resolve all pending flags on this post
  await resolvePostFlags(postId, adminId, 'dismissed', 'Post verified by admin — stake returned', env);

  // Notify user
  await sendNotification(env, {
    userId:    post.user_id,
    type:      'stake_verified',
    title:     'Achievement Verified ✓',
    body:      'Your staked post has been reviewed and verified. Your stake has been returned.',
    actionUrl: `/posts/${postId}`,
    metadata:  JSON.stringify({ post_id: postId, score_boost: STAKE_VERIFY_SCORE_BOOST }),
  });

  return {
    success:    true,
    postId,
    userId:     post.user_id,
    scoreBoost: STAKE_VERIFY_SCORE_BOOST,
  };
}

/**
 * Admin slashes a disputed post — stake is forfeited.
 * - Stake moves to treasury
 * - Aurum Score penalty applied
 * - Moderation flag actioned
 * - User notified with reason
 * Called from POST /admin/disputes/:postId/slash
 */
export async function slashDisputedPost(postId, adminId, reason, env) {
  if (!reason || reason.trim().length < 10) {
    throw new Error('A slash reason of at least 10 characters is required');
  }

  const post = await getLockedPost(postId, env);

  // Forfeit the stake
  await env.DB.prepare(`
    UPDATE posts
    SET stake_status = 'slashed'
    WHERE id = ?
  `).bind(postId).run();

  // Record forfeited amount in treasury ledger
  await recordTreasuryForfeiture(env, {
    postId,
    userId:      post.user_id,
    amountCents: post.stake_amount,
    adminId,
    reason:      reason.trim(),
  });

  // Apply Aurum Score penalty via score engine
  await addScoreEvent(
    post.user_id,
    "post_flagged_fake",
    STAKE_SLASH_SCORE_PENALTY,
    { post_id: postId },
    env.DB
  );

  // Resolve all pending flags on this post as actioned
  await resolvePostFlags(postId, adminId, 'actioned', reason.trim(), env);

  // Notify user
  await sendNotification(env, {
    userId:    post.user_id,
    type:      'stake_forfeited',
    title:     'Stake Forfeited',
    body:      `Your staked post was reviewed and your stake has been forfeited. Reason: ${reason.trim()}`,
    actionUrl: `/posts/${postId}`,
    metadata:  JSON.stringify({
      post_id:       postId,
      amount_cents:  post.stake_amount,
      score_penalty: STAKE_SLASH_SCORE_PENALTY,
    }),
  });

  return {
    success:      true,
    postId,
    userId:       post.user_id,
    amountCents:  post.stake_amount,
    scorePenalty: STAKE_SLASH_SCORE_PENALTY,
  };
}

/**
 * Get a single disputed post with full flag history.
 * Called from GET /admin/disputes/:postId
 */
export async function getDisputeDetail(postId, env) {
  const post = await env.DB.prepare(`
    SELECT
      p.*,
      u.username,
      u.email,
      u.league,
      u.aurum_score
    FROM posts p
    JOIN users u ON u.id = p.user_id
    WHERE p.id = ?
  `).bind(postId).first();

  if (!post) throw new Error('Post not found');

  const flags = await env.DB.prepare(`
    SELECT
      mf.*,
      u.username as reporter_username
    FROM moderation_flags mf
    LEFT JOIN users u ON u.id = mf.reporter_id
    WHERE mf.target_id   = ?
      AND mf.target_type = 'post'
    ORDER BY mf.created_at DESC
  `).bind(postId).all();

  return { post, flags: flags.results };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function getLockedPost(postId, env) {
  const post = await env.DB.prepare(`
    SELECT * FROM posts
    WHERE id = ? AND stake_status = 'locked'
  `).bind(postId).first();

  if (!post) throw new Error('Post not found or stake is not in locked state');
  return post;
}

async function resolvePostFlags(postId, adminId, decision, actionTaken, env) {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE moderation_flags
    SET
      status       = ?,
      reviewed_by  = ?,
      reviewed_at  = ?,
      action_taken = ?
    WHERE target_id   = ?
      AND target_type = 'post'
      AND status      = 'pending'
  `).bind(decision, adminId, now, actionTaken, postId).run();
}

async function recordTreasuryForfeiture(env, { postId, userId, amountCents, adminId, reason }) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO treasury_ledger
      (id, post_id, user_id, amount, status, admin_id, reason, created_at)
    VALUES (?, ?, ?, ?, 'forfeited', ?, ?, ?)
  `).bind(id, postId, userId, amountCents, adminId, reason, now).run();
}

async function sendNotification(env, { userId, type, title, body, actionUrl, metadata }) {
  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO notifications
      (id, user_id, type, title, body, action_url, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(id, userId, type, title, body, actionUrl ?? null, metadata ?? null).run();
		}
