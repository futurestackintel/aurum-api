
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

const STAKE_OPERATIONS = {
  challenger: {
    operationType: 'challenger_stake',
    fundedColumn: 'challenger_stake_funded_minor',
    participantColumn: 'challenger_id',
  },
  target: {
    operationType: 'target_stake',
    fundedColumn: 'target_stake_funded_minor',
    participantColumn: 'target_id',
  },
};

export class DuelFinancialService {
  constructor(db) {
    if (!db) {
      throw new Error('A D1 database binding is required');
    }

    this.db = db;
    this.financial = new FinancialService(db);
  }

  async fundStake({
    duelId,
    participantId,
    participantRole,
  }) {
    duelId = requireText(duelId, 'Duel ID');
    participantId = requireText(participantId, 'Participant ID');

    const role = STAKE_OPERATIONS[participantRole];

    if (!role) {
      throw new Error('Participant role must be challenger or target');
    }

    const duel = await this.db.prepare(`
      SELECT
        id,
        challenger_id,
        target_id,
        currency_code,
        stake_amount_minor,
        challenger_stake_funded_minor,
        target_stake_funded_minor,
        financial_status,
        status
      FROM duels
      WHERE id = ?
    `).bind(duelId).first();

    if (!duel) {
      throw new Error('Duel not found');
    }

    if (duel[role.participantColumn] !== participantId) {
      throw new Error('Participant does not match this Duel role');
    }

    if (!['pending', 'active'].includes(duel.status)) {
      throw new Error('Duel is not accepting stake funding');
    }

    if (!['pending', 'partially_funded'].includes(duel.financial_status)) {
      throw new Error('Duel is not accepting financial operations');
    }

    const currencyCode = validateCurrencyCode(duel.currency_code);
    const amountMinor = duel.stake_amount_minor;

    assertSafeMinorUnits(amountMinor);

    if (amountMinor === 0) {
      throw new Error('Duel stake must be greater than zero');
    }

    const currency = await this.db.prepare(`
      SELECT minor_unit_exponent
      FROM financial_currencies
      WHERE currency_code = ?
        AND is_enabled = 1
    `).bind(currencyCode).first();

    if (!currency) {
      throw new Error('Duel currency is not enabled');
    }

    validateMinorUnitExponent(currency.minor_unit_exponent);

    const existing = await this.db.prepare(`
      SELECT id, status, ledger_transaction_id
      FROM duel_financial_operations
      WHERE duel_id = ?
        AND operation_type = ?
        AND actor_id = ?
    `).bind(
      duelId,
      role.operationType,
      participantId
    ).first();

    if (existing) {
      if (
        existing.status === 'posted' &&
        existing.ledger_transaction_id
      ) {
        return {
          funded: true,
          already_funded: true,
          operation_id: existing.id,
          ledger_transaction_id: existing.ledger_transaction_id,
        };
      }

      throw new Error(
        'A previous Duel stake operation needs reconciliation'
      );
    }

    if (duel[role.fundedColumn] !== 0) {
      throw new Error('This Duel stake has already been funded');
    }

    if (
      participantRole === 'target' &&
      duel.challenger_stake_funded_minor !== amountMinor
    ) {
      throw new Error('The challenger stake must be funded first');
    }

    const idempotencyKey =
      `duel-stake:${duelId}:${role.operationType}:${participantId}`;

    const transactionId = crypto.randomUUID();
    const operationId = crypto.randomUUID();

    const source = await this.financial.getOwnerAvailableAccount({
      ownerType: 'user',
      ownerId: participantId,
      currencyCode,
    });

    const escrow = await this.financial.getEscrowAccount({
      escrowType: 'DUEL',
      escrowId: duelId,
      currencyCode,
    });

    const nextChallengerAmount =
      participantRole === 'challenger'
        ? amountMinor
        : duel.challenger_stake_funded_minor;

    const nextTargetAmount =
      participantRole === 'target'
        ? amountMinor
        : duel.target_stake_funded_minor;

    const nextFinancialStatus =
      nextChallengerAmount === amountMinor &&
      nextTargetAmount === amountMinor
        ? 'funded'
        : 'partially_funded';

    const result = await this.financial.ledger.postTransaction({
      transactionId,

      idempotencyScope: 'duel-stake-funding',
      idempotencyKey,

      sourceModule: 'duel',
      transactionType: 'duel_stake_funding',

      actorType: 'member',
      actorId: participantId,

      description: `Fund ${participantRole} Duel stake`,
      reference: duelId,

      metadata: {
        duel_id: duelId,
        participant_role: participantRole,
        participant_id: participantId,
        currency_code: currencyCode,
        amount_minor: amountMinor,
      },

      entries: [
        {
          accountId: source.id,
          currencyCode,
          side: 'debit',
          amountMinor,
          description: 'Duel stake funded from available wallet',
        },
        {
          accountId: escrow.id,
          currencyCode,
          side: 'credit',
          amountMinor,
          description: 'Duel stake received into escrow',
        },
      ],

      atomicStatements: [
        this.db.prepare(`
          INSERT INTO duel_financial_operations (
            id,
            duel_id,
            operation_type,
            actor_id,
            currency_code,
            amount_minor,
            idempotency_key,
            ledger_transaction_id,
            status,
            metadata_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        `).bind(
          operationId,
          duelId,
          role.operationType,
          participantId,
          currencyCode,
          amountMinor,
          idempotencyKey,
          transactionId,
          JSON.stringify({
            participant_role: participantRole,
          })
        ),
      ],

      atomicStatementsAfterPosting: [
        this.db.prepare(`
          UPDATE duels
          SET
				  ${role.fundedColumn} = ?,
 				  financial_status = ?
          WHERE id = ?
            AND currency_code = ?
            AND stake_amount_minor = ?
            AND ${role.fundedColumn} = 0
            AND financial_status IN ('pending', 'partially_funded')
        `).bind(
          amountMinor,
          nextFinancialStatus,
          duelId,
          currencyCode,
          amountMinor
        ),

        this.db.prepare(`
          UPDATE duel_financial_operations
          SET
            status = 'posted',
            updated_at = ?
          WHERE id = ?
            AND status = 'pending'
        `).bind(
          new Date().toISOString(),
          operationId
        ),
      ],
    });

    return {
      funded: true,
      already_funded: !result.created,
      operation_id: operationId,
      ledger_transaction_id: result.transaction.id,
      duel_id: duelId,
      participant_role: participantRole,
      amount_minor: amountMinor,
      currency_code: currencyCode,
      financial_status: nextFinancialStatus,
        };
  }

