// ============================================================
// DROP CIRCLE (ARENA) — FULL LIFECYCLE
// CRITICAL FIX: challenge_entries columns corrected to match the
// REAL production schema (confirmed via PRAGMA table_info and a
// full sqlite_master dump). The code previously wrote to columns
// that never existed:
//   entry_amount     -> real column is entry_fee_paid_cents (INTEGER, cents)
//   achievement_proof -> real columns are achievement_proof_urls (TEXT)
//                        and proof_description (TEXT), separately
//   joined_at        -> real column is created_at
// This was silently breaking joinChallenge, submitProof,
// getChallengeById's entry list, and resolveChallenge's entry query.
// Fixed below.
// ============================================================

import { addScoreEvent } from './aurumScore.js';
import {
  toMinorUnits,
  fromMinorUnits,
  validateCurrencyCode,
  validateMinorUnitExponent,
} from './money.js';
import { ChallengeFinancialService } from './challengeFinancials.js';
import { publishNotification } from './notificationPublisher.js';

const PLATFORM_FEE_PERCENT = 5;

// ── HELPERS ──────────────────────────────────────────────────

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

// ── STAGE 1: CREATE CHALLENGE (already correct — challenges
//    table schema matches what's coded here) ──────────────────
export async function createChallenge(clerkId, body, db) {
  const {
    title,
    type,
    entry_fee,
    currency_code = 'USD',
    ends_at,
    starts_at,
    description,
    max_entries,
    verification_method,
  } = body;

  if (
    typeof title !== 'string' ||
    title.trim().length === 0
  ) {
    return { error: 'Title is required' };
  }

  if (typeof entry_fee !== 'string') {
    return {
      error: 'Entry fee must be provided as a decimal string',
    };
  }

  if (!ends_at) {
    return { error: 'End date is required' };
  }

  if (!type) {
    return { error: 'Challenge type is required' };
  }

  const validTypes = [
    'revenue',
    'deals_closed',
    'growth',
    'savings',
    'custom',
    'charity_brawl',
  ];

  if (!validTypes.includes(type)) {
    return {
      error: `type must be one of: ${validTypes.join(', ')}`,
    };
  }

  const validVerification = [
    'proof_upload',
    'honor_system',
    'admin_verified',
  ];

  const verificationMethod =
    verification_method ?? 'proof_upload';

  if (!validVerification.includes(verificationMethod)) {
    return {
      error: `verification_method must be one of: ${validVerification.join(', ')}`,
    };
  }

  let currencyCode;
  let entryFeeMinor;

  try {
    currencyCode = validateCurrencyCode(currency_code);

    const currency = await db.prepare(`
      SELECT minor_unit_exponent
      FROM financial_currencies
      WHERE currency_code = ?
    `).bind(currencyCode).first();

    if (!currency) {
      return { error: 'Challenge currency is not registered' };
    }

    const exponent = validateMinorUnitExponent(
      currency.minor_unit_exponent
    );

    entryFeeMinor = toMinorUnits(entry_fee, exponent);
  } catch (error) {
    return { error: error.message };
  }

  // Paid entries require both the currency and Challenge rule
  // to be independently enabled.
  if (entryFeeMinor > 0) {
    const currency = await db.prepare(`
      SELECT is_enabled
      FROM financial_currencies
      WHERE currency_code = ?
    `).bind(currencyCode).first();

    if (!currency || currency.is_enabled !== 1) {
      return { error: 'Challenge currency is not enabled for payments' };
    }

    const rule = await db.prepare(`
      SELECT minimum_entry_minor
      FROM challenge_currency_rules
      WHERE currency_code = ?
        AND is_enabled = 1
    `).bind(currencyCode).first();

    if (!rule) {
      return { error: 'Paid Challenges are not enabled for this currency' };
    }

    if (entryFeeMinor < rule.minimum_entry_minor) {
      return {
        error: 'Entry fee is below the minimum for this currency',
        minimum_entry_minor: rule.minimum_entry_minor,
        currency_code: currencyCode,
      };
    }
  }

  const endsAtDate = new Date(ends_at);

  if (Number.isNaN(endsAtDate.getTime())) {
    return { error: 'Invalid end date' };
  }

  if (endsAtDate <= new Date()) {
    return { error: 'ends_at must be in the future' };
  }

  const startsAtDate = starts_at
    ? new Date(starts_at)
    : new Date();

  if (Number.isNaN(startsAtDate.getTime())) {
    return { error: 'Invalid start date' };
  }

  if (startsAtDate >= endsAtDate) {
    return { error: 'Challenge start must be before its end' };
  }

  if (
    max_entries !== undefined &&
    max_entries !== null &&
    (!Number.isInteger(max_entries) || max_entries < 1)
  ) {
    return { error: 'Maximum entries must be a positive integer' };
  }

  const now = nowISO();
  const challengeId = crypto.randomUUID();

  const internalUserId = await resolveUserId(clerkId, db);

  if (!internalUserId) {
    return { error: 'User not found' };
  }

  // Keep the old cents column meaningful only for USD.
  // New financial logic uses entry_fee_minor and currency_code.
  const legacyEntryFeeCents =
    currencyCode === 'USD' ? entryFeeMinor : 0;

  await db.prepare(`
    INSERT INTO challenges (
      id,
      creator_id,
      title,
      description,
      challenge_type,
      verification_method,
      entry_fee_cents,
      pool_total_cents,
      max_participants,
      participant_count,
      status,
      starts_at,
      ends_at,
      moderation_status,
      currency_code,
      entry_fee_minor,
      pool_funded_minor,
      financial_status,
      created_at,
      updated_at
    )
        VALUES (
      ?, ?, ?, ?, ?, ?, ?, 0, ?, 0,
      'draft', ?, ?, 'pending',
      ?, ?, 0, 'pending', ?, ?
    )
  `).bind(
    challengeId,
    internalUserId,
    title.trim(),
    description ?? '',
    type,
    verificationMethod,
    legacyEntryFeeCents,
    max_entries ?? null,
    startsAtDate.toISOString(),
    endsAtDate.toISOString(),
    currencyCode,
    entryFeeMinor,
    now,
    now,
  ).run();

  // Retain the legacy treasury record for compatibility.
  // The immutable financial ledger is authoritative.
  await db.prepare(`
    INSERT INTO treasury_ledger (
      id,
      challenge_id,
      total_held_cents,
      platform_fee_cents,
      winner_payout_cents,
      status,
      created_at,
      updated_at
    )
    VALUES (?, ?, 0, 0, 0, 'holding', ?, ?)
  `).bind(
    crypto.randomUUID(),
    challengeId,
    now,
    now,
  ).run();

  const currency = await db.prepare(`
    SELECT minor_unit_exponent
    FROM financial_currencies
    WHERE currency_code = ?
  `).bind(currencyCode).first();

  return {
    challenge: {
      id: challengeId,
      title: title.trim(),
      type,
      status: 'draft',
      moderation_status: 'pending',
      publication_status: 'awaiting_review',
      financial_status: 'pending',
      currency_code: currencyCode,
      entry_fee_minor: entryFeeMinor,
      entry_fee: fromMinorUnits(
        entryFeeMinor,
        currency.minor_unit_exponent
      ),
      entries: 0,
      starts_at: startsAtDate.toISOString(),
      ends_at: endsAtDate.toISOString(),
    },
  };
}


