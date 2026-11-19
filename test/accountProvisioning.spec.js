import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { AccountProvisioningService } from '../src/services/accountProvisioning.js';
import { LedgerService } from '../src/services/ledger.js';

const provisioning = new AccountProvisioningService(env.DB);
const ledger = new LedgerService(env.DB);

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

beforeEach(async () => {
  await seedCurrencies();
});

describe('User account provisioning', () => {
  it('creates available and held accounts for a user', async () => {
    const result = await provisioning.provisionUserAccounts(
      'user-test-001',
      'NGN'
    );

    expect(result.accounts).toHaveLength(2);

    expect(result.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account_code: 'USER:AVAILABLE:user-test-001:NGN',
          account_class: 'liability',
          normal_balance: 'credit',
          owner_type: 'user',
          owner_id: 'user-test-001',
          currency_code: 'NGN',
        }),
        expect.objectContaining({
          account_code: 'USER:HELD:user-test-001:NGN',
          account_class: 'liability',
          normal_balance: 'credit',
          owner_type: 'user',
          owner_id: 'user-test-001',
          currency_code: 'NGN',
        }),
      ])
    );
  });

  it('does not create duplicate accounts when provisioning is repeated', async () => {
    const first = await provisioning.provisionUserAccounts(
      'user-test-002',
      'NGN'
    );

    const second = await provisioning.provisionUserAccounts(
      'user-test-002',
      'NGN'
    );

    expect(second.accounts.map(account => account.id))
      .toEqual(first.accounts.map(account => account.id));

    const count = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM ledger_accounts
      WHERE owner_type = 'user'
        AND owner_id = 'user-test-002'
        AND currency_code = 'NGN'
    `).first();

    expect(count.total).toBe(2);
  });

  it('creates separate accounts for different currencies', async () => {
    const ngn = await provisioning.provisionUserAccounts(
      'user-test-003',
      'NGN'
    );

    const usd = await provisioning.provisionUserAccounts(
      'user-test-003',
      'USD'
    );

    expect(ngn.accounts).toHaveLength(2);
    expect(usd.accounts).toHaveLength(2);

    expect(
      ngn.accounts.every(account => account.currency_code === 'NGN')
    ).toBe(true);

    expect(
      usd.accounts.every(account => account.currency_code === 'USD')
    ).toBe(true);
  });
});

describe('Crew account provisioning', () => {
  it('creates available and held accounts for a crew', async () => {
    const result = await provisioning.provisionCrewAccounts(
      'crew-test-001',
      'NGN'
    );

    expect(result.accounts).toHaveLength(2);

    expect(result.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account_code: 'CREW:AVAILABLE:crew-test-001:NGN',
          account_class: 'liability',
          normal_balance: 'credit',
          owner_type: 'crew',
          owner_id: 'crew-test-001',
          currency_code: 'NGN',
        }),
        expect.objectContaining({
          account_code: 'CREW:HELD:crew-test-001:NGN',
          account_class: 'liability',
          normal_balance: 'credit',
          owner_type: 'crew',
          owner_id: 'crew-test-001',
          currency_code: 'NGN',
        }),
      ])
    );
  });

  it('does not duplicate crew accounts on retry', async () => {
    const first = await provisioning.provisionCrewAccounts(
      'crew-test-002',
      'NGN'
    );

    const second = await provisioning.provisionCrewAccounts(
      'crew-test-002',
      'NGN'
    );

    expect(second.accounts.map(account => account.id))
      .toEqual(first.accounts.map(account => account.id));
  });
});

describe('Escrow account provisioning', () => {
  it.each([
    ['DUEL', 'DUEL:ESCROW:duel-001:NGN', 'duel:duel-001'],
    ['CHALLENGE', 'CHALLENGE:ESCROW:challenge-001:NGN', 'challenge:challenge-001'],
    ['CREW_BATTLE', 'CREW_BATTLE:ESCROW:battle-001:NGN', 'crew_battle:battle-001'],
  ])('creates the %s escrow account', async (
    escrowType,
    accountCode,
    ownerId
  ) => {
    const account = await provisioning.provisionEscrowAccount({
      escrowType,
      escrowId: ownerId.split(':')[1],
      currencyCode: 'NGN',
    });

    expect(account).toMatchObject({
      account_code: accountCode,
      account_class: 'liability',
      normal_balance: 'credit',
      owner_type: 'escrow',
      owner_id: ownerId,
      currency_code: 'NGN',
    });
  });

  it('rejects unsupported escrow types', async () => {
    await expect(
      provisioning.provisionEscrowAccount({
        escrowType: 'UNKNOWN',
        escrowId: 'escrow-001',
        currencyCode: 'NGN',
      })
    ).rejects.toThrow('Unsupported escrow type');
  });
});

describe('Provider and platform account provisioning', () => {
  it('creates a provider clearing asset account', async () => {
    const account = await provisioning.provisionProviderClearingAccount({
      provider: 'paystack',
      currencyCode: 'NGN',
    });

    expect(account).toMatchObject({
      account_code: 'PROVIDER:CLEARING:paystack:NGN',
      account_class: 'asset',
      normal_balance: 'debit',
      owner_type: 'provider',
      owner_id: 'paystack',
      currency_code: 'NGN',
    });
  });

  it.each([
    ['operating', 'PLATFORM:OPERATING:NGN', 'asset', 'debit'],
    ['fee_revenue', 'PLATFORM:FEE_REVENUE:NGN', 'revenue', 'credit'],
    ['expenses', 'PLATFORM:EXPENSES:NGN', 'expense', 'debit'],
    ['equity', 'PLATFORM:EQUITY:NGN', 'equity', 'credit'],
  ])('creates the platform %s account', async (
    accountType,
    accountCode,
    accountClass,
    normalBalance
  ) => {
    const account = await provisioning.provisionPlatformAccount({
      accountType,
      currencyCode: 'NGN',
    });

    expect(account).toMatchObject({
      account_code: accountCode,
      account_class: accountClass,
      normal_balance: normalBalance,
      owner_type: 'platform',
      owner_id: null,
      currency_code: 'NGN',
    });
  });

  it('rejects an unsupported platform account type', async () => {
    await expect(
      provisioning.provisionPlatformAccount({
        accountType: 'unknown',
        currencyCode: 'NGN',
      })
    ).rejects.toThrow('Unsupported platform account type');
  });
});

describe('Provisioning validation and identity protection', () => {
  it('rejects a missing user ID', async () => {
    await expect(
      provisioning.provisionUserAccounts('', 'NGN')
    ).rejects.toThrow('User ID is required');
  });

  it('rejects an invalid currency', async () => {
    await expect(
      provisioning.provisionUserAccounts('user-test-004', 'INVALID')
    ).rejects.toThrow();
  });

  it('rejects an existing account whose identity conflicts with the requested account', async () => {
    await ledger.createAccount({
      accountCode: 'USER:AVAILABLE:user-conflict:NGN',
      accountName: 'Conflicting account',
      accountClass: 'liability',
      normalBalance: 'credit',
      ownerType: 'user',
      ownerId: 'different-user',
      currencyCode: 'NGN',
    });

    await expect(
      provisioning.provisionUserAccounts(
        'user-conflict',
        'NGN'
      )
    ).rejects.toThrow(
      'Existing ledger account identity conflicts with requested account'
    );
  });
});
