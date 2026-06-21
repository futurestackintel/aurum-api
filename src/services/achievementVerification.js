// achievementVerification.js
// Handles the full badge request lifecycle:
// - User submits a badge request with evidence
// - Admin reviews and approves or rejects
// - On approval: writes to badges table + fires notification
// - On rejection: updates badge_requests + fires notification with reason

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Submit a badge verification request.
 * Called by authenticated users from POST /badge-requests
 * @param {string} userId
 * @param {string} badgeType
 * @param {string} evidenceUrl - link to proof (LinkedIn, revenue screenshot, etc)
 * @param {string|null} notes  - optional context from user
 * @param {object} env
 */
export async function submitBadgeRequest(userId, badgeType, evidenceUrl, notes, env) {
  const allowedTypes = [
    'verified_builder',
    'verified_founder',
    'verified_millionaire',
    'sovereign',             // BUG-D-001: was 'sovereign_elite' — corrected to match canonical badge type
  ];

  if (!allowedTypes.includes(badgeType)) {
    throw new Error(`Invalid badge type: ${badgeType}`);
  }

  if (!evidenceUrl || !evidenceUrl.startsWith('http')) {
    throw new Error('A valid evidence URL is required');
  }

  // Block if user already has this badge
  const existing = await env.DB.prepare(`
    SELECT id FROM badges
    WHERE user_id = ?
      AND badge_type = ?
      AND revoked_at IS NULL
    LIMIT 1
  `).bind(userId, badgeType).first();

  if (existing) {
    throw new Error('You already hold this badge');
  }

  // Block if user has a pending request for same badge type
  const pendingRequest = await env.DB.prepare(`
    SELECT id FROM badge_requests
    WHERE user_id    = ?
      AND badge_type = ?
      AND status     = 'pending'
    LIMIT 1
  `).bind(userId, badgeType).first();

  if (pendingRequest) {
    throw new Error('You already have a pending request for this badge');
  }

  // Fix 2 — Block reapplication within 30 days of a rejection
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const recentRejection = await env.DB.prepare(`
    SELECT decided_at FROM badge_requests
    WHERE user_id    = ?
      AND badge_type = ?
      AND status     = 'rejected'
      AND decided_at >= ?
    ORDER BY decided_at DESC
    LIMIT 1
  `).bind(userId, badgeType, thirtyDaysAgo).first();

  if (recentRejection) {
    const rejectedAt   = new Date(recentRejection.decided_at);
    const reapplyAfter = new Date(rejectedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    const msRemaining  = reapplyAfter.getTime() - Date.now();
    const daysRemaining = Math.ceil(msRemaining / (24 * 60 * 60 * 1000));

    const error = new Error(
      `You may reapply for this badge in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}.`
    );
    error.status      = 429;
    error.daysRemaining = daysRemaining;
    throw error;
  }

  const id = crypto.randomUUID();

  await env.DB.prepare(`
    INSERT INTO badge_requests
      (id, user_id, badge_type, evidence_url, notes)
    VALUES (?, ?, ?, ?, ?)
  `).bind(id, userId, badgeType, evidenceUrl, notes ?? null).run();

  return { requestId: id };
}

/**
 * Get all pending badge requests for admin review queue.
 * Called from GET /admin/badge-requests
 * @param {object} env
 * @param {number} limit
 * @param {number} offset
 */
export async function getPendingBadgeRequests(env, limit = 50, offset = 0) {
  const results = await env.DB.prepare(`
    SELECT
      br.id,
      br.user_id,
      br.badge_type,
      br.evidence_url,
      br.notes,
      br.submitted_at,
      u.username,
      u.email,
      u.aurum_score,
      u.league
    FROM badge_requests br
    JOIN users u ON u.id = br.user_id
    WHERE br.status = 'pending'
    ORDER BY br.submitted_at ASC
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all();

  return results.results;
}

/**
 * Admin approves a badge request.
 * - Checks user's aurum_score meets badge score_threshold (Fix 1)
 * - Writes to badges table
 * - Updates badge_request status
 * - Fires badge_awarded notification to user
 * Called from POST /admin/badge-requests/:id/approve
 * @param {string} requestId
 * @param {string} adminId
 * @param {object} env
 */
export async function approveBadgeRequest(requestId, adminId, env) {
  // Fetch the request
  const req = await env.DB.prepare(`
    SELECT * FROM badge_requests
    WHERE id = ? AND status = 'pending'
  `).bind(requestId).first();

  if (!req) throw new Error('Badge request not found or already resolved');

  // Fix 1 — Enforce score threshold before writing badge
  const { BADGE_DEFINITIONS } = await import('./badge.js');
  const badgeDef = BADGE_DEFINITIONS.find(b => b.type === req.badge_type);

  if (badgeDef && badgeDef.score_threshold > 0) {
    const user = await env.DB.prepare(`
      SELECT aurum_score FROM users WHERE id = ?
    `).bind(req.user_id).first();

    if (!user) throw new Error('User not found');

    if (user.aurum_score < badgeDef.score_threshold) {
      throw new Error(
        `User's Aurum Score (${user.aurum_score}) does not meet the required threshold ` +
        `(${badgeDef.score_threshold}) for the ${badgeDef.label} badge.`
      );
    }
  }

  const now    = new Date().toISOString();
  const badgeId = crypto.randomUUID();

  // Write the badge
  await env.DB.prepare(`
    INSERT INTO badges
      (id, user_id, badge_type, awarded_by, evidence_url, verified_at, created_at)
    VALUES (?, ?, ?, 'verification', ?, ?, ?)
  `).bind(badgeId, req.user_id, req.badge_type, req.evidence_url, now, now).run();

  // Mark request approved
  await env.DB.prepare(`
    UPDATE badge_requests
    SET status     = 'approved',
        admin_id   = ?,
        decided_at = ?
    WHERE id = ?
  `).bind(adminId, now, requestId).run();

  // Fire notification to user
  await sendNotification(env, {
    userId:    req.user_id,
    type:      'badge_awarded',
    title:     'Badge Verified ✓',
    body:      `Your ${formatBadgeType(req.badge_type)} badge has been approved.`,
    actionUrl: '/profile',
    metadata:  JSON.stringify({ badge_type: req.badge_type, badge_id: badgeId }),
  });

  return { badgeId, userId: req.user_id, badgeType: req.badge_type };
}