const EDITABLE_CHALLENGE_TYPES = [
  'revenue',
  'deals_closed',
  'growth',
  'savings',
  'custom',
  'charity_brawl',
];

const EDITABLE_VERIFICATION_METHODS = [
  'proof_upload',
  'honor_system',
  'admin_verified',
];

export async function updateChallenge(challengeId, clerkId, body, db) {
  const userId = await resolveUserId(clerkId, db);
  if (!userId) return { error: 'User not found' };

  const challenge = await db.prepare(`
    SELECT *
    FROM challenges
    WHERE id = ?
      AND creator_id = ?
      AND deleted_at IS NULL
  `).bind(challengeId, userId).first();

  if (!challenge) return { error: 'Challenge not found' };

  if (!['draft', 'open'].includes(challenge.status)) {
    return { error: 'This challenge can no longer be edited' };
  }

    if (
    challenge.status === 'open' &&
    challenge.starts_at &&
    new Date(challenge.starts_at) <= new Date()
  ) {
    return { error: 'Only challenges that have not started can be edited' };
  }

  const entries = await db.prepare(`
    SELECT COUNT(*) AS total
    FROM challenge_entries
    WHERE challenge_id = ?
  `).bind(challengeId).first();

  if (entries?.total > 0 || challenge.pool_funded_minor > 0) {
    return { error: 'A challenge with participants or funded money cannot be edited' };
  }

  const title = body.title === undefined
    ? challenge.title
    : body.title;

  const description = body.description === undefined
    ? challenge.description
    : body.description;

  const rules = body.rules === undefined
    ? challenge.rules
    : body.rules;

  const type = body.type === undefined
    ? challenge.challenge_type
    : body.type;

  const verificationMethod = body.verification_method === undefined
    ? challenge.verification_method
    : body.verification_method;

  const startsAt = body.starts_at === undefined
    ? challenge.starts_at
    : body.starts_at;

  const endsAt = body.ends_at === undefined
    ? challenge.ends_at
    : body.ends_at;

  const maxEntries = body.max_entries === undefined
    ? challenge.max_participants
    : body.max_entries;

  if (typeof title !== 'string' || !title.trim()) {
    return { error: 'Title is required' };
  }

  if (!EDITABLE_CHALLENGE_TYPES.includes(type)) {
    return { error: 'Invalid challenge type' };
  }

  if (!EDITABLE_VERIFICATION_METHODS.includes(verificationMethod)) {
    return { error: 'Invalid verification method' };
  }

  if (
    maxEntries !== null &&
    (!Number.isInteger(maxEntries) || maxEntries < 1)
  ) {
    return { error: 'Maximum entries must be a positive integer' };
  }

  const startDate = new Date(startsAt);
  const endDate = new Date(endsAt);

  if (
    Number.isNaN(startDate.getTime()) ||
    Number.isNaN(endDate.getTime()) ||
    startDate <= new Date() ||
    endDate <= startDate
  ) {
    return { error: 'Please provide valid future challenge dates' };
  }

  const result = await db.prepare(`
    UPDATE challenges
    SET title = ?,
        description = ?,
        rules = ?,
        challenge_type = ?,
        verification_method = ?,
        starts_at = ?,
        ends_at = ?,
        max_participants = ?,
        status = 'draft',
        moderation_status = 'pending',
        updated_at = ?
    WHERE id = ?
      AND creator_id = ?
      AND status IN ('draft', 'open')
      AND moderation_status IN ('pending', 'approved', 'rejected')
      AND deleted_at IS NULL
      AND (status = 'draft' OR starts_at > ?)
      AND pool_funded_minor = 0
      AND NOT EXISTS (
        SELECT 1 FROM challenge_entries
        WHERE challenge_id = challenges.id
      )
	AND NOT EXISTS (
        SELECT 1 FROM challenge_financial_operations
        WHERE challenge_id = challenges.id
      )
  `).bind(
    title.trim(),
    description ?? '',
    rules ?? null,
    type,
    verificationMethod,
    startDate.toISOString(),
    endDate.toISOString(),
    maxEntries,
    nowISO(),
    challengeId,
    userId,
    nowISO()
  ).run();

  if (result.meta?.changes !== 1) {
    return { error: 'Challenge changed or is no longer eligible for editing' };
  }

  return {
    updated: true,
    challenge_id: challengeId,
    status: 'draft',
    moderation_status: 'pending',
    publication_status: 'awaiting_review',
  };
}

