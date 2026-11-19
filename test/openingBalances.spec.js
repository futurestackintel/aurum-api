
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { OpeningBalanceService } from '../src/services/openingBalances.js';
import { LedgerService } from '../src/services/ledger.js';

const service = new OpeningBalanceService(env.DB);
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

async function createBatch(creatorId = 'creator-001') {
  return service.createBatch({
    sourceScope: 'legacy-wallet-audit',
    createdByType: 'platform_admin',
    createdById: creatorId,
  });
}

async function addPendingItem(batchId, overrides = {}) {
  return service.addItem({
    batchId,
    sourceTable: 'wallets',
    sourceRecordId: crypto.randomUUID(),
    sourceAmountText: '125.50',
    sourceCurrencyCode: 'NGN',
    ...overrides,
  });
}

async function createAccount(currencyCode = 'NGN') {
  return ledger.createAccount({
    accountCode: `OPENING-TEST:${crypto.randomUUID()}`,
    accountName: 'Opening balance test account',
    accountClass: 'liability',
    normalBalance: 'credit',
    ownerType: 'platform',
    ownerId: null,
    currencyCode,
  });
}

async function verifyItem(batchId, overrides = {}) {
  const account = await createAccount('NGN');
  const result = await addPendingItem(batchId);

  const item = result.items[result.items.length - 1];

  return service.verifyItem({
    itemId: item.id,
    accountId: account.id,
    currencyCode: 'NGN',
    openingSide: 'credit',
    amountMinor: 12550,
    verifiedByType: 'platform_admin',
    verifiedById: 'verifier-001',
    verificationNote: 'Verified against source evidence.',
    ...overrides,
  });
}

beforeEach(async () => {
  await seedCurrencies();
});

describe('OpeningBalanceService validation', () => {
  it('rejects a missing database binding', () => {
    expect(() => new OpeningBalanceService(null))
      .toThrow('A D1 database binding is required');
  });

  it('rejects an invalid creator type', async () => {
    await expect(service.createBatch({
      sourceScope: 'legacy-wallet-audit',
      createdByType: 'unauthorized',
      createdById: 'creator-001',
    })).rejects.toThrow('Invalid creator type');
  });

  it('rejects a blank source scope', async () => {
    await expect(service.createBatch({
      sourceScope: ' ',
      createdByType: 'platform_admin',
      createdById: 'creator-001',
    })).rejects.toThrow('Source scope is required');
  });

  it('creates a draft batch with creator evidence', async () => {
    const batch = await createBatch();

    expect(batch).toMatchObject({
      status: 'draft',
      source_scope: 'legacy-wallet-audit',
      created_by_type: 'platform_admin',
      created_by_id: 'creator-001',
      items: [],
    });
  });
});

describe('Opening-balance evidence staging', () => {
  it('preserves the original source amount and claimed currency', async () => {
    const batch = await createBatch();

    const result = await service.addItem({
      batchId: batch.id,
      sourceTable: 'wallets',
      sourceRecordId: 'wallet-source-001',
      sourceAmountText: '00125.5000',
      sourceCurrencyCode: 'usd',
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      source_table: 'wallets',
      source_record_id: 'wallet-source-001',
      source_amount_text: '00125.5000',
      source_currency_code: 'usd',
      item_status: 'pending',
      account_id: null,
      amount_minor: null,
    });
  });

  it('rejects the same source record in another batch', async () => {
    const first = await createBatch();
    const second = await createBatch('creator-002');

    await service.addItem({
      batchId: first.id,
      sourceTable: 'wallets',
      sourceRecordId: 'globally-unique-wallet-001',
      sourceAmountText: '100.00',
      sourceCurrencyCode: 'NGN',
    });

    await expect(service.addItem({
      batchId: second.id,
      sourceTable: 'wallets',
      sourceRecordId: 'globally-unique-wallet-001',
      sourceAmountText: '100.00',
      sourceCurrencyCode: 'NGN',
    })).rejects.toThrow();
  });

  it('rejects adding an item to a reviewed batch', async () => {
    const batch = await createBatch();
    await verifyItem(batch.id);

    await service.reviewBatch({
      batchId: batch.id,
      reviewedByType: 'platform_admin',
      reviewedById: 'reviewer-001',
    });

    await expect(addPendingItem(batch.id))
      .rejects.toThrow('Opening-balance batch is not editable');
  });

  it('returns null for an unknown batch', async () => {
    await expect(service.getBatch('missing-batch'))
      .resolves.toBeNull();
  });
});

