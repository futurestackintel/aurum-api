import { FinancialService } from './financialService.js';
import {
  assertSafeMinorUnits,
  validateCurrencyCode,
} from './money.js';

function requireText(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} is required`);
  }

  return value.trim();
}

function parseMetadata(value) {
  if (!value) return {};

  try {
    return JSON.parse(value);
  } catch {
    throw new Error('Invalid Challenge financial metadata');
  }
}

export class ChallengeFinancialService {
  constructor(db) {
    if (!db) {
      throw new Error('A D1 database binding is required');
    }

    this.db = db;
    this.financial = new FinancialService(db);
  }
/**

* Settle a paid Challenge's entire escrow to its winner.
* 
* Uses a stable operation and ledger idempotency key so retries
* cannot pay the winner twice.
  */
  async settleWinner({
  challengeId,
  winnerId,
  moderatorId,
  }) {
  challengeId = requireText(challengeId, 'Challenge ID');
  winnerId = requireText(winnerId, 'Winner ID');
  moderatorId = requireText(moderatorId, 'Moderator ID');

const challenge = await this.db.prepare(`
  SELECT
    id,
    status,
    financial_status,
    currency_code,
    pool_funded_minor
  FROM challenges
  WHERE id = ?
`).bind(challengeId).first();

if (!challenge) {
  throw new Error('Challenge not found');
}

if (challenge.status === 'cancelled') {
  throw new Error('Cancelled Challenges cannot be settled');
}

if (challenge.status === 'completed') {
  if (challenge.financial_status === 'settled') {
    return {
      settled: true,
      already_settled: true,
      winner_id: winnerId,
    };
  }

  throw new Error(
    'Challenge completion requires financial reconciliation'
  );
}

const currencyCode = validateCurrencyCode(
  challenge.currency_code
);

const poolMinor = challenge.pool_funded_minor;

assertSafeMinorUnits(poolMinor);

if (poolMinor <= 0) {
  throw new Error(
    'This Challenge has no funded prize pool'
  );
}

if (
  !['funded', 'settling'].includes(
    challenge.financial_status
  )
) {
  throw new Error(
    'Challenge is not ready for financial settlement'
  );
}

// The authoritative pool must equal successfully posted
// entry-funding operations. Never settle an unverified pool.
const funding = await this.db.prepare(`
  SELECT
    COUNT(*) AS operation_count,
    COALESCE(SUM(amount_minor), 0) AS total_minor
  FROM challenge_financial_operations
  WHERE challenge_id = ?
    AND operation_type = 'entry_funding'
    AND currency_code = ?
    AND status = 'posted'
`).bind(
  challengeId,
  currencyCode
).first();

if (
  funding.total_minor !== poolMinor ||
  funding.operation_count < 1
) {
  throw new Error(
    'Challenge funding total does not reconcile with its posted ledger operations'
  );
}

const idempotencyKey =
  `challenge:${challengeId}:winner-settlement:v1`;

const existing = await this.db.prepare(`
  SELECT
    id,
    amount_minor,
    currency_code,
    ledger_transaction_id,
    status,
    metadata_json
  FROM challenge_financial_operations
  WHERE challenge_id = ?
    AND operation_type = 'winner_settlement'
    AND actor_id = 'system'
    AND idempotency_key = ?
`).bind(
  challengeId,
  idempotencyKey
).first();

let operationId;
let metadata;

if (existing) {
  if (
    existing.amount_minor !== poolMinor ||
    existing.currency_code !== currencyCode
  ) {
    throw new Error(
      'Existing winner settlement does not match the Challenge pool'
    );
  }

  if (existing.status === 'posted') {
    return {
      settled: true,
      already_settled: true,
      operation_id: existing.id,
      ledger_transaction_id:
        existing.ledger_transaction_id,
      winner_id: winnerId,
    };
  }

  if (existing.status !== 'pending') {
    throw new Error(
      'Winner settlement requires financial reconciliation'
    );
  }

  operationId = existing.id;
  metadata = parseMetadata(existing.metadata_json);

  if (metadata.winner_id !== winnerId) {
    throw new Error(
      'Winner differs from the pending settlement record'
    );
  }
} else {
  operationId = crypto.randomUUID();

  metadata = {
    challenge_id: challengeId,
    winner_id: winnerId,
    moderator_id: moderatorId,
    currency_code: currencyCode,
    gross_amount_minor: poolMinor,
  };

  await this.db.prepare(`
    INSERT INTO challenge_financial_operations (
      id,
      challenge_id,
      entry_id,
      operation_type,
      actor_id,
      currency_code,
      amount_minor,
      idempotency_key,
      ledger_transaction_id,
      status,
      metadata_json
    )
    VALUES (
      ?,
      ?,
      NULL,
      'winner_settlement',
      'system',
      ?,
      ?,
      ?,
      NULL,
      'pending',
      ?
    )
  `).bind(
    operationId,
    challengeId,
    currencyCode,
    poolMinor,
    idempotencyKey,
    JSON.stringify(metadata)
  ).run();
}

const result = await this.financial.settleEscrow({
  escrowType: 'CHALLENGE',
  escrowId: challengeId,
  currencyCode,
  grossAmountMinor: poolMinor,
  recipientType: 'user',
  recipientId: winnerId,
  idempotencyKey,
  actorType: 'system',
  actorId: 'system',
  reference: challengeId,
  metadata,
});

const transactionId = result.transaction.id;
const now = new Date().toISOString();

const operationUpdate = await this.db.prepare(`
  UPDATE challenge_financial_operations
  SET
    status = 'posted',
    ledger_transaction_id = ?,
    updated_at = ?
  WHERE id = ?
    AND status = 'pending'