export async function cancelChallenge(challengeId, clerkId, db) {
  const userId = await resolveUserId(clerkId, db);
  if (!userId) return { error: 'User not found' };

  const result = await db.prepare(`
    UPDATE challenges
    SET status = 'cancelled',
        updated_at = ?
    WHERE id = ?
      AND creator_id = ?
      AND status IN ('draft', 'open')
      AND deleted_at IS NULL
      AND (status = 'draft' OR starts_at > ?)
      AND pool_funded_minor = 0
      AND financial_status IN ('pending', 'legacy')
      AND NOT EXISTS (
        SELECT 1 FROM challenge_entries
        WHERE challenge_id = challenges.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM challenge_financial_operations
        WHERE challenge_id = challenges.id
          AND status IN ('pending', 'posted')
      )
  `).bind(
    nowISO(),
    challengeId,
    userId,
    nowISO()
  ).run();

  if (result.meta?.changes !== 1) {
    return {
      error: 'This challenge cannot be cancelled because it has started, has participants, or has financial activity',
    };
  }

  return {
    cancelled: true,
    challenge_id: challengeId,
    status: 'cancelled',
  };
}


// ── ARENA: ADMIN CHALLENGE MODERATION ────────────────────────

export async function reviewChallenge(
  challengeId,
  moderatorClerkId,
  decision,
  db
) {
  if (!['approve', 'reject'].includes(decision)) {
    return { error: 'Decision must be approve or reject' };
  }

  const moderatorId = await resolveUserId(moderatorClerkId, db);

  if (!moderatorId) {
    return { error: 'Moderator account not found' };
  }

  const challenge = await db.prepare(`
    SELECT id, status, moderation_status, starts_at, ends_at
    FROM challenges
    WHERE id = ?
      AND deleted_at IS NULL
  `).bind(challengeId).first();

  if (!challenge) {
    return { error: 'Challenge not found' };
  }

  if (challenge.moderation_status !== 'pending') {
    return { error: 'This challenge has already been reviewed' };
  }

  if (decision === 'approve') {
    const now = new Date();

    if (new Date(challenge.ends_at) <= now) {
      return { error: 'Cannot approve a challenge that has already ended' };
    }

const updateResult = await db.prepare(`
      UPDATE challenges
      SET status = 'open',
          moderation_status = 'approved',
          updated_at = ?
      WHERE id = ?
        AND moderation_status = 'pending'
        AND deleted_at IS NULL
    `).bind(nowISO(), challengeId).run();

    if (updateResult.meta?.changes !== 1) {
      return {
        error: 'This challenge has already been reviewed',
      };
    }

    return {
      reviewed: true,
      decision: 'approved',
      challenge_id: challengeId,
      status: 'open',
    };
  }

    const updateResult = await db.prepare(`
    UPDATE challenges
    SET status = 'draft',
        moderation_status = 'rejected',
        updated_at = ?
    WHERE id = ?
      AND moderation_status = 'pending'
      AND deleted_at IS NULL
  `).bind(nowISO(), challengeId).run();

  if (updateResult.meta?.changes !== 1) {
    return {
      error: 'This challenge has already been reviewed',
    };
  }

  return {
    reviewed: true,
    decision: 'rejected',
    challenge_id: challengeId,
    status: 'draft',
  };
}

// ── STAGE 2: JOIN AND FUND POOL ──────────────────────────────
// FIX: insert now uses entry_fee_paid_cents (real column) instead
// of entry_amount. status/created_at/updated_at rely on the
// table's own defaults ('entered', now(), now()).

