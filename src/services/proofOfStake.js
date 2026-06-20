// ============================================================
// PROOF OF STAKE SYSTEM
// Post creation locks a stake into treasury.
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
 * Create a new Ledger post with stake locked in treasury.
 * Deducts stake from wallet balance before locking.
 * Returns post in the exact shape the frontend expects.
 */
export async function createPost(userId, body, db) {
  const { content, stake_amount, media_url } = body;

  // Validate content
  if (!content || content.trim().length === 0) {
    return { error: 'Post content is required' };
  }

  // Validate stake
  if (!stake_amount || stake_amount < 5) {
    return { error: 'Minimum stake is $5' };
  }

  // Fix 1 — Check wallet balance before locking stake
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
    .prepare(`
      UPDATE wallets
      SET balance_usd = ?, updated_at = ?
      WHERE user_id = ?
    `)
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
    .bind(
      crypto.randomUUID(), wallet.id, userId,
      stake_amount, newBalance, now
    )
    .run();

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
  // Fix 2 — Reason is required and must be valid
  if (!reason) {
    return { error: 'Flag reason is required.' };
  }
  if (!VALID_FLAG_REASONS.includes(reason)) {
    return {
      error: `Invalid reason. Must be one of: ${VALID_FLAG_REASONS.join(', ')}.`,
    };
  }

  // Check post exists
  const post = await db
    .prepare(`SELECT id, user_id, stake_status FROM posts WHERE id = ?`)
    .bind(postId)
    .first();

  if (!post) return { error: 'Post not found' };
  if (post.stake_status === 'slashed')  return { error: 'Post already resolved as fake' };
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
    .bind(crypto.randomUUID(), postId, flaggedByUserId, reason, now)
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
    flagged:   true,
    flag_count: flagCount,
    suspended: flagCount >= AUTO_SUSPEND_FLAG_COUNT,
  };
}

// ── MODERATION RESOLUTION ────────────────────────────────────

/**
 * Resolve a flagged post — admin only.
 * verdict: 'verified' → stake returned to user + score boost
 * verdict: 'fake'     → sets appeal_pending (NOT slashed yet)
 *                       Slash is finalised by cron after 48h deadline.
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

  if (['returned', 'slashed', 'appeal_pending'].includes(post.stake_status)) {
    return { error: 'Post has already been resolved' };
  }

  const now = new Date().toISOString();

  if (verdict === 'verified') {
    // Return stake to wallet
    await _returnStakeToWallet(post.user_id, post.stake_amount, postId, db, now);

    // Update post status
    await db
      .prepare(`UPDATE posts SET stake_status = 'returned' WHERE id = ?`)
      .bind(postId)
      .run();

    // Update treasury record
    await db
      .prepare(`
        UPDATE treasury_ledger
        SET status = 'returned', released_at = ?
        WHERE post_id = ? AND type = 'post_stake'
      `)
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
    // Fix 3 — Set appeal_pending, not slashed immediately
    const appealDeadline = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

    await db
      .prepare(`
        UPDATE posts
        SET stake_status = 'appeal_pending',
            appeal_deadline = ?,
            appeal_status = 'open'
        WHERE id = ?
      `)
      .bind(appealDeadline, postId)
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

  return {
    resolved:     true,
    post_id:      postId,
    verdict,
    stake_amount: post.stake_amount,
    stake_status: verdict === 'verified' ? 'returned' : 'appeal_pending',
    appeal_deadline: verdict === 'fake'
      ? new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
      : null,
  };
}

// ── APPEAL ───────────────────────────────────────────────────

/**
 * Fix 3 — User submits an appeal within the 48h window.
 * appeal_status moves from 'open' → 'submitted'.
 * Admin reviews via resolveAppeal().
 */