  async fundAudienceTip({
    duelId,
    tipperId,
    participantId,
    currencyCode,
    amountMinor,
    idempotencyKey,
  }) {
    duelId = requireText(duelId, 'Duel ID');
    tipperId = requireText(tipperId, 'Tipper ID');
    participantId = requireText(participantId, 'Participant ID');
    idempotencyKey = requireText(
      idempotencyKey,
      'Idempotency key'
    );

    currencyCode = validateCurrencyCode(currencyCode);
    assertSafeMinorUnits(amountMinor);

    if (amountMinor <= 0) {
      throw new Error('Audience tip must be greater than zero');
    }

    if (tipperId === participantId) {
      throw new Error('You cannot tip yourself');
    }

    const duel = await this.db.prepare(`
      SELECT
        id,
        challenger_id,
        target_id,
        currency_code,
        financial_status,
        status,
        payout_released
      FROM duels
      WHERE id = ?
    `).bind(duelId).first();

    if (!duel) {
      throw new Error('Duel not found');
    }

    if (duel.status !== 'active') {
      throw new Error('Duel is not active');
    }

    if (duel.financial_status !== 'funded') {
      throw new Error('Duel financial state is not funded');
    }

    if (duel.payout_released) {
      throw new Error('Duel payout has already been released');
    }

    if (
      participantId !== duel.challenger_id &&
      participantId !== duel.target_id
    ) {
      throw new Error('Tip recipient must be a Duel participant');
    }

    if (
      tipperId === duel.challenger_id ||
      tipperId === duel.target_id
    ) {
      throw new Error('Duel participants cannot audience-tip');
    }

    if (currencyCode !== duel.currency_code) {
      throw new Error('Tip currency must match the Duel currency');
    }

        const existing = await this.db.prepare(`
      SELECT
        id,
        status,
        ledger_transaction_id,
        amount_minor,
        currency_code,
        metadata_json
      FROM duel_financial_operations
      WHERE duel_id = ?
        AND operation_type = 'audience_tip'
        AND actor_id = ?
        AND idempotency_key = ?
    `).bind(
      duelId,
      tipperId,
      idempotencyKey
    ).first();

    if (existing) {
      let existingMetadata = {};

      try {
        existingMetadata = JSON.parse(
          existing.metadata_json || '{}'
        );
      } catch {
        throw new Error(
          'Existing audience-tip operation requires reconciliation'
        );
      }

      const sameRequest =
        existing.amount_minor === amountMinor &&
        existing.currency_code === currencyCode &&
        existingMetadata.participant_id === participantId;

      if (!sameRequest) {
        throw new Error(
          'Idempotency key was already used for a different audience tip'
        );
      }

      if (
        existing.status === 'posted' &&
        existing.ledger_transaction_id
      ) {
        return {
          tipped: true,
          already_tipped: true,
          operation_id: existing.id,
          ledger_transaction_id: existing.ledger_transaction_id,
          amount_minor: existing.amount_minor,
          currency_code: existing.currency_code,
          recipient_id: participantId,
        };
      }

      throw new Error(
        'Previous audience-tip operation requires reconciliation'
      );
    }
	.bind(
      duelId,
      tipperId,
      idempotencyKey
    ).first();

    if (existing) {
      if (
        existing.status === 'posted' &&
        existing.ledger_transaction_id
      ) {
        return {
          tipped: true,
          already_tipped: true,
          operation_id: existing.id,
          ledger_transaction_id: existing.ledger_transaction_id,
          amount_minor: existing.amount_minor,
        };
      }

      throw new Error(
        'Previous audience-tip operation requires reconciliation'
      );
    }

    const currency = await this.db.prepare(`
      SELECT minor_unit_exponent
      FROM financial_currencies
      WHERE currency_code = ?
        AND is_enabled = 1
    `).bind(currencyCode).first();

    if (!currency) {
      throw new Error('Tip currency is not enabled');
    }

    validateMinorUnitExponent(currency.minor_unit_exponent);

    const isChallenger =
      participantId === duel.challenger_id;

    const tipColumn = isChallenger
      ? 'audience_tips_challenger_minor'
      : 'audience_tips_target_minor';

    const source = await this.financial.getOwnerAvailableAccount({
      ownerType: 'user',
      ownerId: tipperId,
      currencyCode,
    });

    const escrow = await this.financial.getEscrowAccount({
      escrowType: 'DUEL',
      escrowId: duelId,
      currencyCode,
    });

    const transactionId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const now = new Date().toISOString();

    const result = await this.financial.ledger.postTransaction({
      transactionId,

      idempotencyScope: 'duel-audience-tip',
      idempotencyKey,

      sourceModule: 'duel',
      transactionType: 'duel_audience_tip',

      actorType: 'member',
      actorId: tipperId,

      description: 'Audience tip to Duel participant',
      reference: duelId,

      metadata: {
        duel_id: duelId,
        tipper_id: tipperId,
        participant_id: participantId,
        participant_role: isChallenger
          ? 'challenger'
          : 'target',
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
          description: 'Audience tip debited from available wallet',
        },
        {
          accountId: escrow.id,
          currencyCode,
          side: 'credit',
          amountMinor,
          description: 'Audience tip added to Duel escrow',
        },
      ],

      atomicStatements: [
        this.db.prepare(`
          INSERT INTO duel_financial_operations (
            id,
            duel_id,
            operation_type,
            actor_id,
            currency_code,
            amount_minor,
            idempotency_key,
            ledger_transaction_id,
            status,
            metadata_json
          )
          VALUES (?, ?, 'audience_tip', ?, ?, ?, ?, ?, 'pending', ?)
        `).bind(
          operationId,
          duelId,
          tipperId,
          currencyCode,
          amountMinor,
          idempotencyKey,
          transactionId,
          JSON.stringify({
            participant_id: participantId,
            participant_role: isChallenger
              ? 'challenger'
              : 'target',
          })
        ),
      ],

      atomicStatementsAfterPosting: [
        this.db.prepare(`
          UPDATE duels
          SET ${tipColumn} = ${tipColumn} + ?
          WHERE id = ?
            AND status = 'active'
            AND financial_status = 'funded'
            AND payout_released = 0
            AND currency_code = ?
        `).bind(
          amountMinor,
          duelId,
          currencyCode
        ),

        this.db.prepare(`
          UPDATE duel_financial_operations
          SET
            status = 'posted',
            updated_at = ?
          WHERE id = ?
            AND status = 'pending'
        `).bind(
          now,
          operationId
        ),
      ],
    });

    let finalOperationId = operationId;

if (!result.created) {
  const existingOperation = await this.db.prepare(`
    SELECT id, status, ledger_transaction_id
    FROM duel_financial_operations
    WHERE duel_id = ?
      AND operation_type = 'audience_tip'
      AND actor_id = ?
      AND idempotency_key = ?
  `).bind(
    duelId,
    tipperId,
    idempotencyKey
  ).first();

  if (
    !existingOperation ||
    existingOperation.status !== 'posted' ||
    existingOperation.ledger_transaction_id !==
      result.transaction.id
  ) {
    throw new Error(
      'Audience tip retry requires reconciliation'
    );
  }

  finalOperationId = existingOperation.id;
}

return {
  tipped: true,
  already_tipped: !result.created,
  operation_id: finalOperationId,
  ledger_transaction_id: result.transaction.id,
  duel_id: duelId,
  recipient_id: participantId,
  amount_minor: amountMinor,
  currency_code: currencyCode,
  platform_fee_minor: 0,
   };
  }
}