export async function joinChallenge(
  challengeId,
  clerkId,
  db,
  options = {}
) {
  const userId = await resolveUserId(clerkId, db);

  if (!userId) {
    return { error: 'User not found' };
  }

  const challenge = await db.prepare(`
    SELECT *
    FROM challenges
    WHERE id = ?
  `).bind(challengeId).first();

  if (!challenge) {
    return { error: 'Challenge not found' };
  }


// All entry types must pass the same eligibility checks.
  if (
    challenge.moderation_status !== 'approved' ||
    challenge.deleted_at !== null
  ) {
    return { error: 'Challenge is not available for entry' };
  }

  if (challenge.status !== 'open') {
    return { error: 'Challenge is not open for entries' };
  }

  const currentTime = new Date();
  const startsAt = challenge.starts_at
    ? new Date(challenge.starts_at)
    : null;

  if (startsAt && startsAt > currentTime) {
    return { error: 'Challenge has not started yet' };
  }

  if (
    !challenge.ends_at ||
    new Date(challenge.ends_at) <= currentTime
  ) {
    return { error: 'Challenge has expired' };
  }

  if (
    challenge.max_participants !== null &&
    challenge.participant_count >= challenge.max_participants
  ) {
    return { error: 'Challenge is full' };
  }

  if (challenge.financial_status === 'legacy') {
    return {
      error: 'This legacy Challenge is unavailable for new financial entries',
    };
  }

  if (
    !['pending', 'funding', 'funded'].includes(
      challenge.financial_status
    )
  ) {
    return { error: 'Challenge is not accepting entries' };
  }

  const existingEntry = await db.prepare(`
    SELECT id
    FROM challenge_entries
    WHERE challenge_id = ?
      AND user_id = ?
  `).bind(challengeId, userId).first();

  if (existingEntry) {
    return {
      error: 'You have already joined this Challenge',
      entry_id: existingEntry.id,
    };
  }
  

  if (userId === challenge.creator_id) {
    return {
      error: 'Challenge creators cannot enter their own challenge',
    };
  }

  
  

  const entryFeeMinor = challenge.entry_fee_minor ?? 0;

  if (!Number.isSafeInteger(entryFeeMinor) || entryFeeMinor < 0) {
    return { error: 'Challenge entry amount is invalid' };
  }

  // Paid entry: all wallet movement goes through the ledger.
  if (entryFeeMinor > 0) {
    const idempotencyKey = options.idempotencyKey;

    if (
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.trim() === '' ||
      idempotencyKey.length > 128
    ) {
      return {
        error: 'A valid idempotency key is required for paid entry',
      };
    }

    const financial = new ChallengeFinancialService(db);

    try {
            const result = await financial.fundEntry({
        challengeId,
        userId,
        idempotencyKey: idempotencyKey.trim(),
      });

            if (!result.already_funded) {
        try {
          await publishNotification(db, {
          recipientUserId: challenge.creator_id,
          type: 'challenge_joined',
          title: 'New Challenge Participant',
          body: `A member has joined your challenge: ${challenge.title}.`,
          actionUrl: `/arena?challenge=${challengeId}`,
          preference: 'challenge_updates',
          actorType: 'member',
          actorId: userId,
          resourceType: 'challenge',
          resourceId: challengeId,
        });
      } catch (error) {
          console.error('[challenge-joined-notification]', error);
        }
      }
      return {
        joined: true,
        ...result,
      };
    } catch (error) {
      console.error('Challenge entry funding error:', error);

      return {
        error: error.message.includes('reconciliation')
          ? 'Challenge entry requires financial reconciliation'
          : error.message,
      };
    }
  }

const existing = await db.prepare(`
    SELECT id
    FROM challenge_entries
    WHERE challenge_id = ?
      AND user_id = ?
  `).bind(challengeId, userId).first();

  if (existing) {
    return {
      error: 'You have already joined this Challenge',
      entry_id: existing.id,
    };
	}
	if (challenge.status !== 'open') {
    return { error: 'Challenge is not open for entries' };
  }

	if (new Date(challenge.ends_at) <= new Date()) {
    return { error: 'Challenge has expired' };
	}

	if (
    challenge.max_participants !== null &&
    challenge.participant_count >= challenge.max_participants
  ) {
    return { error: 'Challenge is full' };
  }

	if (challenge.financial_status === 'legacy') {
    return {
      error: 'This legacy Challenge is unavailable for new financial entries',
    };
  }

  if (
    !['pending', 'funding', 'funded'].includes(
      challenge.financial_status
    )
  ) {
    return {
      error: 'Challenge is not accepting entries',
    };
  }
  // Free entry: no wallet movement and no ledger transaction.
  // Entry creation and participant count update are atomic.
  const now = nowISO();
  const entryId = crypto.randomUUID();

  try {
    await db.batch([
      db.prepare(`
        INSERT INTO challenge_entries (
          id,
          challenge_id,
          user_id,
          entry_fee_paid_cents,
          entry_fee_paid_minor
        )
        SELECT
          ?,
          c.id,
          ?,
          0,
          0
        FROM challenges c
         WHERE c.id = ?
          AND c.status = 'open'
          AND c.moderation_status = 'approved'
          AND c.deleted_at IS NULL
          AND c.financial_status IN (
            'pending',
            'funding',
            'funded'
          )
          AND c.entry_fee_minor = 0
          AND c.ends_at > ?
          AND (
            c.max_participants IS NULL
            OR c.participant_count < c.max_participants
          )
          AND NOT EXISTS (
            SELECT 1
            FROM challenge_entries ce
            WHERE ce.challenge_id = c.id
              AND ce.user_id = ?
          )
      `).bind(
        entryId,
        userId,
        challengeId,
        now,
        userId
      ),

      db.prepare(`
        UPDATE challenges
        SET
          participant_count = participant_count + 1,
          updated_at = ?
        WHERE id = ?
          AND status = 'open'
          AND financial_status IN (
            'pending',
            'funding',
            'funded'
          )
          AND entry_fee_minor = 0
          AND ends_at > ?
          AND (
            max_participants IS NULL
            OR participant_count < max_participants
          )
		  AND EXISTS (
          SELECT 1
          FROM challenge_entries ce
          WHERE ce.id = ?
          AND ce.challenge_id = challenges.id
          AND ce.user_id = ?
         )
       `).bind(
        now,
        challengeId,
        now,
        entryId,
        userId
      ),
    ]);

    const confirmedEntry = await db.prepare(`
      SELECT id
      FROM challenge_entries
      WHERE challenge_id = ?
        AND user_id = ?
    `).bind(challengeId, userId).first();

    if (!confirmedEntry || confirmedEntry.id !== entryId) {
  return {
    error: confirmedEntry
      ? 'You have already joined this Challenge'
      : 'Unable to confirm Challenge entry',
    entry_id: confirmedEntry?.id,
  };
	}

        try {
      await publishNotification(db, {
        recipientUserId: challenge.creator_id,
        type: 'challenge_joined',
        title: 'New Challenge Participant',
        body: `A member has joined your challenge: ${challenge.title}.`,
        actionUrl: `/arena?challenge=${challengeId}`,
        preference: 'challenge_updates',
        actorType: 'member',
        actorId: userId,
        resourceType: 'challenge',
        resourceId: challengeId,
      });
    } catch (error) {
      console.error('[challenge-joined-notification]', error);
    }

    return {
      joined: true,
      entry_id: confirmedEntry.id,
      challenge_id: challengeId,
      entry_fee_minor: 0,
      currency_code: challenge.currency_code,
    };
  } catch (error) {
    console.error('Free Challenge entry error:', error);

    return {
      error: 'Unable to join this free Challenge',
    };
  }
}
// ── STAGE 3: SUBMIT ACHIEVEMENT PROOF ───────────────────────
// FIX: writes to the real columns — achievement_proof_urls,
// proof_description, submitted_at, proof_value — instead of a
// single nonexistent "achievement_proof" JSON blob column.

