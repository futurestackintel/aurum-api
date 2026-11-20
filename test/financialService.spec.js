o99999`import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { FinancialService } from '../src/services/financialService.js';
import { LedgerService } from '../src/services/ledger.js';

const financial = new FinancialService(env.DB);
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

async function fundUser(userId, amountMinor, currencyCode = 'NGN') {
  const accounts = await financial.accounts.provisionUserAccounts(
    userId,
    currencyCode
  );

  const available = accounts.accounts.find(
    account =>
      account.account_code ===
      `USER:AVAILABLE:${userId}:${currencyCode}`
  );

  const fundingAccount = await ledger.createAccount({
    accountCode: `TEST:FUNDING:${crypto.randomUUID()}`,
    accountName: 'Test Funding Account',
    accountClass: 'asset',
    normalBalance: 'debit',
    ownerType: 'platform',
    currencyCode,
  });

  await ledger.postTransaction({
    idempotencyScope: 'financial-service-test-funding',
    idempotencyKey: crypto.randomUUID(),
    sourceModule: 'test',
    transactionType: 'test_funding',
    actorType: 'system',
    entries: [
      {
        accountId: fundingAccount.id,
        currencyCode,
        side: 'debit',
        amountMinor,
      },
      {
        accountId: available.id,
        currencyCode,
        side: 'credit',
        amountMinor,
      },
    ],
  });
}

async function getAvailableBalance(userId, currencyCode = 'NGN') {
  const result = await env.DB.prepare(`
    SELECT
      COALESCE(
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
  `).bind(
    `USER:AVAILABLE:${userId}:${currencyCode}`
  ).first();

  return result.balance;
}

beforeEach(async () => {
  await seedCurrencies();
});

describe('FinancialService internal transfers', () => {
  it('transfers funds between two users atomically', async () => {
    const sender = `sender-${crypto.randomUUID()}`;
    const recipient = `recipient-${crypto.randomUUID()}`;

    await fundUser(sender, 10000);

    const result = await financial.transferBetweenUsers({
      senderUserId: sender,
      recipientUserId: recipient,
      actorUserId: sender,
      currencyCode: 'NGN',
      amountMinor: 3500,
      idempotencyKey: crypto.randomUUID(),
    });

    expect(result.created).toBe(true);
    expect(result.transaction.status).toBe('posted');
    expect(result.transaction.entries).toHaveLength(2);

    expect(await getAvailableBalance(sender)).toBe(6500);
    expect(await getAvailableBalance(recipient)).toBe(3500);
  });

  it('does not allow a transfer that exceeds available funds', async () => {
    const sender = `sender-${crypto.randomUUID()}`;
    const recipient = `recipient-${crypto.randomUUID()}`;

    await fundUser(sender, 2000);

    await expect(
      financial.transferBetweenUsers({
        senderUserId: sender,
        recipientUserId: recipient,
        actorUserId: sender,
        currencyCode: 'NGN',
        amountMinor: 3000,
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow();

    expect(await getAvailableBalance(sender)).toBe(2000);
    expect(await getAvailableBalance(recipient)).toBe(0);
  });

  it('rejects transfers to the same user', async () => {
    const userId = `user-${crypto.randomUUID()}`;

    await expect(
      financial.transferBetweenUsers({
        senderUserId: userId,
        recipientUserId: userId,
        actorUserId: userId,
        currencyCode: 'NGN',
        amountMinor: 100,
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow('Cannot transfer funds to the same user');
  });

  it('rejects an actor who is not the sender', async () => {
    await expect(
      financial.transferBetweenUsers({
        senderUserId: 'sender-001',
        recipientUserId: 'recipient-001',
        actorUserId: 'different-user',
        currencyCode: 'NGN',
        amountMinor: 100,
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow('Actor must be the sender');
  });

  it('returns the original transaction for an identical retry', async () => {
    const sender = `sender-${crypto.randomUUID()}`;
    const recipient = `recipient-${crypto.randomUUID()}`;
    const idempotencyKey = crypto.randomUUID();

    await fundUser(sender, 5000);

    const input = {
      senderUserId: sender,
      recipientUserId: recipient,
      actorUserId: sender,
      currencyCode: 'NGN',
      amountMinor: 1500,
      idempotencyKey,
    };

    const first = await financial.transferBetweenUsers(input);
    const second = await financial.transferBetweenUsers(input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.transaction.id).toBe(first.transaction.id);

    expect(await getAvailableBalance(sender)).toBe(3500);
    expect(await getAvailableBalance(recipient)).toBe(1500);
  });

  it('keeps NGN and USD transfers separate', async () => {
    const sender = `sender-${crypto.randomUUID()}`;
    const recipient = `recipient-${crypto.randomUUID()}`;

    await fundUser(sender, 10000, 'NGN');
    await fundUser(sender, 5000, 'USD');

    await financial.transferBetweenUsers({
      senderUserId: sender,
      recipientUserId: recipient,
      actorUserId: sender,
      currencyCode: 'NGN',
      amountMinor: 2000,
      idempotencyKey: crypto.randomUUID(),
    });

    expect(await getAvailableBalance(sender, 'NGN')).toBe(8000);
    expect(await getAvailableBalance(recipient, 'NGN')).toBe(2000);

    expect(await getAvailableBalance(sender, 'USD')).toBe(5000);
    expect(await getAvailableBalance(recipient, 'USD')).toBe(0);
  });
});


describe('FinancialService escrow terminal operations', () => {
  async function fundTestEscrow({
  ownerId,
  escrowId,
  amountMinor = 5000,
  key = crypto.randomUUID(),
}) {
  await fundUser(ownerId, amountMinor);

  return financial.fundEscrow({
    ownerType: 'user',
    ownerId,
    escrowType: 'DUEL',
    escrowId,
    currencyCode: 'NGN',
    amountMinor,
    idempotencyKey: key,
  });
}
  async function getEscrowBalance(escrowId) {
    const result = await env.DB.prepare(`
      SELECT
        COALESCE(
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
    `).bind(
      `DUEL:ESCROW:${escrowId}:NGN`
    ).first();

    return result.balance;
  }

  async function getTerminalCount(escrowId) {
    const result = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM financial_escrow_terminal_operations
      WHERE escrow_type = 'DUEL'
        AND escrow_id = ?
    `).bind(escrowId).first();

    return result.total;
  }

  it('allows one settlement and rejects a second settlement or refund', async () => {
    const ownerId = `escrow-owner-${crypto.randomUUID()}`;
    const winnerId = `escrow-winner-${crypto.randomUUID()}`;
    const escrowId = `duel-${crypto.randomUUID()}`;
    const settlementKey = crypto.randomUUID();

    await fundTestEscrow({
      ownerId,
      escrowId,
      amountMinor: 5000,
    });

    await fundTestEscrow({
      ownerId,
      escrowId,
      amountMinor: 5000,
    });

    const input = {
      escrowType: 'DUEL',
      escrowId,
      currencyCode: 'NGN',
      grossAmountMinor: 5000,
      recipientType: 'user',
      recipientId: winnerId,
      idempotencyKey: settlementKey,
    };

    const first = await financial.settleEscrow(input);
    const retry = await financial.settleEscrow(input);

    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.transaction.id).toBe(first.transaction.id);

    expect(await getAvailableBalance(winnerId)).toBe(4900);
    expect(await getEscrowBalance(escrowId)).toBe(5000);
    expect(await getTerminalCount(escrowId)).toBe(1);

    await expect(
      financial.settleEscrow({
        ...input,
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow();

    await expect(
      financial.refundEscrow({
        ownerType: 'user',
        ownerId,
        escrowType: 'DUEL',
        escrowId,
        currencyCode: 'NGN',
        amountMinor: 5000,
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow();

    expect(await getAvailableBalance(winnerId)).toBe(4900);
    expect(await getEscrowBalance(escrowId)).toBe(5000);
    expect(await getTerminalCount(escrowId)).toBe(1);
  });

  it('allows one refund and rejects a second refund or settlement', async () => {
    const ownerId = `refund-owner-${crypto.randomUUID()}`;
    const winnerId = `refund-winner-${crypto.randomUUID()}`;
    const escrowId = `duel-${crypto.randomUUID()}`;

    await fundTestEscrow({
      ownerId,
      escrowId,
      amountMinor: 5000,
    });

    await fundTestEscrow({
      ownerId,
      escrowId,
      amountMinor: 5000,
    });

    const input = {
      ownerType: 'user',
      ownerId,
      escrowType: 'DUEL',
      escrowId,
      currencyCode: 'NGN',
      amountMinor: 5000,
      idempotencyKey: crypto.randomUUID(),
    };

    const first = await financial.refundEscrow(input);

    expect(first.created).toBe(true);
    expect(first.transaction.status).toBe('posted');

    expect(await getAvailableBalance(ownerId)).toBe(5000);
    expect(await getEscrowBalance(escrowId)).toBe(5000);
    expect(await getTerminalCount(escrowId)).toBe(1);

    await expect(
      financial.refundEscrow({
        ...input,
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow();

    await expect(
      financial.settleEscrow({
        escrowType: 'DUEL',
        escrowId,
        currencyCode: 'NGN',
        grossAmountMinor: 5000,
        recipientType: 'user',
        recipientId: winnerId,
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow();

    expect(await getAvailableBalance(ownerId)).toBe(5000);
    expect(await getAvailableBalance(winnerId)).toBe(0);
    expect(await getEscrowBalance(escrowId)).toBe(5000);
    expect(await getTerminalCount(escrowId)).toBe(1);
  });
});
