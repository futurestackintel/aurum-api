import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { WithdrawalService } from '../src/services/withdrawals.js';

async function seedCurrencies() {
  await env.DB.prepare(`
    INSERT INTO financial_currencies (
      currency_code,
      minor_unit_exponent,
      is_enabled
    )
    VALUES ('NGN', 2, 1)
    ON CONFLICT(currency_code)
    DO UPDATE SET is_enabled = 1
  `).run();
}

async function createWithdrawal(status = 'processing') {
  const userId = `withdrawal-user-${crypto.randomUUID()}`;

  await env.DB.prepare(`
    INSERT INTO users (
      id,
      clerk_id,
      username,
      display_name,
      email
    )
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    userId,
    `clerk-${userId}`,
    `user-${crypto.randomUUID()}`,
    'Withdrawal Test User',
    `${userId}@example.com`
  ).run();

  const operationId = crypto.randomUUID();

  await env.DB.prepare(`
    INSERT INTO financial_payment_operations (
      id,
      user_id,
      operation_type,
      status,
      amount_minor,
      currency_code,
      provider,
      idempotency_scope,
      idempotency_key,
      request_fingerprint,
      provider_reference
    )
    VALUES (?, ?, 'withdrawal', 'reserved', 50000, 'NGN',
      'paystack', 'withdrawal-test', ?, ?, ?)
  `).bind(
    operationId,
    userId,
    operationId,
    'a'.repeat(64),
    `aurum_withdrawal_${operationId}`
  ).run();

  if (status !== 'reserved') {
    await env.DB.prepare(`
      UPDATE financial_payment_operations
      SET status = ?
      WHERE id = ?
    `).bind(status, operationId).run();
  }

  return operationId;
}

beforeEach(async () => {
  await seedCurrencies();
});

describe('WithdrawalService finalization claims', () => {
  it('creates a settlement claim for an active withdrawal', async () => {
    const operationId = await createWithdrawal();

    const service = new WithdrawalService({ DB: env.DB });

    const result = await service.claimWithdrawalFinalization(
      operationId,
      'settle'
    );

    expect(result.alreadyFinalized).toBe(false);

    const claim = await env.DB.prepare(`
      SELECT outcome
      FROM financial_withdrawal_finalization_claims
      WHERE payment_operation_id = ?
    `).bind(operationId).first();

    expect(claim.outcome).toBe('settle');
  });

	  it('allows only one outcome when settlement and release compete', async () => {
    const operationId = await createWithdrawal();

    const firstService = new WithdrawalService({ DB: env.DB });
    const secondService = new WithdrawalService({ DB: env.DB });

    const results = await Promise.allSettled([
      firstService.claimWithdrawalFinalization(
        operationId,
        'settle'
      ),
      secondService.claimWithdrawalFinalization(
        operationId,
        'release'
      ),
    ]);

    const successful = results.filter(
      result => result.status === 'fulfilled'
    );

    const rejected = results.filter(
      result => result.status === 'rejected'
    );

    expect(successful).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const claim = await env.DB.prepare(`
      SELECT outcome
      FROM financial_withdrawal_finalization_claims
      WHERE payment_operation_id = ?
    `).bind(operationId).first();

    expect(['settle', 'release']).toContain(claim.outcome);
  });

  it('allows retries with the same finalization outcome', async () => {
    const operationId = await createWithdrawal();

    const service = new WithdrawalService({ DB: env.DB });

    await service.claimWithdrawalFinalization(
      operationId,
      'settle'
    );

    const retry = await service.claimWithdrawalFinalization(
      operationId,
      'settle'
    );

    expect(retry.alreadyFinalized).toBe(false);

    const claims = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM financial_withdrawal_finalization_claims
      WHERE payment_operation_id = ?
    `).bind(operationId).first();

    expect(claims.total).toBe(1);
  });

  it('blocks release after settlement has been claimed', async () => {
    const operationId = await createWithdrawal();

    const service = new WithdrawalService({ DB: env.DB });

    await service.claimWithdrawalFinalization(
      operationId,
      'settle'
    );

    await expect(
      service.claimWithdrawalFinalization(
        operationId,
        'release'
      )
    ).rejects.toThrow(
      'Withdrawal finalization is already claimed by a different outcome'
    );
  });

  it('blocks settlement after release has been claimed', async () => {
    const operationId = await createWithdrawal();

    const service = new WithdrawalService({ DB: env.DB });

    await service.claimWithdrawalFinalization(
      operationId,
      'release'
    );

    await expect(
      service.claimWithdrawalFinalization(
        operationId,
        'settle'
      )
    ).rejects.toThrow(
      'Withdrawal finalization is already claimed by a different outcome'
    );
  });

  it('allows finalization claims for reconciliation-required withdrawals', async () => {
    const operationId = await createWithdrawal(
      'reconciliation_required'
    );

    const service = new WithdrawalService({ DB: env.DB });

    const result = await service.claimWithdrawalFinalization(
      operationId,
      'settle'
    );

    expect(result.alreadyFinalized).toBe(false);
  });

  it('rejects claims for withdrawals that are still reserved', async () => {
    const operationId = await createWithdrawal('reserved');

    const service = new WithdrawalService({ DB: env.DB });

    await expect(
      service.claimWithdrawalFinalization(
        operationId,
        'settle'
      )
    ).rejects.toThrow(
      'Withdrawal is not eligible for finalization'
    );
  });

  it('prevents modification of an existing finalization claim', async () => {
    const operationId = await createWithdrawal();

    const service = new WithdrawalService({ DB: env.DB });

    await service.claimWithdrawalFinalization(
      operationId,
      'settle'
    );

    await expect(
      env.DB.prepare(`
        UPDATE financial_withdrawal_finalization_claims
        SET outcome = 'release'
        WHERE payment_operation_id = ?
      `).bind(operationId).run()
    ).rejects.toThrow();
  });

  it('prevents deletion of finalization evidence', async () => {
    const operationId = await createWithdrawal();

    const service = new WithdrawalService({ DB: env.DB });

    await service.claimWithdrawalFinalization(
      operationId,
      'settle'
    );

    await expect(
      env.DB.prepare(`
        DELETE FROM financial_withdrawal_finalization_claims
        WHERE payment_operation_id = ?
      `).bind(operationId).run()
    ).rejects.toThrow();
  });
});