export async function submitProof(challengeId, clerkId, body, db) {
  const userId = await resolveUserId(clerkId, db);
  if (!userId) return { error: 'User not found' };

  const { proof_url, proof_description, proof_value } = body;

  if (!proof_url && !proof_description) {
    return { error: 'proof_url or proof_description is required' };
  }

  const entry = await db
    .prepare(`
      SELECT ce.*, c.status, c.ends_at
      FROM challenge_entries ce
      JOIN challenges c ON c.id = ce.challenge_id
      WHERE ce.challenge_id = ? AND ce.user_id = ?
    `)
    .bind(challengeId, userId)
    .first();

  if (!entry)                        return { error: 'You are not entered in this challenge' };
  if (entry.status === 'completed')  return { error: 'Challenge already resolved' };

  await db
    .prepare(`
      UPDATE challenge_entries
      SET achievement_proof_urls = ?, proof_description = ?,
          proof_value = ?, submitted_at = ?
      WHERE challenge_id = ? AND user_id = ?
    `)
    .bind(
      proof_url ?? null,
      proof_description ?? null,
      proof_value ?? 0,
      nowISO(),
      challengeId,
      userId,
    )
    .run();

  return {
    submitted:    true,
    challenge_id: challengeId,
    proof_value:  proof_value ?? null,
  };
}

// ── STAGE 4: SCORE ENTRIES (admin) — unchanged, columns match ──

export async function scoreEntry(challengeId, entryUserId, score, db) {
  if (score < 0 || score > 100) return { error: 'Score must be between 0 and 100' };

  const entry = await db
    .prepare(`SELECT id FROM challenge_entries WHERE challenge_id = ? AND user_id = ?`)
    .bind(challengeId, entryUserId)
    .first();

  if (!entry) return { error: 'Entry not found' };

  await db
    .prepare(`UPDATE challenge_entries SET score = ? WHERE challenge_id = ? AND user_id = ?`)
    .bind(score, challengeId, entryUserId)
    .run();

  return { scored: true, challenge_id: challengeId, user_id: entryUserId, score };
}

// ── STAGE 5: RESOLVE WINNER (admin) ──────────────────────────
// FIX: removed ce.entry_amount from the SELECT — that column
// doesn't exist, and the returned value was never actually used
// anywhere in this function anyway (pool math comes from the
// challenges table, not per-entry amounts). Dead reference removed.

