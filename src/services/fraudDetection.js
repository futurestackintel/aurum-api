// fraudDetection.js
// Automated fraud pattern detection for AURUM.
// Called by route handlers after sensitive actions (tips, stakes, new accounts).
// Writes community-reported flags to moderation_flags.
// Automated detections write to audit log via console.error (picked up by Cloudflare Logpush).

// ── Constants ─────────────────────────────────────────────────────────────────

const THRESHOLDS = {
  TIP_VELOCITY_WINDOW_MINUTES: 60,
  TIP_VELOCITY_MAX:            10,   // max tips sent in window before flagging
  STAKE_VELOCITY_WINDOW_HOURS: 24,
  STAKE_VELOCITY_MAX:          5,    // max stake posts in window before flagging
  MULTI_ACCOUNT_IP_WINDOW_DAYS: 7,
  MULTI_ACCOUNT_IP_MAX:        3,    // max accounts from same IP in window
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check tip velocity for a user.
 * Call this after every tip is sent.
 * @param {string} userId - sender's user ID
 * @param {object} env - Worker env bindings
 */
export async function checkTipVelocity(userId, env) {
  const windowStart = minutesAgo(THRESHOLDS.TIP_VELOCITY_WINDOW_MINUTES);

  const result = await env.DB.prepare(`
    SELECT COUNT(*) as count
    FROM tips
    WHERE sender_id = ?
      AND created_at >= ?
  `).bind(userId, windowStart).first();

  if (result.count >= THRESHOLDS.TIP_VELOCITY_MAX) {
    await logFraudEvent(env, {
      type:    'tip_velocity',
      userId,
      detail:  `${result.count} tips sent in last ${THRESHOLDS.TIP_VELOCITY_WINDOW_MINUTES} minutes`,
      severity: result.count >= THRESHOLDS.TIP_VELOCITY_MAX * 2 ? 'high' : 'medium',
    });
  }
}

/**
 * Check stake post velocity for a user.
 * Call this after every stake post is created.
 * @param {string} userId - poster's user ID
 * @param {object} env - Worker env bindings
 */
export async function checkStakeVelocity(userId, env) {
  const windowStart = hoursAgo(THRESHOLDS.STAKE_VELOCITY_WINDOW_HOURS);

  const result = await env.DB.prepare(`
    SELECT COUNT(*) as count
    FROM posts
    WHERE user_id = ?
      AND stake_amount > 0
      AND created_at >= ?
  `).bind(userId, windowStart).first();

  if (result.count >= THRESHOLDS.STAKE_VELOCITY_MAX) {
    await logFraudEvent(env, {
      type:    'stake_velocity',
      userId,
      detail:  `${result.count} stake posts in last ${THRESHOLDS.STAKE_VELOCITY_WINDOW_HOURS} hours`,
      severity: 'medium',
    });
  }
}

/**
 * Check for multiple accounts from the same IP.
 * Call this on every new user registration.
 * @param {string} userId - newly registered user ID
 * @param {string} ipAddress - request IP
 * @param {object} env - Worker env bindings
 */
export async function checkMultiAccount(userId, ipAddress, env) {
  if (!ipAddress) return;

  const windowStart = daysAgo(THRESHOLDS.MULTI_ACCOUNT_IP_WINDOW_DAYS);

  // Store registration IP in KV: key = ip:{ipAddress}, value = JSON array of {userId, timestamp}
  const kvKey = `ip:${ipAddress}`;
  const existing = await env.KV.get(kvKey, 'json') ?? [];

  // Add this registration
  existing.push({ userId, timestamp: new Date().toISOString() });

  // Filter to window only
  const cutoff = new Date(windowStart).getTime();
  const inWindow = existing.filter(e => new Date(e.timestamp).getTime() >= cutoff);

  // Write back with 7-day TTL
  await env.KV.put(kvKey, JSON.stringify(inWindow), {
    expirationTtl: THRESHOLDS.MULTI_ACCOUNT_IP_WINDOW_DAYS * 24 * 60 * 60
  });

  if (inWindow.length >= THRESHOLDS.MULTI_ACCOUNT_IP_MAX) {
    await logFraudEvent(env, {
      type:    'multi_account',
      userId,
      detail:  `${inWindow.length} accounts registered from IP ${ipAddress} in ${THRESHOLDS.MULTI_ACCOUNT_IP_WINDOW_DAYS} days`,
      severity: 'high',
    });
  }
}

/**
 * Submit a user-reported flag to moderation_flags.
 * Call this from the POST /report route.
 * @param {object} params
 * @param {string} params.reporterId  - Clerk user ID of the reporter
 * @param {string} params.targetType  - 'post' | 'comment' | 'user' | 'challenge' | 'room_post'
 * @param {string} params.targetId    - ID of the flagged entity
 * @param {string} params.reason      - must match CHECK constraint values
 * @param {string} [params.notes]     - optional extra detail
 * @param {object} env
 */
export async function submitUserFlag(
  { reporterId, targetType, targetId, reason, notes },
  env
) {
  // Validate reason against allowed values
  const allowedReasons = [
    'fake_achievement', 'harassment', 'spam',
    'inappropriate_content', 'fraud', 'impersonation', 'other'
  ];
  if (!allowedReasons.includes(reason)) {
    throw new Error(`Invalid reason: ${reason}`);
  }

  const allowedTargets = ['post', 'comment', 'user', 'challenge', 'room_post'];
  if (!allowedTargets.includes(targetType)) {
    throw new Error(`Invalid target_type: ${targetType}`);
  }

  // Check for duplicate flag from same reporter on same target
  const existing = await env.DB.prepare(`
    SELECT id FROM moderation_flags
    WHERE reporter_id = ?
      AND target_id   = ?
      AND status      = 'pending'
    LIMIT 1
  `).bind(reporterId, targetId).first();

  if (existing) {
    throw new Error('You have already flagged this item');
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO moderation_flags
      (id, reporter_id, target_type, target_id, reason, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(id, reporterId, targetType, targetId, reason, notes ?? null).run();

  return { flagId: id };
}

/**
 * Get all pending flags sorted by severity for the moderation queue.
 * Used by the admin moderation queue endpoint.
 * @param {object} env
 * @param {number} limit
 * @param {number} offset
 */
export async function getPendingFlags(env, limit = 50, offset = 0) {
  const flags = await env.DB.prepare(`
    SELECT
      mf.id,
      mf.reporter_id,
      mf.target_type,
      mf.target_id,
      mf.reason,
      mf.notes,
      mf.created_at,
      u.username as reporter_username
    FROM moderation_flags mf
    LEFT JOIN users u ON u.id = mf.reporter_id
    WHERE mf.status = 'pending'
    ORDER BY
      CASE mf.reason
        WHEN 'fraud'           THEN 1
        WHEN 'fake_achievement' THEN 2
        WHEN 'impersonation'   THEN 3
        WHEN 'harassment'      THEN 4
        WHEN 'inappropriate_content' THEN 5
        WHEN 'spam'            THEN 6
        ELSE 7
      END ASC,
      mf.created_at ASC
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all();

  return flags.results;
}

/**
 * Resolve a flag — mark as actioned or dismissed.
 * @param {string} flagId
 * @param {string} adminId
 * @param {'actioned'|'dismissed'} decision
 * @param {string} actionTaken - description of what was done
 * @param {object} env
 */
export async function resolveFlag(flagId, adminId, decision, actionTaken, env) {
  if (!['actioned', 'dismissed'].includes(decision)) {
    throw new Error('Decision must be actioned or dismissed');
  }

  const now = new Date().toISOString();

  const result = await env.DB.prepare(`
    UPDATE moderation_flags
    SET
      status       = ?,
      reviewed_by  = ?,
      reviewed_at  = ?,
      action_taken = ?
    WHERE id = ?
      AND status = 'pending'
  `).bind(decision, adminId, now, actionTaken ?? null, flagId).run();

  if (result.meta.changes === 0) {
    throw new Error('Flag not found or already resolved');
  }

  return { success: true };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Log a fraud detection event.
 * Writes to Cloudflare's log stream (visible in dashboard).
 * Does NOT write to moderation_flags because reporter_id would be null
 * and the FK constraint requires a real user.
 */
async function logFraudEvent(env, { type, userId, detail, severity }) {
  // Log to Cloudflare Workers log stream
  console.error(JSON.stringify({
    aurum_fraud_event: true,
    type,
    userId,
    detail,
    severity,
    timestamp: new Date().toISOString(),
  }));

  // Also store in KV for admin dashboard to surface
  const kvKey = `fraud:${type}:${userId}:${Date.now()}`;
  await env.KV.put(kvKey, JSON.stringify({
    type, userId, detail, severity,
    timestamp: new Date().toISOString(),
  }), {
    expirationTtl: 30 * 24 * 60 * 60 // 30 days
  });
}

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}