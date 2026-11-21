import { FinancialService } from './financialService.js';
import {
  assertSafeMinorUnits,
  validateCurrencyCode,
  validateMinorUnitExponent,
} from './money.js';

function requireText(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} is required`);
  }

  return value.trim();
}

export class ChallengeFinancialService {
  constructor(db) {
    if (!db) {
      throw new Error('A D1 database binding is required');
    }

    this.db = db;
    this.financial = new FinancialService(db);
  }

  async fundEntry({
    challengeId,
    userId,
    idempotencyKey,
  }) {
    challengeId = requireText(challengeId, 'Challenge ID');
    userId = requireText(userId, 'User ID');
    idempotencyKey = requireText(
      idempotencyKey,
      'Idempotency key'
    );

    const challenge = await this.db.prepare(`
      SELECT
        id,
        creator_id,
        currency_code,
        entry_fee_minor,
        financial_status,
        status,
        ends_at,
        max_participants,
        participant_count
      FROM challenges
      WHERE id = ?
    `).bind(challengeId).first();

    if (!challenge) {
      throw new Error('Challenge not found');
    }

    const currencyCode = validateCurrencyCode(
      challenge.currency_code
    );

    const amountMinor = challenge.entry_fee_minor;

    assertSafeMinorUnits(amountMinor);

    if (amountMinor <= 0) {
      throw new Error('This Challenge does not require paid entry');
    }

    // Check an existing operation before checking current
    // Challenge state. This allows legitimate retries.
    const existing = await this.db.prepare(`
      SELECT
        id,
        entry_id,
        amount_minor,
        currency_code,
        idempotency_key,
        ledger_transaction_id,
        status,
        metadata_json
      FROM challenge_financial_operations
      WHERE challenge_id = ?
        AND operation_type = 'entry_funding'
        AND actor_id = ?
        AND idempotency_key = ?
    `).bind(
      challengeId,
      userId,
      idempotencyKey
    ).first();

    if (existing) {
      if (
        existing.amount_minor !== amountMinor ||
        existing.currency_code !== currencyCode
      ) {
        throw new Error(
          'Idempotency key was already used for different Challenge entry data'
        );
      }

      if (
        existing.status === 'posted' &&
        existing.ledger_transaction_id
      ) {
        return {
          funded: true,
          already_funded: true,
          entry_id: existing.entry_id,
          operation_id: existing.id,
          ledger_transaction_id:
            existing.ledger_transaction_id,
          amount_minor: existing.amount_minor,
          currency_code: existing.currency_code,
        };
      }

      throw new Error(
        'Previous Challenge entry funding requires reconciliation'
      );
    }

    if (challenge.creator_id === userId) {
      throw new Error(
        'Challenge creators cannot enter their own Challenge'
      );
    }

    if (challenge.status !== 'open') {
      throw new Error('Challenge is not open for entries');
    }

    if (new Date(challenge.ends_at) <= new Date()) {
      throw new Error('Challenge has expired');
    }

    if (
      !['pending', 'funding', 'funded'].includes(
        challenge.financial_status
      )
    ) {
      throw new Error(
        'Challenge is not accepting financial operations'
      );
    }

    if (
      challenge.max_participants !== null &&
      challenge.participant_count >= challenge.max_participants
    ) {
      throw new Error('Challenge is full');
    }

    const duplicateEntry = await this.db.prepare(`
      SELECT id
      FROM challenge_entries
      WHERE challenge_id = ?
        AND user_id = ?
    `).bind(
      challengeId,
      userId
    ).first();

    if (duplicateEntry) {
      throw new Error('You have already joined this Challenge');
    }

    const currency = await this.db.prepare(`
      SELECT minor_unit_exponent
      FROM financial_currencies
      WHERE currency_code = ?
        AND is_enabled = 1
    `).bind(currencyCode).first();

    if (!currency) {
      throw new Error('Challenge currency is not enabled');
    }

    validateMinorUnitExponent(
      currency.minor_unit_exponent
    );

    const entryId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const transactionId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Include the Challenge and member in the ledger key.
    // This prevents collisions between different Challenges.
    const ledgerIdempotencyKey =
      `challenge:${challengeId}:entry:${userId}:${idempotencyKey}`;

    const source = await this.financial.getOwnerAvailableAccount({
      ownerType: 'user',
      ownerId: userId,
      currencyCode,
    });

    const escrow = await this.financial.getEscrowAccount({
      escrowType: 'CHALLENGE',
      escrowId: challengeId,
      currencyCode,
    });

    const result = await this.financial.ledger.postTransaction({
      transactionId,

      idempotencyScope: 'challenge-entry-funding',
      idempotencyKey: ledgerIdempotencyKey,

      sourceModule: 'challenge',
      transactionType: 'challenge_entry_funding',

      actorType: 'member',
      actorId: userId,

      description: 'Fund Challenge entry',
      reference: challengeId,

      metadata: {
        challenge_id: challengeId,
        entry_id: entryId,
        participant_id: userId,
        currency_code: currencyCode,
        amount_minor: amountMinor,
        platform_fee_minor: 0,
      },

      entries: [
        {
          accountId: source.id,
          currencyCode,
          side: 'debit',
          amountMinor,
          description: 'Challenge entry funded from available wallet',
        },
        {
          accountId: escrow.id,
          currencyCode,
          side: 'credit',
          amountMinor,
          description: 'Challenge entry received into escrow',
        },
      ],

      // The entry and pending operation are created in the
      // same atomic batch as the ledger transaction.
      atomicStatements: [
        this.db.prepare(`
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
            CASE
              WHEN c.currency_code = 'USD' THEN ?
              ELSE 0
            END,
            ?
          FROM challenges c
          WHERE c.id = ?
            AND c.status = 'open'
            AND c.ends_at > ?
            AND c.financial_status IN (
              'pending',
              'funding',
              'funded'
            )
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
          entryId