export async function resolveChallenge(challengeId, moderatorId, db) {
  const challenge = await db.prepare(`
    SELECT *
    FROM challenges
    WHERE id = ?
  `).bind(challengeId).first();

  if (!challenge) return { error: 'Challenge not found' };
  if (challenge.status === 'cancelled') {
    return { error: 'Challenge was cancelled' };
  }

  const { results: entries } = await db.prepare(`
    SELECT
      ce.user_id,
      ce.score,
      ce.status AS entry_status,
      ce.submitted_at,
      ce.created_at,
      u.username
    FROM challenge_entries ce
    JOIN users u ON u.id = ce.user_id
    WHERE ce.challenge_id = ?
      AND ce.status != 'disqualified'
    ORDER BY
      ce.score DESC,
      ce.submitted_at ASC,
      ce.created_at ASC,
      ce.user_id ASC
  `).bind(challengeId).all();

  if (!entries.length) {
    return { error: 'No eligible entries to resolve' };
  }

  const winner = entries[0];
  const now = nowISO();

  const poolMinor = challenge.pool_funded_minor ?? 0;
  const entryFeeMinor = challenge.entry_fee_minor ?? 0;

  let settlement = null;

  // PAID CHALLENGE
  if (poolMinor > 0 || entryFeeMinor > 0) {
    try {
      const financial = new ChallengeFinancialService(db);

      settlement = await financial.settleWinner({
        challengeId,
        winnerId: winner.user_id,
        moderatorId,
      });
    } catch (error) {
      console.error('Challenge winner settlement failed:', error);

      return {
        error: 'Financial settlement failed',
        details: error.message,
      };
    }
  } else {
    // FREE CHALLENGE: ensure no money was collected.
    const funding = await db.prepare(`
      SELECT
        COUNT(*) AS operation_count,
        COALESCE(SUM(amount_minor), 0) AS total_minor
      FROM challenge_financial_operations
      WHERE challenge_id = ?
        AND operation_type = 'entry_funding'
    `).bind(challengeId).first();

    if (
      poolMinor !== 0 ||
      funding.total_minor !== 0 ||
      funding.operation_count !== 0
    ) {
      return {
        error: 'Challenge financial records require reconciliation',
      };
    }
  }

  // Finalize Challenge only after financial settlement succeeds.
  const finalized = await db.prepare(`
    UPDATE challenges
    SET
      status = 'completed',
      financial_status = 'settled',
      winner_id = ?,
      winner_announced_at = ?,
      updated_at = ?
    WHERE id = ?
      AND status != 'cancelled'
      AND (
        status != 'completed'
        OR (
          winner_id = ?
          AND financial_status = 'settled'
        )
      )
  `).bind(
    winner.user_id,
    now,
    now,
    challengeId,
    winner.user_id
  ).run();

  const confirmed = await db.prepare(`
    SELECT status, winner_id, financial_status
    FROM challenges
    WHERE id = ?
  `).bind(challengeId).first();

  if (
    confirmed?.status !== 'completed' ||
    confirmed.winner_id !== winner.user_id ||
    confirmed.financial_status !== 'settled'
  ) {
    return {
      error: 'Challenge settlement succeeded but finalization requires reconciliation',
      settlement,
    };
  }

	  // Notify winner only after challenge and financial finalization.
  try {
    await publishNotification(db, {
      recipientUserId: winner.user_id,
      type: 'challenge_won',
      title: 'Challenge Won!',
      body: `Congratulations! You won "${challenge.title}".`,
      actionUrl: `/arena?challenge=${challengeId}`,
      preference: 'challenge_updates',
      actorType: 'platform_admin',
      actorId: moderatorId,
      resourceType: 'challenge',
      resourceId: challengeId,
    });
  } catch (error) {
    console.error('[challenge-won-notification]', error);
  }
	
  // Score rewards are separate from financial settlement.
  // Deterministic event IDs prevent duplicate rewards on retries.
  try {
    await addScoreEvent(
      winner.user_id,
      'challenge_win',
      null,
      {
        event_id: `challenge:${challengeId}:winner:${winner.user_id}`,
        challenge_id: challengeId,
        note: `Won Drop Circle: ${challenge.title}`,
      },
      db
    );
  } catch (error) {
    console.error('Challenge winner score reward failed:', error);
  }

  for (const entry of entries.slice(1)) {
    try {
      await addScoreEvent(
        entry.user_id,
        'verified_achievement_post',
        10,
        {
          event_id: `challenge:${challengeId}:participant:${entry.user_id}`,
          challenge_id: challengeId,
          note: `Participated in Drop Circle: ${challenge.title}`,
        },
        db
      );
    } catch (error) {
      console.error(
        'Challenge participant score reward failed:',
        entry.user_id,
        error
      );
    }
  }

  return {
    resolved: true,
    challenge_id: challengeId,
    winner_id: winner.user_id,
    winner_username: winner.username,
    pool_amount_minor: poolMinor,
    currency_code: challenge.currency_code,
    total_entries: entries.length,
    settlement,
  };
}

// ── FEATURE 1: GOLD BUTTON (columns confirmed correct) ────────

