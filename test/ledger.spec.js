import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { LedgerService } from '../src/services/ledger.js';

const service = new LedgerService(env.DB);

async function seedCurrencies() {
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO financial_currencies (
        currency_code,
        minor_unit_exponent,
        is_enabled
      )
      VALUES ('NGN', 2, 1)
      ON CONFLICT(currency_code)
      DO UPDATE SET is_enabled = 1
    `),
    env.DB.prepare(`
      INSERT INTO financial_currencies (
        currency_code,
        minor_unit_exponent,
        is_enabled
      )
      VALUES ('USD', 2, 1)
      ON CONFLICT(currency_code)
      DO UPDATE SET is_enabled = 1
    `),
  ]);
}

async function createAccount({
  accountClass = 'asset',
  currencyCode = 'NGN',
  status = 'active',
} = {}) {
  const normalBalance = {
    asset: 'debit',
    expense: 'debit',
    liability: 'credit',
    equity: 'credit',
    revenue: 'credit',
  }[accountClass];

  const account = await service.createAccount({
    accountCode: `TEST-${crypto.randomUUID()}`,
    accountName: 'Ledger test account',
    accountClass,
    normalBalance,
    ownerType: 'platform',
    currencyCode,
  });

  if (status !== 'active') {
    await env.DB.prepare(`
      UPDATE ledger_accounts
      SET status = ?
      WHERE id = ?
    `).bind(status, account.id).run();
  }

  return account;
}

async function createBalancedAccounts(currencyCode = 'NGN') {
  const debitAccount = await createAccount({
    accountClass: 'asset',
    currencyCode,
  });

  const creditAccount = await createAccount({
    accountClass: 'liability',
    currencyCode,
  });

  return { debitAccount, creditAccount };
}

function transactionInput({
  debitAccount,
  creditAccount,
  amountMinor = 10000,
  idempotencyKey = crypto.randomUUID(),
  entries,
} = {}) {
  return {
    idempotencyScope: 'ledger-test',
    idempotencyKey,
    sourceModule: 'test',
    transactionType: 'test_transfer',
    actorType: 'system',
    description: 'Ledger service test transaction',
    entries: entries || [
      {
        accountId: debitAccount.id,
        currencyCode: debitAccount.currency_code,
        side: 'debit',
        amountMinor,
      },
      {
        accountId: creditAccount.id,
        currencyCode: creditAccount.currency_code,
        side: 'credit',
        amountMinor,
      },
    ],
  };
}

beforeEach(async () => {
  await seedCurrencies();
});

describe('LedgerService account creation', () => {
  it('creates an account using an enabled currency', async () => {
    const account = await createAccount();

    expect(account).toBeTruthy();
    expect(account.account_class).toBe('asset');
    expect(account.normal_balance).toBe('debit');
    expect(account.currency_code).toBe('NGN');
    expect(account.status).toBe('active');
  });

  it('rejects an invalid natural balance', async () => {
    await expect(
      service.createAccount({
        accountCode: `INVALID-${crypto.randomUUID()}`,
        accountName: 'Invalid account',
        accountClass: 'asset',
        normalBalance: 'credit',
        ownerType: 'platform',
        currencyCode: 'NGN',
      })
    ).rejects.toThrow(
      'Normal balance does not match the ledger account class'
    );
  });

  it('rejects a currency that is not enabled', async () => {
    await env.DB.prepare(`
      UPDATE financial_currencies
      SET is_enabled = 0
      WHERE currency_code = 'NGN'
    `).run();

    await expect(createAccount()).rejects.toThrow(
      'Currency is missing or not enabled'
    );
  });
});

describe('LedgerService transaction posting', () => {
  it('posts a balanced transaction', async () => {
    const { debitAccount, creditAccount } =
      await createBalancedAccounts();

    const result = await service.postTransaction(
      transactionInput({
        debitAccount,
        creditAccount,
      })
    );

    expect(result.created).toBe(true);
    expect(result.transaction.status).toBe('posted');
    expect(result.transaction.entries).toHaveLength(2);

    expect(result.transaction.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account_id: debitAccount.id,
          entry_side: 'debit',
          amount_minor: 10000,
        }),
        expect.objectContaining({
          account_id: creditAccount.id,
          entry_side: 'credit',
          amount_minor: 10000,
        }),
      ])
    );
  });

  it('rejects an unbalanced transaction before writing', async () => {
    const { debitAccount, creditAccount } =
      await createBalancedAccounts();

    const input = transactionInput({
      debitAccount,
      creditAccount,
    });

    input.entries[1].amountMinor = 9000;

    await expect(
      service.postTransaction(input)
    ).rejects.toThrow('Ledger transaction is not balanced');

    const count = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM ledger_transactions
      WHERE idempotency_key = ?
    `).bind(input.idempotencyKey).first();

    expect(count.total).toBe(0);
  });

  it('balances each currency independently', async () => {
    const ngn = await createBalancedAccounts('NGN');
    const usd = await createBalancedAccounts('USD');

    const result = await service.postTransaction(
      transactionInput({
        entries: [
          {
            accountId: ngn.debitAccount.id,
            currencyCode: 'NGN',
            side: 'debit',
            amountMinor: 50000,
          },
          {
            accountId: ngn.creditAccount.id,
            currencyCode: 'NGN',
            side: 'credit',
            amountMinor: 50000,
          },
          {
            accountId: usd.debitAccount.id,
            currencyCode: 'USD',
            side: 'debit',
            amountMinor: 2500,
          },
          {
            accountId: usd.creditAccount.id,
            currencyCode: 'USD',
            side: 'credit',
            amountMinor: 2500,
          },
        ],
      })
    );

    expect(result.created).toBe(true);
    expect(result.transaction.status).toBe('posted');
    expect(result.transaction.entries).toHaveLength(4);
  });

  it('rejects entries whose currency does not match their account', async () => {
    const { debitAccount, creditAccount } =
      await createBalancedAccounts('NGN');

    const input = transactionInput({
      debitAccount,
      creditAccount,
    });

    input.entries[0].currencyCode = 'USD';

            await expect(
      service.postTransaction(input)
    ).rejects.toThrow(
      'Entry currency does not match account'
    );
  });

  it('rejects posting to a frozen account', async () => {
    const debitAccount = await createAccount({
      status: 'frozen',
    });

    const creditAccount = await createAccount({
      accountClass: 'liability',
    });

    await expect(
      service.postTransaction(
        transactionInput({
          debitAccount,
          creditAccount,
        })
      )
    ).rejects.toThrow('Ledger account is not active');
  });
});