export async function appealPost(postId, userId, appealReason, db) {
  if (!appealReason || appealReason.trim().length === 0) {
    return { error: 'Appeal reason is required.' };
  }

  const post = await db
    .prepare(`
      SELECT id, user_id, stake_status, appeal_deadline, appeal_status
      FROM posts WHERE id = ?
    `)
    .bind(postId)
    .first();

  if (!post) return { error: 'Post not found' };

  if (post.user_id !== userId) {
    return { error: 'You can only appeal your own posts.' };
  }

  if (post.stake_status !== 'appeal_pending') {
    return { error: 'This post is not in an appealable state.' };
  }

  if (post.appeal_status !== 'open') {
    return { error: 'Appeal has already been submitted or closed.' };
  }

  // Check deadline
  if (new Date() > new Date(post.appeal_deadline)) {
    return { error: 'Appeal window has closed.' };
  }

  const now = new Date().toISOString();

  await db
    .prepare(`
      UPDATE posts
      SET appeal_reason = ?, appeal_status = 'submitted', updated_at = ?
      WHERE id = ?
    `)
    .bind(appealReason.trim(), now, postId)
    .run();

  return {
    appealed:   true,
    post_id:    postId,
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
    .prepare(`
      SELECT id, user_id, stake_amount, stake_status, appeal_status
      FROM posts WHERE id = ?
    `)
    .bind(postId)
    .first();

  if (!post) return { error: 'Post not found' };

  if (post.stake_status !== 'appeal_pending') {
    return { error: 'Post is not in appeal_pending state' };
  }

  const now = new Date().toISOString();

  if (decision === 'upheld') {
    // Return stake to user wallet
    await _returnStakeToWallet(post.user_id, post.stake_amount, postId, db, now);

    await db
      .prepare(`
        UPDATE posts
        SET stake_status = 'returned', appeal_status = 'upheld'
        WHERE id = ?
      `)
      .bind(postId)
      .run();

    await db
      .prepare(`
        UPDATE treasury_ledger
        SET status = 'returned', released_at = ?
        WHERE post_id = ? AND type = 'post_stake'
      `)
      .bind(now, postId)
      .run();

  } else {
    // Finalise slash
    await _finaliseSlash(postId, post.user_id, post.stake_amount, db, now);

    await db
      .prepare(`
        UPDATE posts
        SET appeal_status = 'rejected'
        WHERE id = ?
      `)
      .bind(postId)
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

// ── CRON HELPER — called by leaderboardCron or a dedicated cron ──

/**
 * Finalise any appeal_pending posts whose deadline has passed
 * and whose appeal_status is still 'open' (no appeal submitted).
 * Call this from your scheduled() cron.
 */
export async function finaliseExpiredAppeals(db) {
  const now = new Date().toISOString();

  const { results } = await db
    .prepare(`
      SELECT id, user_id, stake_amount
      FROM posts
      WHERE stake_status = 'appeal_pending'
        AND appeal_status = 'open'
        AND appeal_deadline < ?
    `)
    .bind(now)
    .all();

  for (const post of results) {
    await _finaliseSlash(post.id, post.user_id, post.stake_amount, db, now);
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
    .prepare(`
      UPDATE wallets SET balance_usd = ?, updated_at = ? WHERE user_id = ?
    `)
    .bind(newBalance, now, userId)
    .run();

  await db
    .prepare(`
      INSERT INTO wallet_transactions
        (id, wallet_id, user_id, type, amount_usd,
         balance_after_usd, description, created_at)
      VALUES (?, ?, ?, 'stake_return', ?, ?, 'Stake returned — post verified', ?)
    `)
    .bind(
      crypto.randomUUID(), wallet.id, userId,
      stakeAmount, newBalance, now
    )
    .run();
}

/**
 * Fix 4 — Finalise a stake slash.
 * 50% to platform revenue ledger.
 * 50% split equally among correct flaggers.
 */
async function _finaliseSlash(postId, userId, stakeAmount, db, now) {
  // Update post and treasury
  await db
    .prepare(`UPDATE posts SET stake_status = 'slashed' WHERE id = ?`)
    .bind(postId)
    .run();

  await db
    .prepare(`
      UPDATE treasury_ledger
      SET status = 'slashed', released_at = ?
      WHERE post_id = ? AND type = 'post_stake'
    `)
    .bind(now, postId)
    .run();

  // Split: 50% platform, 50% flaggers
  const platformShare = stakeAmount * 0.5;
  const flaggersPool  = stakeAmount * 0.5;

  // Record platform revenue
  await db
    .prepare(`
      INSERT INTO treasury_ledger
        (id, post_id, user_id, amount, type, status, created_at)
      VALUES (?, ?, NULL, ?, 'platform_revenue', 'settled', ?)
    `)
    .bind(crypto.randomUUID(), postId, platformShare, now)
    .run();

  // Get all correct flaggers for this post
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
        .prepare(`
          UPDATE wallets SET balance_usd = ?, updated_at = ? WHERE user_id = ?
        `)
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