export async function giveGoldButton(challengeId, clerkId, db) {
  const userId = await resolveUserId(clerkId, db);
  if (!userId) return { error: 'User not found' };

  const challenge = await db
    .prepare(`SELECT id, status FROM challenges WHERE id = ?`)
    .bind(challengeId)
    .first();

  if (!challenge)                  return { error: 'Challenge not found' };
  if (challenge.status !== 'open') return { error: 'Challenge is not open' };

  const existing = await db
    .prepare(`SELECT id FROM challenge_gold_buttons WHERE challenge_id = ? AND user_id = ?`)
    .bind(challengeId, userId)
    .first();

  if (existing) return { error: 'You have already given a gold button to this challenge' };

  await db
    .prepare(`
      INSERT INTO challenge_gold_buttons (id, challenge_id, user_id, created_at)
      VALUES (?, ?, ?, ?)
    `)
    .bind(crypto.randomUUID(), challengeId, userId, nowISO())
    .run();

  await addScoreEvent(
    userId, 'gold_button_given', null,
    { challenge_id: challengeId, note: 'Gave gold button to a challenge' },
    db,
  );

  return { gold_button: true, challenge_id: challengeId };
}

// ── FEATURE 2: CHALLENGE BOOST (columns confirmed correct) ────

export async function boostChallenge(challengeId, clerkId, body, db) {
  const userId = await resolveUserId(clerkId, db);
  if (!userId) return { error: 'User not found' };

  const { amount_usd } = body;

  if (!amount_usd || amount_usd <= 0) return { error: 'amount_usd is required and must be positive' };

  const challenge = await db
    .prepare(`SELECT id, status FROM challenges WHERE id = ?`)
    .bind(challengeId)
    .first();

  if (!challenge)                  return { error: 'Challenge not found' };
  if (challenge.status !== 'open') return { error: 'Challenge is not open' };

  // Check wallet
  const wallet = await db
    .prepare(`SELECT balance_usd FROM wallets WHERE user_id = ?`)
    .bind(userId)
    .first();

  if (!wallet || wallet.balance_usd < amount_usd) {
    return { error: `Insufficient wallet balance. Boost costs $${amount_usd.toFixed(2)}` };
  }

  const now       = nowISO();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  await db.batch([
    db.prepare(`
      INSERT INTO challenge_boosts (id, challenge_id, user_id, amount_usd, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(crypto.randomUUID(), challengeId, userId, amount_usd, expiresAt, now),

    db.prepare(`
      UPDATE wallets SET balance_usd = balance_usd - ?, updated_at = ?
      WHERE user_id = ?
    `).bind(amount_usd, now, userId),
  ]);

  await addScoreEvent(
    userId, 'challenge_boost_purchased', null,
    { challenge_id: challengeId, note: `Boosted challenge for $${amount_usd}` },
    db,
  );

  return {
    boosted:      true,
    challenge_id: challengeId,
    amount_usd,
    expires_at:   expiresAt,
  };
}

// ── GET CHALLENGES (Arena feed) ──────────────────────────────

export async function getChallenges(limit, offset, db, status) {
  const now = nowISO();

  let statusClause;
  const params = [now];

  if (status === 'upcoming') {
    statusClause = `c.status = 'open' AND c.starts_at > ?`;
    params.push(now);
  } else if (status === 'completed') {
    statusClause = `c.status = 'completed'`;
  } else {
    statusClause = `c.status = 'open' AND (c.starts_at IS NULL OR c.starts_at <= ?)`;
    params.push(now);
  }

  params.push(limit ?? 20, offset ?? 0);

  const { results } = await db
    .prepare(`
      SELECT
        c.id, c.title, c.challenge_type as type, c.status,
        c.pool_total_cents / 100.0  AS pool_amount,
        c.entry_fee_cents  / 100.0  AS entry_fee,
        c.starts_at, c.ends_at,
        c.participant_count         AS entries,
        COUNT(DISTINCT cgb.id)      AS gold_buttons,
        MAX(CASE WHEN cb.expires_at > ? THEN 1 ELSE 0 END) AS is_boosted
      FROM challenges c
      LEFT JOIN challenge_gold_buttons cgb ON cgb.challenge_id = c.id
      LEFT JOIN challenge_boosts cb        ON cb.challenge_id  = c.id
      WHERE c.moderation_status = 'approved'
        AND c.deleted_at IS NULL
        AND ${statusClause}
      GROUP BY c.id
      ORDER BY is_boosted DESC, gold_buttons DESC, c.created_at DESC
      LIMIT ? OFFSET ?
    `)
    .bind(...params)
    .all();

  return results;
}

// ── GET SINGLE CHALLENGE ─────────────────────────────────────
// Public visitors can only view approved, non-deleted challenges.
// Creators can view their own unpublished challenges.
// Admins can view unpublished challenges for moderation.
// Participant lists are not exposed on unpublished challenges.

export async function getChallengeById(
  challengeId,
  db,
  viewerClerkId = null,
  viewerIsAdmin = false
) {
  try {
    const challenge = await db
      .prepare(`
        SELECT
          c.*,
          c.pool_total_cents / 100.0 AS pool_amount,
          c.entry_fee_cents / 100.0 AS entry_fee,
          c.participant_count AS entries
        FROM challenges c
        WHERE c.id = ?
          AND c.deleted_at IS NULL
      `)
      .bind(challengeId)
      .first();

    if (!challenge) return null;

    let isCreator = false;

    if (viewerClerkId) {
      const internalUserId = await resolveUserId(viewerClerkId, db);
      isCreator = Boolean(
        internalUserId &&
        internalUserId === challenge.creator_id
      );
    }

    const isApproved =
      challenge.moderation_status === 'approved';

    // Unpublished challenges are private to their creator and admins.
    if (!isApproved && !isCreator && !viewerIsAdmin) {
      return null;
    }

    // Never expose participants on unpublished challenges to creators.
    // Admins retain access for moderation purposes.
    let entryList = [];

    if (isApproved || viewerIsAdmin) {
      const result = await db
        .prepare(`
          SELECT
            ce.user_id,
            ce.score,
            ce.created_at,
            u.username,
            u.league
          FROM challenge_entries ce
          JOIN users u ON u.id = ce.user_id
          WHERE ce.challenge_id = ?
          ORDER BY ce.score DESC
        `)
        .bind(challengeId)
        .all();

      entryList = result.results ?? [];
    }

    const { results: goldButtons } = await db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM challenge_gold_buttons
        WHERE challenge_id = ?
      `)
      .bind(challengeId)
      .all();

     return {
      ...challenge,
      is_creator: isCreator,
      entry_list: entryList,
      gold_buttons: goldButtons[0]?.count ?? 0,
    };
  } catch (err) {
    console.error('getChallengeById error:', err);
    throw err;
  }
}

// ── FIX 7: EXPIRE CHALLENGES ──────────────────────────────────

export async function expireChallenges(db) {
const now = nowISO();

const { results: expired } = await db.prepare("SELECT id, entry_fee_minor, pool_funded_minor, financial_status FROM challenges WHERE status = 'open' AND ends_at <= ? ORDER BY ends_at ASC, id ASC").bind(now).all();

const summary = {
processed: 0,
refunded: 0,
completed: 0,
skipped: 0,
failed: 0,
};

for (const challenge of expired) {
try {
const financialStatus = challenge.financial_status;
const entryFeeMinor = challenge.entry_fee_minor ?? 0;
const poolMinor = challenge.pool_funded_minor ?? 0;

  // Legacy financial records must never be refunded
  // automatically through the new ledger.
  if (financialStatus === 'legacy') {
    await db.prepare(`
      UPDATE challenges
      SET status = 'completed',
          updated_at = ?
      WHERE id = ?
        AND status = 'open'
        AND financial_status = 'legacy'
    `).bind(now, challenge.id).run();

    summary.completed++;
    continue;
  }

  // A funded Challenge must be refunded before expiry
  // can be finalized.
  if (
    financialStatus === 'funded' ||
    financialStatus === 'refunding'
  ) {
    const financial = new ChallengeFinancialService(db);

    await financial.refundChallenge({
      challengeId: challenge.id,
      moderatorId: 'system',
      reason: 'Challenge expired before resolution',
    });

    const finalized = await db.prepare(`
      UPDATE challenges
      SET status = 'completed',
          updated_at = ?
      WHERE id = ?
        AND status = 'open'
        AND financial_status = 'refunded'
    `).bind(nowISO(), challenge.id).run();

    const confirmed = await db.prepare(`
      SELECT status, financial_status
      FROM challenges
      WHERE id = ?
    `).bind(challenge.id).first();

    if (
      confirmed?.status !== 'completed' ||
      confirmed?.financial_status !== 'refunded'
    ) {
      throw new Error(
        'Refund succeeded but Challenge expiry finalization failed'
      );
    }

    summary.refunded++;
    summary.completed++;
    summary.processed++;
    continue;
  }

  // Pending/free Challenges can expire only when no
  // financial funding operation or funded pool exists.
  if (
    ['pending', 'funding'].includes(financialStatus) &&
    entryFeeMinor >= 0 &&
    poolMinor === 0
  ) {
    const operations = await db.prepare(`
      SELECT COUNT(*) AS operation_count
      FROM challenge_financial_operations
      WHERE challenge_id = ?
    `).bind(challenge.id).first();

    if ((operations?.operation_count ?? 0) !== 0) {
      console.error(
        '[Challenge expiry] Pending financial operations require reconciliation:',
        challenge.id
      );
      summary.skipped++;
      continue;
    }

    await db.prepare(`
      UPDATE challenges
      SET status = 'completed',
          updated_at = ?
         WHERE id = ?
          AND status = 'open'
          AND moderation_status = 'approved'
          AND deleted_at IS NULL
          AND financial_status IN (
        AND pool_funded_minor = 0
    `).bind(nowISO(), challenge.id).run();

    summary.completed++;
    summary.processed++;
    continue;
  }

  // Settled/refunded records should not be silently
  // reprocessed. Any other financial state needs review.
  if (
    financialStatus === 'settled' ||
    financialStatus === 'refunded'
  ) {
    await db.prepare(`
      UPDATE challenges
      SET status = 'completed',
          updated_at = ?
      WHERE id = ?
        AND status = 'open'
        AND financial_status = ?
    `).bind(nowISO(), challenge.id, financialStatus).run();

    summary.completed++;
    summary.processed++;
    continue;
  }

  console.error(
    '[Challenge expiry] Financial state requires reconciliation:',
    challenge.id,
    financialStatus
  );
  summary.skipped++;
} catch (error) {
  console.error(
    '[Challenge expiry] Failed:',
    challenge.id,
    error?.message || error
  );
  summary.failed++;
}

}

console.log('[Challenge expiry] Summary:', summary);

return summary;
		}
