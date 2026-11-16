// ============================================================
// AURUM SECURITY AUDIT SERVICE
// Centralized append-only security event recording.
// Database immutability is enforced by migration 0034.
// ============================================================

const ACTOR_TYPES = new Set([
  'member',
  'platform_admin',
  'system',
  'anonymous',
]);

const OUTCOMES = new Set([
  'success',
  'denied',
  'failed',
]);

const SAFE_METADATA_KEYS = new Set([
  'reason_code',
  'method',
  'status_code',
  'category',
  'source',
  'count',
]);

function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }

  const safe = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (!SAFE_METADATA_KEYS.has(key)) continue;

    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      if (typeof value === 'string' && value.length > 120) continue;
      if (typeof value === 'number' && !Number.isFinite(value)) continue;

      safe[key] = value;
    }
  }

  return Object.keys(safe).length ? JSON.stringify(safe) : null;
}

/**
 * Record a security-sensitive event.
 *
 * @param {object} env Worker environment bindings.
 * @param {object} event Event details.
 * @param {string|null} event.actorId Actor's platform ID.
 * @param {string} event.actorType member | platform_admin | system | anonymous
 * @param {string} event.action Stable event identifier.
 * @param {string|null} event.resourceType Affected resource category.
 * @param {string|null} event.resourceId Affected resource identifier.
 * @param {string} event.outcome success | denied | failed
 * @param {Request|null} event.request Original request, when available.
 * @param {object|null} event.metadata Sanitized metadata.
 */
export async function recordSecurityEvent(env, {
  actorId = null,
  actorType = 'system',
  action,
  resourceType = null,
  resourceId = null,
  outcome,
  request = null,
  metadata = null,
}) {
  if (!env?.DB) {
    throw new Error('Security audit database binding is unavailable');
  }

  if (!ACTOR_TYPES.has(actorType)) {
    throw new Error('Invalid security audit actor type');
  }

  if (!OUTCOMES.has(outcome)) {
    throw new Error('Invalid security audit outcome');
  }

  if (
    typeof action !== 'string' ||
    !/^[a-z0-9_.-]{1,100}$/i.test(action)
  ) {
    throw new Error('Invalid security audit action');
  }

  const requestId = request
    ? (
        request.headers.get('X-Request-ID') ||
        request.headers.get('CF-Ray') ||
        null
      )
    : null;

  const safeMetadata = sanitizeMetadata(metadata);

  await env.DB.prepare(`
    INSERT INTO security_audit_log (
      actor_id,
      actor_type,
      action,
      resource_type,
      resource_id,
      outcome,
      request_id,
      metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    actorId,
    actorType,
    action,
    resourceType,
    resourceId,
    outcome,
    requestId,
    safeMetadata
  ).run();

  return { recorded: true };
}
