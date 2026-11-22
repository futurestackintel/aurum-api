import { FinancialService } from './financialService.js';
import {
  assertSafeMinorUnits,
  validateCurrencyCode,
} from './money.js';

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required`);
  }

  return value.trim();
}

function parseMetadata(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('Invalid Crew Battle financial metadata');
  }
}

export class CrewBattleFinancialService {
  constructor(db) {
    if (!db) throw new Error('A D1 database binding is required');

    this.db = db;
    this.financial = new FinancialService(db);
  }

  async fundContribution({
    battleId,
    payerId,
    contributionType,
    amountMinor,
    currencyCode = 'USD',
    idempotencyKey,
  }) {
    battleId = requireText(battleId, 'Battle ID');
    payerId = requireText(payerId, 'Payer ID');
    idempotencyKey = requireText(idempotencyKey, 'Idempotency key');

    if (!['challenger_funding', 'target_funding'].includes(contributionType)) {
      throw new Error('Unsupported Crew Battle contribution type');
    }

    currencyCode = validateCurrencyCode(currencyCode);
    assertSafeMinorUnits(amountMinor);

    if (amountMinor <= 0) {
      throw new Error('Contribution must be greater than zero');
    }

    const battle = await this.db.prepare(`
      SELECT id, status, financial_status, currency_code
      FROM crew_battles
      WHERE id = ?
    `).bind(battleId).first();

    if (!battle) throw new Error('Crew Battle not found');

    if (battle.currency_code !== currencyCode) {
      throw new Error('Contribution currency does not match the battle');
    }

    const existing = await this.db.prepare(`
      SELECT *
      FROM crew_battle_financial_operations
      WHERE idempotency_key = ?
    `).bind(idempotencyKey).first();

    if (existing) {
      if (
        existing.battle_id !== battleId ||
        existing.owner_id !== payerId ||
        existing.amount_minor !== amountMinor ||
        existing.currency_code !== currencyCode ||
        existing.operation_type !== contributionType
      ) {
        throw new Error('Idempotency key was reused with different contribution data');
      }

      if (existing.status === 'posted') {
        return {
          funded: true,
          already_funded: true,
          operation_id: existing.id,
          ledger_transaction_id: existing.ledger_transaction_id,
        };
      }

      throw new Error('Previous contribution requires financial reconciliation');
    }

    const operationId = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.db.prepare(`
      INSERT INTO crew_battle_financial_operations (
        id, battle_id, operation_type, actor_id,
        owner_type, owner_id, currency_code,
        amount_minor, idempotency_key, status,
        metadata_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, 'pending', '{}', ?, ?)
    `).bind(
      operationId,
      battleId,
      contributionType,
      payerId,
      payerId,
      currencyCode,
      amountMinor,
      idempotencyKey,
      now,
      now
    ).run();

    try {
      const result = await this.financial.fundEscrow({
        ownerType: 'user',
        ownerId: payerId,
        escrowType: 'CREW_BATTLE',
        escrowId: battleId,
        currencyCode,
        amountMinor,
        idempotencyKey,
        actorType: 'member',
        actorId: payerId,
        reference: battleId,
        metadata: {
          battle_id: battleId,
          operation_id: operationId,
          operation_type: contributionType,
          payer_id: payerId,
        },
      });

      const transactionId = result.transaction.id;

      const update = await this.db.prepare(`
        UPDATE crew_battle_financial_operations
        SET status = 'posted',
            ledger_transaction_id = ?,
            updated_at = ?
        WHERE id = ?
          AND status = 'pending'
      `).bind(transactionId, new Date().toISOString(), operationId).run();

      if (update.meta?.changes !== 1) {
        const confirmed = await this.db.prepare(`
          SELECT status, ledger_transaction_id
          FROM crew_battle_financial_operations
          WHERE id = ?
        `).bind(operationId).first();

        if (
          confirmed?.status !== 'posted' ||
          confirmed.ledger_transaction_id !== transactionId
        ) {
          throw new Error('Contribution posted but operation finalization requires reconciliation');
        }
      }

      return {
        funded: true,
        operation_id: operationId,
        ledger_transaction_id: transactionId,
        amount_minor: amountMinor,
        currency_code: currencyCode,
      };
    } catch (error) {
      await this.db.prepare(`
        UPDATE crew_battle_financial_operations
        SET status = 'reconciliation_required',
            updated_at = ?
        WHERE id = ?
          AND status = 'pending'
      `).bind(new Date().toISOString(), operationId).run();

      throw error;
    }
  }

  async settleWinner({
    battleId,
    winnerCrewId,
    moderatorId = null,
  }) {
    battleId = requireText(battleId, 'Battle ID');
    winnerCrewId = requireText(winnerCrewId, 'Winner crew ID');

    const battle = await this.db.prepare(`
      SELECT *
      FROM crew_battles
      WHERE id = ?
    `).bind(battleId).first();

    if (!battle) throw new Error('Crew Battle not found');

    if (
      winnerCrewId !== battle.challenger_crew_id &&
      winnerCrewId !== battle.target_crew_id
    ) {
      throw new Error('Winner must be one of the battling crews');
    }

    if (battle.financial_status === 'settled') {
      const existing = await this.db.prepare(`
        SELECT ledger_transaction_id
        FROM crew_battle_financial_operations
        WHERE battle_id = ?
          AND operation_type = 'winner_settlement'
          AND status = 'posted'
      `).bind(battleId).first();

      if (!existing) {
        throw new Error('Settled battle has no verified settlement operation');
      }

      return {
        settled: true,
        already_settled: true,
        ledger_transaction_id: existing.ledger_transaction_id,
      };
    }

    if (!['funded', 'settling'].includes(battle.financial_status)) {
      throw new Error('Crew Battle is not ready for settlement');
    }

    const currencyCode = validateCurrencyCode(battle.currency_code);
    const poolMinor = battle.prize_pool_minor;

    assertSafeMinorUnits(poolMinor);

    if (poolMinor <= 0) throw new Error('Crew Battle has no funded prize pool');

    const funding = await this.db.prepare(`
      SELECT
        COUNT(*) AS operation_count,
        COALESCE(SUM(amount_minor), 0) AS total_minor
      FROM crew_battle_financial_operations
      WHERE battle_id = ?
        AND operation_type IN ('challenger_funding', 'target_funding')
        AND status = 'posted'
        AND currency_code = ?
    `).bind(battleId, currencyCode).first();

    if (
      funding.operation_count !== 2 ||
      funding.total_minor !== poolMinor
    ) {
      throw new Error('Crew Battle contributions do not reconcile with the prize pool');
    }

    const idempotencyKey = `crew-battle:${battleId}:winner-settlement:v1`;

    const existing = await this.db.prepare(`
      SELECT *
      FROM crew_battle_financial_operations
      WHERE idempotency_key = ?
    `).bind(idempotencyKey).first();

    let operationId;

    if (existing) {
      const metadata = parseMetadata(existing.metadata_json);

      if (metadata.winner_crew_id !== winnerCrewId) {
        throw new Error('Winner differs from the existing settlement record');
      }

      if (existing.status === 'posted') {
        return {
          settled: true,
          already_settled: true,
          ledger_transaction_id: existing.ledger_transaction_id,
        };
      }

      if (existing.status !== 'pending') {
        throw new Error('Settlement requires financial reconciliation');
      }

      operationId = existing.id;
    } else {
      operationId = crypto.randomUUID();

      await this.db.prepare(`
        INSERT INTO crew_battle_financial_operations (
          id, battle_id, operation_type, actor_id,
          owner_type, owner_id, currency_code,
          amount_minor, idempotency_key, status,
          metadata_json, created_at, updated_at
        )
        VALUES (?, ?, 'winner_settlement', ?, 'crew', ?, ?, ?, ?, 'pending', ?, ?, ?)
      `).bind(
        operationId,
        battleId,
        moderatorId,
        winnerCrewId,
        currencyCode,
        poolMinor,
        idempotencyKey,
        JSON.stringify({
          battle_id: battleId,
          winner_crew_id: winnerCrewId,
        }),
        new Date().toISOString(),
        new Date().toISOString()
      ).run();
    }

    const result = await this.financial.settleEscrow({
      escrowType: 'CREW_BATTLE',
      escrowId: battleId,
      currencyCode,
      grossAmountMinor: poolMinor,
      recipientType: 'crew',
      recipientId: winnerCrewId,
      idempotencyKey,
      actorType: moderatorId ? 'platform_admin' : 'system',
      actorId: moderatorId,
      reference: battleId,
      metadata: {
        battle_id: battleId,
        winner_crew_id: winnerCrewId,
      },
    });

    const transactionId = result.transaction.id;

    const update = await this.db.prepare(`
      UPDATE crew_battle_financial_operations
      SET status = 'posted',
          ledger_transaction_id = ?,
          updated_at = ?
      WHERE id = ?
        AND status = 'pending'
    `).bind(transactionId, new Date().toISOString(), operationId).run();

    if (update.meta?.changes !== 1) {
      const confirmed = await this.db.prepare(`
        SELECT status, ledger_transaction_id
        FROM crew_battle_financial_operations
        WHERE id = ?
      `).bind(operationId).first();

      if (
        confirmed?.status !== 'posted' ||
        confirmed.ledger_transaction_id !== transactionId
      ) {
        throw new Error('Settlement posted but operation finalization requires reconciliation');
      }
    }

    await this.db.prepare(`
      UPDATE crew_battles
      SET financial_status = 'settled',
          status = 'resolved',
          winner_crew_id = ?,
          payout_released = 1
      WHERE id = ?
        AND financial_status IN ('funded', 'settling')
    `).bind(winnerCrewId, battleId).run();

    return {
      settled: true,
      operation_id: operationId,
      ledger_transaction_id: transactionId,
      gross_amount_minor: poolMinor,
      currency_code: currencyCode,
    };
  }
        }