describe('LedgerService atomicity and idempotency', () => {
  it('rolls back the entire posting batch when an entry insert fails', async () => {
    const { debitAccount, creditAccount } =
      await createBalancedAccounts();

    const input = transactionInput({
      debitAccount,
      creditAccount,
      amountMinor: 7777,
    });

    await env.DB.prepare(`
      CREATE TRIGGER fail_test_ledger_entry
      BEFORE INSERT ON ledger_entries
      WHEN NEW.amount_minor = 7777
      BEGIN
        SELECT RAISE(ABORT, 'Intentional ledger test failure');
      END
    `).run();

    try {
      await expect(
        service.postTransaction(input)
      ).rejects.toThrow();
    } finally {
      await env.DB.prepare(`
        DROP TRIGGER IF EXISTS fail_test_ledger_entry
      `).run();
    }

    const transactionCount = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM ledger_transactions
      WHERE idempotency_key = ?
    `).bind(input.idempotencyKey).first();

    const entryCount = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM ledger_entries
      WHERE transaction_id IN (
        SELECT id
        FROM ledger_transactions
        WHERE idempotency_key = ?
      )
    `).bind(input.idempotencyKey).first();

    expect(transactionCount.total).toBe(0);
    expect(entryCount.total).toBe(0);
  });

  it('returns the original transaction for an identical idempotent retry', async () => {
    const { debitAccount, creditAccount } =
      await createBalancedAccounts();

    const input = transactionInput({
      debitAccount,
      creditAccount,
    });

    const first = await service.postTransaction(input);
    const second = await service.postTransaction(input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.transaction.id).toBe(first.transaction.id);
  });

  it('rejects reuse of an idempotency key with different transaction data', async () => {
    const { debitAccount, creditAccount } =
      await createBalancedAccounts();

    const input = transactionInput({
      debitAccount,
      creditAccount,
      amountMinor: 10000,
    });

    await service.postTransaction(input);

    const alteredInput = {
      ...input,
      entries: input.entries.map(entry => ({
        ...entry,
        amountMinor: 20000,
      })),
    };

    await expect(
      service.postTransaction(alteredInput)
    ).rejects.toThrow(
      'Idempotency key was already used for different transaction data'
    );
  });
});

