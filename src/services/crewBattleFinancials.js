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

    if (amountMinor <= 0) throw new Error('Contribution must be greater than zero');

    const existing = await this.db.prepare(`
      SELECT * FROM crew_battle_financial_operations
      WHERE idempotency_key = ?
    `).bind(idempotencyKey).first();

    if (existing) {
      if (
        existing.battle_id !== battleId ||
        existing.owner_id !== payerId ||
        existing.amount_minor !== amountMinor ||
        existing.currency_code !== currencyCode ||
        existing.operation_type !== contributionType
      ) throw new Error('Idempotency key reused with different contribution data');

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

    const battle = await this.db.prepare(`
      SELECT * FROM crew_battles WHERE id = ?
    `).bind(battleId).first();

    if (!battle) throw new Error('Crew Battle not found');
    if (battle.currency_code !== currencyCode) {
      throw new Error('Contribution currency does not match battle');
    }

    // Claim the contribution slot before any ledger posting.
    const claim = contributionType === 'challenger_funding'
      ? await this.db.prepare(`
          UPDATE crew_battles
          SET financial_status = 'funding'
          WHERE id = ?
            AND status = 'pending'
            AND financial_status = 'pending'
        `).bind(battleId).run()
      : await this.db.prepare(`
          UPDATE crew_battles
          SET financial_status = 'funding'
          WHERE id = ?
            AND status = 'pending'
            AND financial_status = 'funded'
            AND target_accepted_at IS NULL
        `).bind(battleId).run();

    if (claim.meta?.changes !== 1) {
      throw new Error('Crew Battle contribution slot is no longer available');
    }

    const operationId = crypto.randomUUID();
    const transactionId = crypto.randomUUID();
    const now = new Date().toISOString();

    try {
      const source = await this.financial.getOwnerAvailableAccount({
        ownerType: 'user',
        ownerId: payerId,
        currencyCode,
      });

      const escrow = await this.financial.getEscrowAccount({
        escrowType: 'CREW_BATTLE',
        escrowId: battleId,
        currencyCode,
      });

      const result = await this.financial.ledger.postTransaction({
        transactionId,
        idempotencyScope: 'financial-escrow-fund:crew_battle',
        idempotencyKey,
        sourceModule: 'financial_service',
        transactionType: 'escrow_funding',
        actorType: 'member',
        actorId: payerId,
        description: 'Fund Crew Battle escrow',
        reference: battleId,
        metadata: {
          escrow_type: 'CREW_BATTLE',
          escrow_id: battleId,
          battle_id: battleId,
          operation_type: contributionType,
          payer_id: payerId,
          currency_code: currencyCode,
          amount_minor: amountMinor,
        },
        entries: [
          {
            accountId: source.id,
            currencyCode,
            side: 'debit',
            amountMinor,
            description: 'Crew Battle contribution',
          },
          {
            accountId: escrow.id,
            currencyCode,
            side: 'credit',
            amountMinor,
            description: 'Crew Battle escrow funding',
          },
        ],
        atomicStatements: [
          this.db.prepare(`
            INSERT INTO crew_battle_financial_operations (
              id, battle_id, operation_type, actor_id,
              owner_type, owner_id, currency_code,
              amount_minor, idempotency_key,
              ledger_transaction_id, status,
              metadata_json, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, ?, 'pending', '{}', ?, ?)
          `).bind(
            operationId,
            battleId,
            contributionType,
            payerId,
            payerId,
            currencyCode,
            amountMinor,
            idempotencyKey,
            transactionId,
            now,
            now
          ),
        ],
        atomicStatementsAfterPosting: [
  this.db.prepare(`
    UPDATE crew_battle_financial_operations
    SET status = 'posted', updated_at = ?
    WHERE id = ?
      AND status = 'pending'
      AND ledger_transaction_id = ?
  `).bind(now, operationId, transactionId),

  this.db.prepare(`
    UPDATE crew_battles
    SET financial_status = 'funded',
        challenger_contribution_minor = CASE
          WHEN ? = 'challenger_funding' THEN ?
          ELSE challenger_contribution_minor
        END,
        target_contribution_minor = CASE
          WHEN ? = 'target_funding' THEN ?
          ELSE target_contribution_minor
        END,
        prize_pool_minor = CASE
          WHEN ? = 'target_funding'
            THEN challenger_contribution_minor + ?
          ELSE ?
        END,
        prize_pool_usd = CASE
          WHEN ? = 'target_funding'
            THEN (challenger_contribution_minor + ?) / 100.0
          ELSE ? / 100.0
        END,
        target_contribution_usd = CASE
          WHEN ? = 'target_funding' THEN ? / 100.0
          ELSE target_contribution_usd
        END,
        status = CASE
          WHEN ? = 'target_funding' THEN 'active'
          ELSE status
        END,
        target_accepted_at = CASE
          WHEN ? = 'target_funding' THEN ?
          ELSE target_accepted_at
        END,
        target_paid_by = CASE
          WHEN ? = 'target_funding' THEN ?
          ELSE target_paid_by
        END
    WHERE id = ?
      AND financial_status = 'funding'
      AND status = 'pending'
      AND (
        ? != 'target_funding'
        OR target_accepted_at IS NULL
      )
  `).bind(
    contributionType, amountMinor,
    contributionType, amountMinor,
    contributionType, amountMinor, amountMinor,
    contributionType, amountMinor, amountMinor,
    contributionType, amountMinor,
    contributionType, contributionType, now,
    contributionType, payerId,
    battleId, contributionType
  ),
],
	  });

            const operation = await this.db.prepare(`
        SELECT status, ledger_transaction_id
        FROM crew_battle_financial_operations
        WHERE id = ?
      `).bind(operationId).first();

      const finalizedBattle = await this.db.prepare(`
        SELECT financial_status, status, prize_pool_minor
        FROM crew_battles
        WHERE id = ?
      `).bind(battleId).first();

      const expectedPool = contributionType === 'target_funding'
        ? battle.challenger_contribution_minor + amountMinor
        : amountMinor;

      if (
        operation?.status !== 'posted' ||
        operation.ledger_transaction_id !== result.transaction.id ||
        finalizedBattle?.financial_status !== 'funded' ||
        finalizedBattle.prize_pool_minor !== expectedPool ||
        (
          contributionType === 'target_funding' &&
          finalizedBattle.status !== 'active'
        )
      ) {
        throw new Error('Contribution posted; battle finalization requires reconciliation');
      }
		
      return {
        funded: true,
        operation_id: operationId,
        ledger_transaction_id: result.transaction.id,
        amount_minor: amountMinor,
        currency_code: currencyCode,
      };
    } catch (error) {
      await this.db.prepare(`
        UPDATE crew_battles
        SET financial_status = 'reconciliation_required'
        WHERE id = ? AND financial_status = 'funding'
      `).bind(battleId).run();

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
	    if (battle.winner_crew_id !== winnerCrewId) {
        throw new Error('Winner differs from the recorded settlement');
      }
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
	  async refundContributions({
    battleId,
    moderatorId = 'system',
    reason = 'Crew Battle cancelled',
  }) {
    battleId = requireText(battleId, 'Battle ID');
    reason = requireText(reason, 'Refund reason');

    const battle = await this.db.prepare(`
      SELECT *
      FROM crew_battles
      WHERE id = ?
    `).bind(battleId).first();

    if (!battle) throw new Error('Crew Battle not found');

    if (battle.financial_status === 'refunded') {
      return { refunded: true, already_refunded: true };
    }

    if (battle.financial_status === 'settled') {
      throw new Error('A settled Crew Battle cannot be refunded');
    }

    if (!['funded', 'refunding'].includes(battle.financial_status)) {
      throw new Error('Crew Battle is not ready for refunds');
    }

    const currencyCode = validateCurrencyCode(battle.currency_code);
    const poolMinor = battle.prize_pool_minor;

    assertSafeMinorUnits(poolMinor);

    if (poolMinor <= 0) {
      throw new Error('Crew Battle has no funded prize pool');
    }

	  const refundClaim = await this.db.prepare(`
      UPDATE crew_battles
      SET financial_status = 'refunding'
      WHERE id = ?
        AND financial_status = 'funded'
    `).bind(battleId).run();

    if (
      refundClaim.meta?.changes !== 1 &&
      battle.financial_status !== 'refunding'
    ) {
      throw new Error('Crew Battle refund is already being processed');
	}

    const terminal = await this.db.prepare(`
      SELECT outcome, ledger_transaction_id
      FROM financial_escrow_terminal_operations
      WHERE escrow_type = 'CREW_BATTLE'
        AND escrow_id = ?
    `).bind(battleId).first();

    if (terminal) {
      if (terminal.outcome !== 'refund') {
        throw new Error('Crew Battle escrow already has a settlement outcome');
      }

      await this.db.prepare(`
        UPDATE crew_battles
        SET financial_status = 'refunded',
            status = 'cancelled'
        WHERE id = ?
          AND financial_status = 'refunding'
      `).bind(battleId).run();

      return {
        refunded: true,
        already_refunded: true,
        ledger_transaction_id: terminal.ledger_transaction_id,
      };
    }

    const { results: contributions } = await this.db.prepare(`
      SELECT *
      FROM crew_battle_financial_operations
      WHERE battle_id = ?
        AND operation_type IN ('challenger_funding', 'target_funding')
        AND status = 'posted'
      ORDER BY operation_type
    `).bind(battleId).all();

    if (contributions.length < 1 || contributions.length > 2) {
  throw new Error('Crew Battle contribution records require reconciliation');
}
    let verifiedTotal = 0;
    const entries = [];

    for (const contribution of contributions) {
      if (
        contribution.owner_type !== 'user' ||
        contribution.currency_code !== currencyCode ||
        !Number.isSafeInteger(contribution.amount_minor) ||
        contribution.amount_minor <= 0
      ) {
        throw new Error('Contribution requires financial reconciliation');
      }

      verifiedTotal += contribution.amount_minor;

      if (!Number.isSafeInteger(verifiedTotal)) {
        throw new Error('Refund total exceeds safe limits');
      }

      const recipient = await this.financial.getOwnerAvailableAccount({
        ownerType: 'user',
        ownerId: contribution.owner_id,
        currencyCode,
      });

      entries.push({
        accountId: recipient.id,
        currencyCode,
        side: 'credit',
        amountMinor: contribution.amount_minor,
        description: 'Crew Battle contribution refund',
      });
    }

    if (verifiedTotal !== poolMinor) {
      throw new Error('Contribution total does not match the funded prize pool');
    }

    const escrow = await this.financial.getEscrowAccount({
      escrowType: 'CREW_BATTLE',
      escrowId: battleId,
      currencyCode,
    });

    entries.unshift({
      accountId: escrow.id,
      currencyCode,
      side: 'debit',
      amountMinor: poolMinor,
      description: 'Crew Battle escrow refund',
    });

    const idempotencyKey = `crew-battle:${battleId}:bulk-refund:v1`;
    const transactionId = crypto.randomUUID();
    const now = new Date().toISOString();

    const atomicStatements = [];

    for (const contribution of contributions) {
      const refundType = contribution.operation_type === 'challenger_funding'
        ? 'challenger_refund'
        : 'target_refund';

      const refundKey = `crew-battle:${battleId}:${refundType}:v1`;

      const existing = await this.db.prepare(`
        SELECT id, status, amount_minor, owner_id
        FROM crew_battle_financial_operations
        WHERE idempotency_key = ?
      `).bind(refundKey).first();

      if (existing) {
        if (
          existing.status !== 'pending' ||
          existing.amount_minor !== contribution.amount_minor ||
          existing.owner_id !== contribution.owner_id
        ) {
          throw new Error('Existing refund operation requires reconciliation');
        }

        throw new Error('Incomplete refund operation requires reconciliation');
      }

      atomicStatements.push(
        this.db.prepare(`
          INSERT INTO crew_battle_financial_operations (
            id, battle_id, operation_type, actor_id,
            owner_type, owner_id, currency_code,
            amount_minor, idempotency_key,
            ledger_transaction_id, status,
            metadata_json, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        `).bind(
          crypto.randomUUID(),
          battleId,
          refundType,
          moderatorId,
          contribution.owner_id,
          currencyCode,
          contribution.amount_minor,
          refundKey,
          transactionId,
          JSON.stringify({
            battle_id: battleId,
            original_operation_id: contribution.id,
            reason,
          }),
          now,
          now
        )
      );
    }

    atomicStatements.push(
      this.db.prepare(`
        INSERT INTO financial_escrow_terminal_operations (
          id, escrow_type, escrow_id, currency_code,
          outcome, ledger_transaction_id
        )
        VALUES (?, 'CREW_BATTLE', ?, ?, 'refund', ?)
      `).bind(
        crypto.randomUUID(),
        battleId,
        currencyCode,
        transactionId
      )
    );

    const result = await this.financial.ledger.postTransaction({
      transactionId,
      atomicStatements,

      atomicStatementsAfterPosting: [
        this.db.prepare(`
          UPDATE crew_battle_financial_operations
          SET status = 'posted', updated_at = ?
          WHERE battle_id = ?
            AND operation_type IN ('challenger_refund', 'target_refund')
            AND ledger_transaction_id = ?
            AND status = 'pending'
        `).bind(now, battleId, transactionId),
      ],

      idempotencyScope: 'crew-battle-bulk-refund',
      idempotencyKey,

      sourceModule: 'financial_service',
      transactionType: 'escrow_refund',

      actorType: moderatorId === 'system' ? 'system' : 'platform_admin',
      actorId: moderatorId === 'system' ? null : moderatorId,

      description: 'Refund Crew Battle contributions',
      reference: battleId,

      metadata: {
        escrow_type: 'CREW_BATTLE',
        escrow_id: battleId,
        battle_id: battleId,
        currency_code: currencyCode,
        amount_minor: poolMinor,
        reason,
      },

      entries,
    });

        const refundOperations = await this.db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE
               WHEN status = 'posted'
                 AND ledger_transaction_id = ?
               THEN 1 ELSE 0
             END) AS posted
      FROM crew_battle_financial_operations
      WHERE battle_id = ?
        AND operation_type IN ('challenger_refund', 'target_refund')
    `).bind(result.transaction.id, battleId).first();

    if (
      refundOperations.total !== contributions.length ||
      refundOperations.posted !== contributions.length
    ) {
      throw new Error('Refund ledger posted but refund operations require reconciliation');
    }

    const finalized = await this.db.prepare(`
      UPDATE crew_battles
      SET financial_status = 'refunded',
          status = 'cancelled'
      WHERE id = ?
        AND financial_status = 'refunding'
    `).bind(battleId).run();

    if (finalized.meta?.changes !== 1) {
      throw new Error('Refund posted but battle finalization requires reconciliation');
    }

    const confirmed = await this.db.prepare(`
      SELECT financial_status
      FROM crew_battles
      WHERE id = ?
    `).bind(battleId).first();

    if (confirmed?.financial_status !== 'refunded') {
      throw new Error('Refund posted but Crew Battle finalization requires reconciliation');
    }

    return {
      refunded: true,
      battle_id: battleId,
      total_refunded_minor: poolMinor,
      currency_code: currencyCode,
      ledger_transaction_id: result.transaction.id,
    };
					}
        }