/**
 * Admin rejects a badge request.
 * - Updates badge_request status to rejected
 * - Fires notification to user with reason
 * Called from POST /admin/badge-requests/:id/reject
 * @param {string} requestId
 * @param {string} adminId
 * @param {string} reason - must be provided
 * @param {object} env
 */
export async function rejectBadgeRequest(requestId, adminId, reason, env) {
  if (!reason || reason.trim().length < 10) {
    throw new Error('A rejection reason of at least 10 characters is required');
  }

  const req = await env.DB.prepare(`
    SELECT * FROM badge_requests
    WHERE id = ? AND status = 'pending'
  `).bind(requestId).first();

  if (!req) throw new Error('Badge request not found or already resolved');

  const now = new Date().toISOString();

  await env.DB.prepare(`
    UPDATE badge_requests
    SET status     = 'rejected',
        admin_id   = ?,
        reason     = ?,
        decided_at = ?
    WHERE id = ?
  `).bind(adminId, reason.trim(), now, requestId).run();

  // Fire notification to user with rejection reason
  await sendNotification(env, {
    userId:    req.user_id,
    type:      'badge_awarded',
    title:     'Badge Request Declined',
    body:      `Your ${formatBadgeType(req.badge_type)} request was not approved. Reason: ${reason.trim()}`,
    actionUrl: '/profile',
    metadata:  JSON.stringify({ badge_type: req.badge_type, reason: reason.trim() }),
  });

  return { success: true, userId: req.user_id };
}

/**
 * Get a single badge request by ID.
 * Useful for admin to inspect before ruling.
 * Called from GET /admin/badge-requests/:id
 */
export async function getBadgeRequest(requestId, env) {
  const result = await env.DB.prepare(`
    SELECT
      br.*,
      u.username,
      u.email,
      u.aurum_score,
      u.league,
      u.created_at as user_joined_at
    FROM badge_requests br
    JOIN users u ON u.id = br.user_id
    WHERE br.id = ?
  `).bind(requestId).first();

  if (!result) throw new Error('Badge request not found');
  return result;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function sendNotification(env, { userId, type, title, body, actionUrl, metadata }) {
  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO notifications
      (id, user_id, type, title, body, action_url, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(id, userId, type, title, body, actionUrl ?? null, metadata ?? null).run();
}

function formatBadgeType(badgeType) {
  const labels = {
    verified_builder:     'Verified Builder',
    verified_founder:     'Verified Founder',
    verified_millionaire: 'Verified Millionaire',
    sovereign:            'Sovereign',         // BUG-D-001: was 'sovereign_elite'
  };
  return labels[badgeType] ?? badgeType;
}