`).bind(
  transactionId,
  now,
  operationId
).run();

if (operationUpdate.meta?.changes !== 1) {
  const confirmed = await this.db.prepare(`
    SELECT status, ledger_transaction_id
    FROM challenge_financial_operations
    WHERE id = ?
  `).bind(operationId).first();

  if (
    confirmed?.status !== 'posted' ||
    confirmed.ledger_transaction_id !== transactionId
  ) {
    throw new Error(
      'Settlement posted but operation finalization requires reconciliation'
    );
  }
}

return {
  settled: true,
  already_settled: !result.created,
  operation_id: operationId,
  ledger_transaction_id: transactionId,
  winner_id: winnerId,
  gross_amount_minor: poolMinor,
  currency_code: currencyCode,
};

		}
  /**
   * Fund one paid Challenge entry.
   *
   * Money moves:
   * User available wallet -> Challenge escrow.
   *
   * No platform fee is charged when entering.
   */
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

    // Idempotent retry recovery.
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
          'Idempotency key was reused with different Challenge entry data'
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
        'Previous Challenge funding operation requires reconciliation'
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

    const entryId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const transactionId = crypto.randomUUID();
    const now = new Date().toISOString();

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
          description: 'Challenge entry funded from wallet',
        },
        {
          accountId: escrow.id,
          currencyCode,
          side: 'credit',
          amountMinor,
          description: 'Challenge entry received into escrow',
        },
      ],

      // The entry must successfully exist before its
      // financial operation record can be inserted.
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
          entryId,
          userId,
          amountMinor,
          amountMinor,
          challengeId,
          now,
          userId
        ),

        // If the entry INSERT above fails to create a row,
        // this FK-linked operation insert fails the batch.
        this.db.prepare(`
          INSERT INTO challenge_financial_operations (
            id,
            challenge_id,
            entry_id,
            operation_type,
            actor_id,
            currency_code,
            amount_minor,
            idempotency_key,
            ledger_transaction_id,
            status,
            metadata_json
          )
          VALUES (
            ?,
            ?,
            ?,
            'entry_funding',
            ?,
            ?,
            ?,
            ?,
            ?,
            'pending',
            ?
          )
        `).bind(
          operationId,
          challengeId,
          entryId,
          userId,
          currencyCode,
          amountMinor,
          idempotencyKey,
          transactionId,
          JSON.stringify({
            challenge_id: challengeId,
            entry_id: entryId,
            participant_id: userId,
            currency_code: currencyCode,
            amount_minor: amountMinor,
          })
        ),
      ],

      // Mark the operation posted only after the ledger
      // transaction itself has been posted.
      atomicStatementsAfterPosting: [
        this.db.prepare(`
          UPDATE challenge_financial_operations
          SET
            status = 'posted',
            updated_at = ?
          WHERE id = ?
            AND status = 'pending'
            AND ledger_transaction_id = ?
        `).bind(
          now,
          operationId,
          transactionId
        ),

        this.db.prepare(`
        UPDATE challenges
        SET
        participant_count = participant_count + 1,
        pool_funded_minor = pool_funded_minor + ?,
        financial_status = 'funded',
        updated_at = ?
   WHERE id = ?
    `).bind(
       amountMinor,
       now,
       challengeId
     ),
      ],
    });

    return {
      funded: true,
      already_funded: !result.created,
      entry_id: entryId,
      operation_id: operationId,
      ledger_transaction_id:
        result.transaction.id,
      amount_minor: amountMinor,
      currency_code: currencyCode,
    };
  }
	}
