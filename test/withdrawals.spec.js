import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WithdrawalService } from '../src/services/withdrawals.js';
import { AccountProvisioningService } from '../src/services/accountProvisioning.js';
import { LedgerService } from '../src/services/ledger.js';
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

async function createFundedUserWallet(amountMinor = 100000) {
  const userId = `withdrawal-funded-${crypto.randomUUID()}`;

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
    'Funded Withdrawal User',
    `${userId}@example.com`
  ).run();

  const accounts = new AccountProvisioningService(env.DB);
  const ledger = new LedgerService(env.DB);

  const userAccounts = await accounts.provisionUserAccounts(
    userId,
    'NGN'
  );

  const availableAccount = userAccounts.accounts.find(
    account => account.account_code ===
      `USER:AVAILABLE:${userId}:NGN`
  );

  const operatingAccount = await accounts.provisionPlatformAccount({
    accountType: 'operating',
    currencyCode: 'NGN',
  });

  await ledger.postTransaction({
    idempotencyScope: 'withdrawal-test-funding',
    idempotencyKey: userId,
    sourceModule: 'withdrawal_test',
    transactionType: 'test_wallet_funding',
    actorType: 'system',
    description: 'Fund withdrawal test wallet',
    entries: [
      {
        accountId: operatingAccount.id,
        currencyCode: 'NGN',
        side: 'debit',
        amountMinor,
      },
      {
        accountId: availableAccount.id,
        currencyCode: 'NGN',
        side: 'credit',
        amountMinor,
      },
    ],
  });

  return userId;
}

async function getAccountBalance(accountCode) {
  const result = await env.DB.prepare(`
    SELECT COALESCE(
      SUM(
        CASE
          WHEN entries.entry_side = 'credit'
          THEN entries.amount_minor
          ELSE -entries.amount_minor
        END
      ),
      0
    ) AS balance
    FROM ledger_entries AS entries
    JOIN ledger_accounts AS accounts
      ON accounts.id = entries.account_id
    JOIN ledger_transactions AS transactions
      ON transactions.id = entries.transaction_id
    WHERE accounts.account_code = ?
      AND transactions.status = 'posted'
  `).bind(accountCode).first();

  return result.balance;
}

function createWithdrawalPayments(status = 'success') {
  return {
    assertCurrencySupported: vi.fn(() => true),

    createTransferRecipient: vi.fn(async () => ({
      recipient_code: 'RCP_TEST_123',
    })),

    createTransfer: vi.fn(async ({
      reference,
      amountMinor,
      currencyCode,
    }) => ({
      reference,
      amountMinor,
      currencyCode,
      transferCode: 'TRF_TEST_123',
    })),

    verifyTransfer: vi.fn(async reference => ({
      reference,
      amountMinor: 25000,
      currencyCode: 'NGN',
      status,
    })),
  };
}

beforeEach(async () => {
  await seedCurrencies();
});

describe('WithdrawalService finalization claims', () => {
  it('creates a settlement claim for an active withdrawal', async () => {
    const operationId = await createWithdrawal();

    const service = new WithdrawalService(
  { DB: env.DB },
  { payments: createWithdrawalPayments() }
);

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

    const firstService = new WithdrawalService(
  { DB: env.DB },
  { payments: createWithdrawalPayments() }
);

const secondService = new WithdrawalService(
  { DB: env.DB },
  { payments: createWithdrawalPayments() }
);

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

    const service = new WithdrawalService(
  { DB: env.DB },
  { payments: createWithdrawalPayments() }
);

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

    const service = new WithdrawalService(
  { DB: env.DB },
  { payments: createWithdrawalPayments() }
);

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

    const service = new WithdrawalService(
  { DB: env.DB },
  { payments: createWithdrawalPayments() }
);

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

    const service = new WithdrawalService(
  { DB: env.DB },
  { payments: createWithdrawalPayments() }
);

    const result = await service.claimWithdrawalFinalization(
      operationId,
      'settle'
    );

    expect(result.alreadyFinalized).toBe(false);
  });

  it('rejects claims for withdrawals that are still reserved', async () => {
    const operationId = await createWithdrawal('reserved');

    const service = new WithdrawalService(
  { DB: env.DB },
  { payments: createWithdrawalPayments() }
);

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

    const service = new WithdrawalService(
  { DB: env.DB },
  { payments: createWithdrawalPayments() }
);

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

    const service = new WithdrawalService(
  { DB: env.DB },
  { payments: createWithdrawalPayments() }
);

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

describe('WithdrawalService ledger integration', () => {
  it('reserves and settles a successful withdrawal exactly once', async () => {
    const userId = await createFundedUserWallet();
    const payments = createWithdrawalPayments('success');

    const service = new WithdrawalService(
      {
        DB: env.DB,
        PAYMENT_PROVIDER: 'paystack',
      },
      { payments }
    );

    const idempotencyKey = crypto.randomUUID();

    const input = {
      userId,
      amountMinor: 25000,
      currencyCode: 'NGN',
      idempotencyKey,
      bankDetails: {
        account_name: 'Test Account',
        account_number: '0123456789',
        bank_code: '058',
      },
    };

    const first = await service.initiateWithdrawal(input);

    expect(first.status).toBe('succeeded');

    expect(await getAccountBalance(
      `USER:AVAILABLE:${userId}:NGN`
    )).toBe(75000);

    expect(await getAccountBalance(
      `USER:HELD:${userId}:NGN`
    )).toBe(0);

    const retry = await service.initiateWithdrawal(input);

    expect(retry.operationId).toBe(first.operationId);
    expect(retry.alreadyCreated).toBe(true);
    expect(retry.status).toBe('succeeded');

    expect(payments.createTransfer).toHaveBeenCalledOnce();
    expect(payments.createTransferRecipient).toHaveBeenCalledOnce();

    const settlements = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM ledger_transactions
      WHERE idempotency_scope = 'wallet-withdrawal-settlement'
        AND idempotency_key = ?
    `).bind(first.operationId).first();

    const reservations = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM ledger_transactions
      WHERE idempotency_scope = 'wallet-withdrawal-reservation'
        AND idempotency_key = ?
    `).bind(first.operationId).first();

    expect(settlements.total).toBe(1);
    expect(reservations.total).toBe(1);
  });

  it('releases reserved funds after a verified failed withdrawal', async () => {
    const userId = await createFundedUserWallet();
    const payments = createWithdrawalPayments('failed');

    const service = new WithdrawalService(
      {
        DB: env.DB,
        PAYMENT_PROVIDER: 'paystack',
      },
      { payments }
    );

    const result = await service.initiateWithdrawal({
      userId,
      amountMinor: 25000,
      currencyCode: 'NGN',
      idempotencyKey: crypto.randomUUID(),
      bankDetails: {
        account_name: 'Test Account',
        account_number: '0123456789',
        bank_code: '058',
      },
    });

    expect(result.status).toBe('failed');
    expect(result.fundsReleased).toBe(true);

    expect(await getAccountBalance(
      `USER:AVAILABLE:${userId}:NGN`
    )).toBe(100000);

    expect(await getAccountBalance(
      `USER:HELD:${userId}:NGN`
    )).toBe(0);

    const releases = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM ledger_transactions
      WHERE idempotency_scope = 'wallet-withdrawal-release'
        AND idempotency_key = ?
    `).bind(result.operationId).first();

    expect(releases.total).toBe(1);
  });
});