describe('Opening-balance item verification', () => {
  it('verifies an item and stores its account and reviewer evidence', async () => {
    const batch = await createBatch();
    const account = await createAccount('NGN');
    const staged = await addPendingItem(batch.id);
    const item = staged.items[0];

    const result = await service.verifyItem({
      itemId: item.id,
      accountId: account.id,
      currencyCode: 'NGN',
      openingSide: 'credit',
      amountMinor: 12550,
      verifiedByType: 'platform_admin',
      verifiedById: 'verifier-001',
      verificationNote: 'Matched against verified source records.',
    });

    expect(result.items[0]).toMatchObject({
      id: item.id,
      item_status: 'verified',
      account_id: account.id,
      currency_code: 'NGN',
      opening_side: 'credit',
      amount_minor: 12550,
      verified_by_type: 'platform_admin',
      verified_by_id: 'verifier-001',
      verification_note: 'Matched against verified source records.',
    });

    expect(result.items[0].verified_at).toBeTruthy();
  });

  it('rejects a source currency that does not match the verified currency', async () => {
    const batch = await createBatch();
    const account = await createAccount('NGN');
    const staged = await addPendingItem(batch.id, {
      sourceRecordId: 'currency-mismatch-001',
      sourceCurrencyCode: 'USD',
    });

    await expect(service.verifyItem({
      itemId: staged.items[0].id,
      accountId: account.id,
      currencyCode: 'NGN',
      openingSide: 'credit',
      amountMinor: 10000,
      verifiedByType: 'platform_admin',
      verifiedById: 'verifier-001',
      verificationNote: 'Test currency mismatch.',
    })).rejects.toThrow(
      'Source currency must match the verified ledger currency'
    );
  });

  it('rejects a ledger account with a different currency', async () => {
    const batch = await createBatch();
    const account = await createAccount('USD');
    const staged = await addPendingItem(batch.id);

    await expect(service.verifyItem({
      itemId: staged.items[0].id,
      accountId: account.id,
      currencyCode: 'NGN',
      openingSide: 'credit',
      amountMinor: 10000,
      verifiedByType: 'platform_admin',
      verifiedById: 'verifier-001',
      verificationNote: 'Test account currency mismatch.',
    })).rejects.toThrow('Ledger account currency mismatch');
  });

  it('rejects a non-positive or unsafe amount', async () => {
    const batch = await createBatch();
    const account = await createAccount('NGN');
    const staged = await addPendingItem(batch.id);

    await expect(service.verifyItem({
      itemId: staged.items[0].id,
      accountId: account.id,
      currencyCode: 'NGN',
      openingSide: 'credit',
      amountMinor: 0,
      verifiedByType: 'platform_admin',
      verifiedById: 'verifier-001',
      verificationNote: 'Invalid amount test.',
    })).rejects.toThrow(
      'Opening balance must be a positive safe integer'
    );
  });

  it('rejects a missing verification note', async () => {
    const batch = await createBatch();
    const account = await createAccount('NGN');
    const staged = await addPendingItem(batch.id);

    await expect(service.verifyItem({
      itemId: staged.items[0].id,
      accountId: account.id,
      currencyCode: 'NGN',
      openingSide: 'credit',
      amountMinor: 10000,
      verifiedByType: 'platform_admin',
      verifiedById: 'verifier-001',
      verificationNote: ' ',
    })).rejects.toThrow('Verification note is required');
  });

  it('does not verify an item twice', async () => {
    const batch = await createBatch();
    const account = await createAccount('NGN');
    const staged = await addPendingItem(batch.id);

    const input = {
      itemId: staged.items[0].id,
      accountId: account.id,
      currencyCode: 'NGN',
      openingSide: 'credit',
      amountMinor: 10000,
      verifiedByType: 'platform_admin',
      verifiedById: 'verifier-001',
      verificationNote: 'Verified once.',
    };

    await service.verifyItem(input);

    await expect(service.verifyItem(input))
      .rejects.toThrow('Only pending items can be verified');
  });
});

describe('Opening-balance item classification', () => {
  it.each(['disputed', 'excluded'])(
    'classifies a pending item as %s',
    async itemStatus => {
      const batch = await createBatch();
      const staged = await addPendingItem(batch.id);

      const result = await service.classifyItem({
        itemId: staged.items[0].id,
        itemStatus,
        verificationNote: `Classified as ${itemStatus}.`,
      });

      expect(result.items[0]).toMatchObject({
        id: staged.items[0].id,
        item_status: itemStatus,
        verification_note: `Classified as ${itemStatus}.`,
      });
    }
  );

  it('rejects an unsupported classification', async () => {
    const batch = await createBatch();
    const staged = await addPendingItem(batch.id);

    await expect(service.classifyItem({
      itemId: staged.items[0].id,
      itemStatus: 'approved',
      verificationNote: 'Invalid classification.',
    })).rejects.toThrow('Invalid opening-balance item classification');
  });

  it('rejects classification without a note', async () => {
    const batch = await createBatch();
    const staged = await addPendingItem(batch.id);

    await expect(service.classifyItem({
      itemId: staged.items[0].id,
      itemStatus: 'excluded',
      verificationNote: ' ',
    })).rejects.toThrow('A classification note is required');
  });
});

