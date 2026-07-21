// disputeResolution.js
// Admin queue + actions for reviewing suspended/appealed posts.
// FIX: rewritten to query the real, current tables (post_stakes,
// post_flags, posts.moderation_status) instead of dead columns
// left over from before the stake system moved to post_stakes.
// Actions now delegate to the real, working resolvePost/resolveAppeal
// in proofOfStake.js rather than duplicating broken logic here.

import { resolvePost, resolveAppeal } from './proofOfStake.js';

/**
 * Suspended posts (5+ flags, stake still locked) needing a verdict.
 */
export async function getSuspendedPosts(env, limit = 50, offset = 0) {
  const { results } = await env.DB.prepare(`
    SELECT
      p.id, p.content, p.created_at, p.moderation_status,
      ps.amount_usd AS stake_amount, ps.status AS stake_status,
      u.username, u.id AS user_id,
      (SELECT COUNT(*) FROM post_flags pf WHERE pf.post_id = p.id) AS flag_count
    FROM posts p
    JOIN users u ON u.id = p.user_id
    JOIN post_stakes ps ON ps.post_id = p.id
    WHERE p.moderation_status = 'suspended'
      AND ps.status = 'locked'
    ORDER BY p.updated_at ASC
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all();
  return results || [];
}

/**
 * Submitted appeals (user contested a 'fake' verdict) needing a decision.
 */
export async function getSubmittedAppeals(env, limit = 50, offset = 0) {
  const { results } = await env.DB.prepare(`
    SELECT
      p.id, p.content, p.created_at,
      ps.amount_usd AS stake_amount, ps.appeal_reason, ps.appeal_deadline,
      u.username, u.id AS user_id
    FROM posts p
    JOIN users u ON u.id = p.user_id
    JOIN post_stakes ps ON ps.post_id = p.id
    WHERE ps.status = 'appeal_pending'
      AND ps.appeal_status = 'submitted'
    ORDER BY ps.appeal_deadline ASC
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all();
  return results || [];
}

/** Combined queue — both categories in one payload. */
export async function getDisputeQueue(env, limit = 50, offset = 0) {
  const [suspended, appeals] = await Promise.all([
    getSuspendedPosts(env, limit, offset),
    getSubmittedAppeals(env, limit, offset),
  ]);
  return { suspended_posts: suspended, submitted_appeals: appeals };
}

/** Admin rules a suspended post 'verified' or 'fake' — real logic in proofOfStake.js. */
export async function verifyDisputedPost(postId, adminId, env) {
  return resolvePost(postId, 'verified', adminId, env.DB);
}
export async function slashDisputedPost(postId, adminId, reason, env) {
  return resolvePost(postId, 'fake', adminId, env.DB);
}

/** Admin rules on a submitted appeal — real logic in proofOfStake.js. */
export async function decideAppeal(postId, decision, adminId, env) {
  return resolveAppeal(postId, decision, adminId, env.DB);
}