describe('LedgerService reversals', () => {
  it('creates an exact reversal of a posted transaction', async () => {
    const { debitAccount, creditAccount } =
      await createBalancedAccounts();

    const original = await service.postTransaction(
      transactionInput({
        debitAccount,
        creditAccount,
      })
    );

    const reversal = await service.reverseTransaction({
      transactionId: original.transaction.id,
      idempotencyScope: 'ledger-test-reversal',
      idempotencyKey: crypto.randomUUID(),
      actorType: 'system',
      reason: 'Test reversal',
    });

    expect(reversal.created).toBe(true);
    expect(reversal.transaction.status).toBe('posted');
    expect(
      reversal.transaction.reversal_of_transaction_id
    ).toBe(original.transaction.id);

    expect(reversal.transaction.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account_id: debitAccount.id,
          entry_side: 'credit',
          amount_minor: 10000,
        }),
        expect.objectContaining({
          account_id: creditAccount.id,
          entry_side: 'debit',
          amount_minor: 10000,
        }),
      ])
    );
  });

  it('allows reversal when the original accounts are frozen', async () => {
    const { debitAccount, creditAccount } =
      await createBalancedAccounts();

    const original = await service.postTransaction(
      transactionInput({
        debitAccount,
        creditAccount,
      })
    );

    await env.DB.batch([
      env.DB.prepare(`
        UPDATE ledger_accounts
        SET status = 'frozen'
        WHERE id = ?
      `).bind(debitAccount.id),
      env.DB.prepare(`
        UPDATE ledger_accounts
        SET status = 'frozen'
        WHERE id = ?
      `).bind(creditAccount.id),
    ]);

    const reversal = await service.reverseTransaction({
      transactionId: original.transaction.id,
      idempotencyScope: 'ledger-test-frozen-reversal',
      idempotencyKey: crypto.randomUUID(),
      actorType: 'system',
      reason: 'Frozen account reversal test',
    });

    expect(reversal.created).toBe(true);
    expect(reversal.transaction.status).toBe('posted');
  });

  it('rejects a second reversal of the same transaction', async () => {
    const { debitAccount, creditAccount } =
      await createBalancedAccounts();

    const original = await service.postTransaction(
      transactionInput({
        debitAccount,
        creditAccount,
      })
    );

    await service.reverseTransaction({
      transactionId: original.transaction.id,
      idempotencyScope: 'ledger-test-double-reversal',
      idempotencyKey: crypto.randomUUID(),
      actorType: 'system',
      reason: 'First reversal',
    });

    await expect(
      service.reverseTransaction({
        transactionId: original.transaction.id,
        idempotencyScope: 'ledger-test-double-reversal',
        idempotencyKey: crypto.randomUUID(),
        actorType: 'system',
        reason: 'Second reversal',
      })
    ).rejects.toThrow();
  });
});

describe('LedgerService negative liability protection', () => {
  async function createLiabilityAccount() {
    return createAccount({
      accountClass: 'liability',
    });
  }

  async function createAssetAccount() {
    return createAccount({
      accountClass: 'asset',
    });
  }

  async function postLiabilityCredit({
    liabilityAccount,
    amountMinor,
  }) {
    const assetAccount = await createAssetAccount();

    return service.postTransaction(
      transactionInput({
        entries: [
          {
            accountId: assetAccount.id,
            currencyCode: 'NGN',
            side: 'debit',
            amountMinor,
          },
          {
            accountId: liabilityAccount.id,
            currencyCode: 'NGN',
            side: 'credit',
            amountMinor,
          },
        ],
      })
    );
  }

  async function postLiabilityDebit({
    liabilityAccount,
    amountMinor,
  }) {
    const assetAccount = await createAssetAccount();

    return service.postTransaction(
      transactionInput({
        entries: [
          {
            accountId: liabilityAccount.id,
            currencyCode: 'NGN',
            side: 'debit',
            amountMinor,
          },
          {
            accountId: assetAccount.id,
            currencyCode: 'NGN',
            side: 'credit',
            amountMinor,
          },
        ],
      })
    );
  }

  it('rejects debiting a liability account with zero balance', async () => {
    const liabilityAccount = await createLiabilityAccount();

    await expect(
      postLiabilityDebit({
        liabilityAccount,
        amountMinor: 1,
      })
    ).rejects.toThrow(
      'Transaction would create a negative liability account balance'
    );
  });

  it('allows a liability account to reach exactly zero', async () => {
    const liabilityAccount = await createLiabilityAccount();

    await postLiabilityCredit({
      liabilityAccount,
      amountMinor: 5000,
    });

    const result = await postLiabilityDebit({
      liabilityAccount,
      amountMinor: 5000,
    });

    expect(result.created).toBe(true);
    expect(result.transaction.status).toBe('posted');
  });

  it('rejects spending beyond the available liability balance', async () => {
    const liabilityAccount = await createLiabilityAccount();

    await postLiabilityCredit({
      liabilityAccount,
      amountMinor: 5000,
    });

    await postLiabilityDebit({
      liabilityAccount,
      amountMinor: 4000,
    });

    await expect(
      postLiabilityDebit({
        liabilityAccount,
        amountMinor: 1001,
      })
    ).rejects.toThrow(
      'Transaction would create a negative liability account balance'
    );
  });

  it('rejects reversing a credit after the credited funds have been spent', async () => {
    const liabilityAccount = await createLiabilityAccount();

    const deposit = await postLiabilityCredit({
      liabilityAccount,
      amountMinor: 5000,
    });

    await postLiabilityDebit({
      liabilityAccount,
      amountMinor: 5000,
    });

    await expect(
      service.reverseTransaction({
        transactionId: deposit.transaction.id,
        idempotencyScope: 'ledger-negative-balance-reversal',
        idempotencyKey: crypto.randomUUID(),
        actorType: 'system',
        reason: 'Negative balance protection test',
      })
    ).rejects.toThrow(
      'Transaction would create a negative liability account balance'
    );
  });
});
