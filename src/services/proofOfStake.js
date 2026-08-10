// ============================================================
// PROOF OF STAKE SYSTEM
// Post creation locks a stake into post_stakes table.
// Community flags suspicious posts.
// Moderation resolves: stake returned (verified) or appeal_pending (fake).
// Appeal window: 48 hours. Cron finalises slash after deadline.
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

// Valid flag reasons
const VALID_FLAG_REASONS = ['fake_claim', 'no_evidence', 'misleading', 'spam'];

// ── POST CREATION ────────────────────────────────────────────

/**
 * Create a new Ledger post with stake locked in post_stakes.
 * Deducts stake from wallet balance before locking.
 * Returns post in the exact shape the frontend expects.
 */
export async function createPost(clerkId, body, db) {
  const { content, stake_amount, media_urls } = body;

  // Resolve Clerk ID to internal DB user ID
  const dbUser = await db
    .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
    .bind(clerkId)
    .first();

  if (!dbUser) return { error: 'User not found. Please complete registration.' };

  const userId = dbUser.id;

  // Validate content
  if (!content || content.trim().length === 0) {
    return { error: 'Post content is required' };
  }

  // Validate stake
  if (!stake_amount || stake_amount < 5) {
    return { error: 'Minimum stake is $5' };
  }

  // Check wallet balance before locking stake
  const wallet = await db
    .prepare(`SELECT id, balance_usd FROM wallets WHERE user_id = ?`)
    .bind(userId)
    .first();

  if (!wallet) {
    return { error: 'Wallet not found. Please contact support.' };
  }

  if (wallet.balance_usd < stake_amount) {
    return { error: 'Insufficient Aurum Balance to stake this amount.' };
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

  // Deduct stake from wallet balance
  const newBalance = wallet.balance_usd - stake_amount;

  await db
    .prepare(`UPDATE wallets SET balance_usd = ?, updated_at = ? WHERE user_id = ?`)
    .bind(newBalance, now, userId)
    .run();

  // Record wallet transaction for the stake lock
  await db
    .prepare(`
      INSERT INTO wallet_transactions
        (id, wallet_id, user_id, type, amount_usd,
         balance_after_usd, description, created_at)
      VALUES (?, ?, ?, 'stake_lock', ?, ?, 'Stake locked for Ledger post', ?)
    `)
    .bind(crypto.randomUUID(), wallet.id, userId, stake_amount, newBalance, now)
    .run();

  // Insert post using correct column names
  // stake_amount stored as cents, tips_received_cents starts at 0
  const stakeAmountCents = Math.round(stake_amount * 100);

  await db
    .prepare(`
      INSERT INTO posts
        (id, user_id, content, media_urls, stake_amount_cents,
         tips_received_cents, moderation_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, 'active', ?, ?)
    `)
    .bind(postId, userId, content.trim(), media_urls ?? null, stakeAmountCents, now, now)
    .run();

  // Insert into post_stakes — stake status tracked here, not on posts table
  await db
    .prepare(`
      INSERT INTO post_stakes
        (id, post_id, user_id, amount_usd, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'locked', ?, ?)
    `)
    .bind(crypto.randomUUID(), postId, userId, stake_amount, now, now)
    .run();

  return {
    post: {
      id:            postId,
      username:      user.username,
      league:        user.league,
      verified:      !!badge,
      content:       content.trim(),
      stake_amount:  stake_amount,
      stake_status:  'locked',
      tips_received: 0,
      created_at:    now,
    },
  };
}

// ── COMMUNITY FLAGGING ───────────────────────────────────────

/**
 * Flag a post as potentially fake.
 * Reason is required — must be one of VALID_FLAG_REASONS.
 * Any authenticated member can flag once per post.
 * After AUTO_SUSPEND_FLAG_COUNT flags → post suspended pending moderation.
 */
export async function flagPost(postId, flaggedByUserId, reason, db) {
  if (!reason) {
    return { error: 'Flag reason is required.' };
  }
  if (!VALID_FLAG_REASONS.includes(reason)) {
    return {
      error: `Invalid reason. Must be one of: ${VALID_FLAG_REASONS.join(', ')}.`,
    };
  }

  // Check post exists — use moderation_status not stake_status
  const post = await db
    .prepare(`SELECT id, user_id, moderation_status FROM posts WHERE id = ?`)
    .bind(postId)
    .first();

  if (!post) return { error: 'Post not found' };

  // Check stake status from post_stakes table
  const stake = await db
    .prepare(`SELECT status FROM post_stakes WHERE post_id = ?`)
    .bind(postId)
    .first();

  if (stake?.status === 'slashed')  return { error: 'Post already resolved as fake' };
  if (stake?.status === 'returned') return { error: 'Post already verified' };

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
    .bind(crypto.randomUUID(), postId, flaggedByUserId, reason, now)
    .run();

  // Count total flags
  const { results } = await db
    .prepare(`SELECT COUNT(*) as count FROM post_flags WHERE post_id = ?`)
    .bind(postId)
    .all();

  const flagCount = results[0]?.count ?? 0;

  // Auto-suspend if threshold reached — sets moderation_status on posts table
  if (flagCount >= AUTO_SUSPEND_FLAG_COUNT && stake?.status === 'locked') {
    await db
      .prepare(`UPDATE posts SET moderation_status = 'suspended', updated_at = ? WHERE id = ?`)
      .bind(now, postId)
      .run();
  }

  return {
    flagged:    true,
    flag_count: flagCount,
    suspended:  flagCount >= AUTO_SUSPEND_FLAG_COUNT,
  };
}

// ── DELETE POST ───────────────────────────────────────────────

/**
 * Soft-delete a post. Only the post's owner can delete their own post.
 * If the stake is still 'locked' (never resolved), it's returned to
 * the owner's wallet first — a deleted post shouldn't leave money stuck.
 * Posts already in appeal_pending or slashed are blocked from self-delete
 * since they have an active/resolved moderation case tied to other users
 * (flaggers already paid out, etc.) — those need admin handling instead.
 */
export async function deletePost(postId, userId, db) {
  const post = await db
    .prepare(`SELECT id, user_id, deleted_at FROM posts WHERE id = ?`)
    .bind(postId)
    .first();

  if (!post) return { error: 'Post not found' };
  if (post.user_id !== userId) return { error: 'You can only delete your own posts' };
  if (post.deleted_at) return { error: 'Post has already been deleted' };

  const stake = await db
    .prepare(`SELECT status, amount_usd FROM post_stakes WHERE post_id = ?`)
    .bind(postId)
    .first();

  if (stake && ['appeal_pending', 'slashed'].includes(stake.status)) {
    return { error: 'This post has an active or resolved moderation case and cannot be deleted directly. Contact support.' };
  }

  const now = new Date().toISOString();
  let stakeReturned = 0;

  if (stake && stake.status === 'locked') {
    await _returnStakeToWallet(userId, stake.amount_usd, postId, db, now);
    await db
      .prepare(`UPDATE post_stakes SET status = 'returned', updated_at = ? WHERE post_id = ?`)
      .bind(now, postId)
      .run();
    stakeReturned = stake.amount_usd;
  }

  await db
    .prepare(`
      UPDATE posts
      SET deleted_at = ?, moderation_status = 'removed', updated_at = ?
      WHERE id = ?
    `)
    .bind(now, now, postId)
    .run();

  return { deleted: true, post_id: postId, stake_returned: stakeReturned };
}

// ── MODERATION RESOLUTION ────────────────────────────────────

/**
 * Resolve a flagged post — admin only.
 * verdict: 'verified' → stake returned to user + score boost
 * verdict: 'fake'     → sets appeal_pending in post_stakes (NOT slashed yet)
 *                       Slash finalised by cron after 48h deadline.
 */
export async function resolvePost(postId, verdict, moderatorId, db) {
  if (!['verified', 'fake'].includes(verdict)) {
    return { error: 'verdict must be verified or fake' };
  }

  const post = await db
    .prepare(`SELECT id, user_id FROM posts WHERE id = ?`)
    .bind(postId)
    .first();

  if (!post) return { error: 'Post not found' };

  // All stake state lives in post_stakes
  const stake = await db
    .prepare(`SELECT id, amount_usd, status FROM post_stakes WHERE post_id = ?`)
    .bind(postId)
    .first();

  if (!stake) return { error: 'Stake record not found' };

  if (['returned', 'slashed', 'appeal_pending'].includes(stake.status)) {
    return { error: 'Post has already been resolved' };
  }

  const now = new Date().toISOString();

  if (verdict === 'verified') {
    // Return stake to wallet
    await _returnStakeToWallet(post.user_id, stake.amount_usd, postId, db, now);

    // Update post_stakes status — NOT posts table
    await db
      .prepare(`UPDATE post_stakes SET status = 'returned', updated_at = ? WHERE post_id = ?`)
      .bind(now, postId)
      .run();

    // Score boost
    await addScoreEvent(
      post.user_id,
      'verified_achievement_post',
      null,
      { post_id: postId, note: 'Post verified by moderation' },
      db,
    );

  } else {
    // Set appeal_pending in post_stakes — NOT slashed yet
    const appealDeadline = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

    await db
      .prepare(`
        UPDATE post_stakes
        SET status = 'appeal_pending',
            appeal_deadline = ?,
            appeal_status = 'open',
            updated_at = ?
        WHERE post_id = ?
      `)
      .bind(appealDeadline, now, postId)
      .run();

    // Score penalty applied immediately on verdict
    await addScoreEvent(
      post.user_id,
      'post_flagged_fake',
      null,
      { post_id: postId, note: 'Post ruled fake by moderation — appeal window open' },
      db,
    );
  }

  // Log moderation decision
  await db
    .prepare(`
      INSERT INTO moderation_log
        (id, post_id, moderator_id, verdict, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .bind(crypto.randomUUID(), postId, moderatorId, verdict, now)
    .run();

  const appealDeadline = verdict === 'fake'
    ? new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
    : null;

  return {
    resolved:        true,
    post_id:         postId,
    verdict,
    stake_amount:    stake.amount_usd,
    stake_status:    verdict === 'verified' ? 'returned' : 'appeal_pending',
    appeal_deadline: appealDeadline,
  };
}

// ── APPEAL ───────────────────────────────────────────────────

/**
 * User submits an appeal within the 48h window.
 * appeal_status moves from 'open' → 'submitted' in post_stakes.
 */
export async function appealPost(postId, userId, appealReason, db) {
  if (!appealReason || appealReason.trim().length === 0) {
    return { error: 'Appeal reason is required.' };
  }

  const post = await db
    .prepare(`SELECT id, user_id FROM posts WHERE id = ?`)
    .bind(postId)
    .first();

  if (!post) return { error: 'Post not found' };

  if (post.user_id !== userId) {
    return { error: 'You can only appeal your own posts.' };
  }

  // All appeal state read from post_stakes
  const stake = await db
    .prepare(`
      SELECT status, appeal_deadline, appeal_status
      FROM post_stakes WHERE post_id = ?
    `)
    .bind(postId)
    .first();

  if (!stake) return { error: 'Stake record not found' };

  if (stake.status !== 'appeal_pending') {
    return { error: 'This post is not in an appealable state.' };
  }

  if (stake.appeal_status !== 'open') {
    return { error: 'Appeal has already been submitted or closed.' };
  }

  if (new Date() > new Date(stake.appeal_deadline)) {
    return { error: 'Appeal window has closed.' };
  }

  const now = new Date().toISOString();

  // Write appeal_reason and appeal_status to post_stakes
  await db
    .prepare(`
      UPDATE post_stakes
      SET appeal_reason = ?, appeal_status = 'submitted', updated_at = ?
      WHERE post_id = ?
    `)
    .bind(appealReason.trim(), now, postId)
    .run();

  return {
    appealed:      true,
    post_id:       postId,
    appeal_status: 'submitted',
  };
}

/**
 * Admin resolves a submitted appeal.
 * decision: 'upheld'   → appeal succeeds, stake returned, status = 'returned'
 * decision: 'rejected' → appeal fails, slash finalised immediately
 */
export async function resolveAppeal(postId, decision, moderatorId, db) {
  if (!['upheld', 'rejected'].includes(decision)) {
    return { error: 'decision must be upheld or rejected' };
  }

  const post = await db
    .prepare(`SELECT id, user_id FROM posts WHERE id = ?`)
    .bind(postId)
    .first();

  if (!post) return { error: 'Post not found' };

  // All reads from post_stakes
  const stake = await db
    .prepare(`SELECT id, amount_usd, status, appeal_status FROM post_stakes WHERE post_id = ?`)
    .bind(postId)
    .first();

  if (!stake) return { error: 'Stake record not found' };

  if (stake.status !== 'appeal_pending') {
    return { error: 'Post is not in appeal_pending state' };
  }

  const now = new Date().toISOString();

  if (decision === 'upheld') {
    await _returnStakeToWallet(post.user_id, stake.amount_usd, postId, db, now);

    // All writes to post_stakes
    await db
      .prepare(`
        UPDATE post_stakes
        SET status = 'returned', appeal_status = 'upheld', updated_at = ?
        WHERE post_id = ?
      `)
      .bind(now, postId)
      .run();

  } else {
    await _finaliseSlash(postId, post.user_id, stake.amount_usd, db, now);

    // appeal_status update also in post_stakes
    await db
      .prepare(`
        UPDATE post_stakes
        SET appeal_status = 'rejected', updated_at = ?
        WHERE post_id = ?
      `)
      .bind(now, postId)
      .run();
  }

  await db
    .prepare(`
      INSERT INTO moderation_log
        (id, post_id, moderator_id, verdict, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .bind(crypto.randomUUID(), postId, moderatorId, `appeal_${decision}`, now)
    .run();

  return { resolved: true, post_id: postId, decision };
}

// ── CRON HELPER ──────────────────────────────────────────────

/**
 * Finalise any appeal_pending posts whose deadline has passed
 * and whose appeal_status is still 'open' (no appeal submitted).
 * Call this from your scheduled() cron.
 */
export async function finaliseExpiredAppeals(db) {
  const now = new Date().toISOString();

  // Query post_stakes — not posts table
  const { results } = await db
    .prepare(`
      SELECT ps.post_id, ps.user_id, ps.amount_usd
      FROM post_stakes ps
      WHERE ps.status = 'appeal_pending'
        AND ps.appeal_status = 'open'
        AND ps.appeal_deadline < ?
    `)
    .bind(now)
    .all();

  for (const row of results) {
    await _finaliseSlash(row.post_id, row.user_id, row.amount_usd, db, now);
  }

  return { finalised: results.length };
}

// ── INTERNAL HELPERS ─────────────────────────────────────────

/**
 * Return stake to user's wallet.
 */
async function _returnStakeToWallet(userId, stakeAmount, postId, db, now) {
  const wallet = await db
    .prepare(`SELECT id, balance_usd FROM wallets WHERE user_id = ?`)
    .bind(userId)
    .first();

  if (!wallet) return;

  const newBalance = wallet.balance_usd + stakeAmount;

  await db
    .prepare(`UPDATE wallets SET balance_usd = ?, updated_at = ? WHERE user_id = ?`)
    .bind(newBalance, now, userId)
    .run();

  await db
    .prepare(`
      INSERT INTO wallet_transactions
        (id, wallet_id, user_id, type, amount_usd,
         balance_after_usd, description, created_at)
      VALUES (?, ?, ?, 'stake_return', ?, ?, 'Stake returned — post verified', ?)
    `)
    .bind(crypto.randomUUID(), wallet.id, userId, stakeAmount, newBalance, now)
    .run();
}

/**
 * Finalise a stake slash.
 * 50% to platform revenue (wallet_transactions with user_id = 'platform').
 * 50% split equally among correct flaggers.
 * Does NOT touch treasury_ledger.
 */
async function _finaliseSlash(postId, userId, stakeAmount, db, now) {
  // Update post_stakes status to 'slashed'
  await db
    .prepare(`UPDATE post_stakes SET status = 'slashed', updated_at = ? WHERE post_id = ?`)
    .bind(now, postId)
    .run();

  // Split: 50% platform, 50% flaggers
  const platformShare = stakeAmount * 0.5;
  const flaggersPool  = stakeAmount * 0.5;

  // Record platform revenue as wallet_transaction — user_id = 'platform'
  await db
    .prepare(`
      INSERT INTO wallet_transactions
        (id, wallet_id, user_id, type, amount_usd,
         balance_after_usd, description, created_at)
      VALUES (?, NULL, 'platform', 'platform_revenue', ?, NULL, 'Platform revenue from slashed stake', ?)
    `)
    .bind(crypto.randomUUID(), platformShare, now)
    .run();

  // Get all flaggers for this post
  const { results: flaggers } = await db
    .prepare(`SELECT flagged_by FROM post_flags WHERE post_id = ?`)
    .bind(postId)
    .all();

  if (flaggers.length > 0) {
    const perFlagger = flaggersPool / flaggers.length;

    for (const flagger of flaggers) {
      const flaggerWallet = await db
        .prepare(`SELECT id, balance_usd FROM wallets WHERE user_id = ?`)
        .bind(flagger.flagged_by)
        .first();

      if (!flaggerWallet) continue;

      const newBal = flaggerWallet.balance_usd + perFlagger;

      await db
        .prepare(`UPDATE wallets SET balance_usd = ?, updated_at = ? WHERE user_id = ?`)
        .bind(newBal, now, flagger.flagged_by)
        .run();

      await db
        .prepare(`
          INSERT INTO wallet_transactions
            (id, wallet_id, user_id, type, amount_usd,
             balance_after_usd, description, created_at)
          VALUES (?, ?, ?, 'flagger_reward', ?, ?, 'Reward for correctly flagging a fake post', ?)
        `)
        .bind(
          crypto.randomUUID(), flaggerWallet.id, flagger.flagged_by,
          perFlagger, newBal, now
        )
        .run();
    }
  }
}

// ── LEDGER FEED ──────────────────────────────────────────────

/**
 * Get all posts — returns in exact shape frontend Ledger expects.
 * Joins post_stakes to get stake amount and status.
 */
export async function getLedgerPosts(limit, offset, db) {
  const { results } = await db
    .prepare(`
      SELECT
        p.id,
        p.user_id,
        p.content,
        p.tips_received_cents,
        p.created_at,
        ps.amount_usd           AS stake_amount_usd,
        ps.status               AS stake_status,
        u.username,
        u.league,
        u.avatar_url,
        p.comment_count,
        (SELECT COUNT(*) FROM post_cheers pc2 WHERE pc2.post_id = p.id) AS cheers,
        EXISTS (
          SELECT 1 FROM badges b WHERE b.user_id = p.user_id LIMIT 1
        ) AS verified
      FROM posts p
      JOIN users u       ON u.id  = p.user_id
      LEFT JOIN post_stakes ps ON ps.post_id = p.id
      WHERE (ps.status != 'slashed' OR ps.status IS NULL)
        AND p.deleted_at IS NULL
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `)
    .bind(limit ?? 20, offset ?? 0)
    .all();

  // Convert cents to USD for tips
  return results.map(row => ({
    ...row,
    tips_received: (row.tips_received_cents ?? 0) / 100,
    tips_received_cents: undefined,
  }));
}