describe('Opening-balance batch review and approval', () => {
  it('prevents the creator from reviewing their own batch', async () => {
    const batch = await createBatch('same-person');

    await verifyItem(batch.id);

    await expect(service.reviewBatch({
      batchId: batch.id,
      reviewedByType: 'platform_admin',
      reviewedById: 'same-person',
    })).rejects.toThrow('Batch creator cannot review their own batch');
  });

  it('rejects an empty batch', async () => {
    const batch = await createBatch();

    await expect(service.reviewBatch({
      batchId: batch.id,
      reviewedByType: 'platform_admin',
      reviewedById: 'reviewer-001',
    })).rejects.toThrow('Cannot review an empty opening-balance batch');
  });

  it('rejects a batch containing unclassified items', async () => {
    const batch = await createBatch();
    await addPendingItem(batch.id);

    await expect(service.reviewBatch({
      batchId: batch.id,
      reviewedByType: 'platform_admin',
      reviewedById: 'reviewer-001',
    })).rejects.toThrow('Every item must be classified before review');
  });

  it('stores accurate counts and reviewer evidence', async () => {
    const batch = await createBatch();

    await verifyItem(batch.id);
    const disputed = await addPendingItem(batch.id);
    await service.classifyItem({
      itemId: disputed.items[1].id,
      itemStatus: 'disputed',
      verificationNote: 'Source currency requires investigation.',
    });

    const excluded = await addPendingItem(batch.id);
    await service.classifyItem({
      itemId: excluded.items[2].id,
      itemStatus: 'excluded',
      verificationNote: 'Not a customer cash balance.',
    });

    const result = await service.reviewBatch({
      batchId: batch.id,
      reviewedByType: 'platform_admin',
      reviewedById: 'reviewer-001',
    });

    expect(result).toMatchObject({
      status: 'reviewed',
      total_items: 3,
      verified_items: 1,
      disputed_items: 1,
      excluded_items: 1,
      reviewed_by_type: 'platform_admin',
      reviewed_by_id: 'reviewer-001',
    });

    expect(result.reviewed_at).toBeTruthy();
  });

  it('requires a reviewed batch before approval', async () => {
    const batch = await createBatch();

    await expect(service.approveBatch({
      batchId: batch.id,
      approvedByType: 'platform_admin',
      approvedById: 'approver-001',
    })).rejects.toThrow('Only reviewed batches can be approved');
  });

  it('prevents the reviewer from approving their own batch', async () => {
    const batch = await createBatch();
    await verifyItem(batch.id);

    await service.reviewBatch({
      batchId: batch.id,
      reviewedByType: 'platform_admin',
      reviewedById: 'reviewer-001',
    });

    await expect(service.approveBatch({
      batchId: batch.id,
      approvedByType: 'platform_admin',
      approvedById: 'reviewer-001',
    })).rejects.toThrow('Reviewer cannot approve their own batch');
  });

  it('approves a reviewed batch with a separate approver', async () => {
    const batch = await createBatch();
    await verifyItem(batch.id);

    await service.reviewBatch({
      batchId: batch.id,
      reviewedByType: 'platform_admin',
      reviewedById: 'reviewer-001',
    });

    const result = await service.approveBatch({
      batchId: batch.id,
      approvedByType: 'platform_admin',
      approvedById: 'approver-001',
    });

    expect(result).toMatchObject({
      status: 'approved',
      reviewed_by_id: 'reviewer-001',
      approved_by_type: 'platform_admin',
      approved_by_id: 'approver-001',
      verified_items: 1,
    });

    expect(result.approved_at).toBeTruthy();
  });

  it('does not create ledger transactions or entries', async () => {
    const batch = await createBatch();
    await verifyItem(batch.id);

    await service.reviewBatch({
      batchId: batch.id,
      reviewedByType: 'platform_admin',
      reviewedById: 'reviewer-001',
    });

    await service.approveBatch({
      batchId: batch.id,
      approvedByType: 'platform_admin',
      approvedById: 'approver-001',
    });

    const transactions = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM ledger_transactions
    `).first();

    const entries = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM ledger_entries
    `).first();

    expect(transactions.total).toBe(0);
    expect(entries.total).toBe(0);
  });
});
