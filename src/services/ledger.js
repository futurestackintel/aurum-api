
import {
  validateJournalEntries,
  validateReversalEntries,
} from './ledgerRules.js';

import {
  validateCurrencyCode,
} from './money.js';

const ACCOUNT_CLASSES = [
  'asset',
  'liability',
  'equity',
  'revenue',
  'expense',
];

const BALANCE_TYPES = ['debit', 'credit'];

const NATURAL_BALANCES = {
  asset: 'debit',
  expense: 'debit',
  liability: 'credit',
  equity: 'credit',
  revenue: 'credit',
};

const OWNER_TYPES = [
  'user',
  'crew',
  'platform',
  'provider',
  'escrow',
  'fx',
  'custody_partner',
];

const ACTOR_TYPES = [
  'member',
  'platform_admin',
  'system',
];

function requireText(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} is required`);
  }

  return value.trim();
}

function optionalText(value, fieldName) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  return requireText(value, fieldName);
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonicalize(value[key])])
    );
  }

  return value;
}

async function createRequestFingerprint(value) {
  const canonical = JSON.stringify(canonicalize(value));
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function parseMetadata(metadataJson) {
  if (!metadataJson) {
    return {};
  }

  try {
    return JSON.parse(metadataJson);
  } catch {
    throw new Error('Stored ledger metadata is invalid');
  }
}

function validateMetadata(metadata) {
  if (
    metadata === undefined ||
    metadata === null
  ) {
    return {};
  }

  if (
    typeof metadata !== 'object' ||
    Array.isArray(metadata)
  ) {
    throw new Error('Ledger metadata must be an object');
  }

  if (
    Object.prototype.hasOwnProperty.call(
      metadata,
      '_idempotency_fingerprint'
    )
  ) {
    throw new Error('Reserved ledger metadata property');
  }

  // Ensure metadata can be safely serialized before any write.
  try {
    JSON.stringify(metadata);
  } catch {
    throw new Error('Ledger metadata must be JSON serializable');
  }

  return metadata;
}

function normalizeEntries(entries) {
  return entries.map(entry => ({
    accountId: entry.accountId,
    currencyCode: entry.currencyCode,
    side: entry.side,
    amountMinor: entry.amountMinor,
    description: optionalText(
      entry.description,
      'Entry description'
    ),
  }));
}

function compareEntries(a, b) {
  const left = JSON.stringify(a);
  const right = JSON.stringify(b);

  return left < right ? -1 : left > right ? 1 : 0;
}

export class LedgerService {
  constructor(db) {
    if (!db) {
      throw new Error('A D1 database binding is required');
    }

    this.db = db;
  }

  async createAccount({
    accountCode,
    accountName,
    accountClass,
    normalBalance,
    ownerType,
    ownerId = null,
    currencyCode,
  }) {
    accountCode = requireText(accountCode, 'Account code');
    accountName = requireText(accountName, 'Account name');
    currencyCode = validateCurrencyCode(currencyCode);

    if (!ACCOUNT_CLASSES.includes(accountClass)) {
      throw new Error('Invalid ledger account class');
    }

    if (!BALANCE_TYPES.includes(normalBalance)) {
  throw new Error('Invalid normal balance');
}

if (NATURAL_BALANCES[accountClass] !== normalBalance) {
  throw new Error(
    'Normal balance does not match the ledger account class'
  );
}
    if (!OWNER_TYPES.includes(ownerType)) {
      throw new Error('Invalid ledger account owner type');
    }

    ownerId = optionalText(ownerId, 'Account owner ID');

    const currency = await this.db
      .prepare(`
        SELECT currency_code
        FROM financial_currencies
        WHERE currency_code = ?
          AND is_enabled = 1
      `)
      .bind(currencyCode)
      .first();

    if (!currency) {
      throw new Error('Currency is missing or not enabled');
    }

    const accountId = crypto.randomUUID();

    await this.db
      .prepare(`
        INSERT INTO ledger_accounts (
          id,
          account_code,
          account_name,
          account_class,
          normal_balance,
          owner_type,
          owner_id,
          currency_code,
          status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
      `)
      .bind(
        accountId,
        accountCode,
        accountName,
        accountClass,
        normalBalance,
        ownerType,
        ownerId,
        currencyCode
      )
      .run();

    return this.getAccount(accountId);
  }

  async getAccount(accountId) {
    accountId = requireText(accountId, 'Account ID');

    const account = await this.db
      .prepare(`
        SELECT
          id,
          account_code,
          account_name,
          account_class,
          normal_balance,
          owner_type,
          owner_id,
          currency_code,
          status,
          created_at,
          updated_at
        FROM ledger_accounts
        WHERE id = ?
      `)
      .bind(accountId)
      .first();

    return account || null;
  }

  async getTransaction(transactionId) {
    transactionId = requireText(
      transactionId,
      'Transaction ID'
    );

    const transaction = await this.db
      .prepare(`
        SELECT
          id,
          idempotency_scope,
          idempotency_key,
          source_module,
          transaction_type,
          status,
          description,
          reference,
          actor_type,
          actor_id,
          request_id,
          reversal_of_transaction_id,
          metadata_json,
          created_at,
          posted_at
        FROM ledger_transactions
        WHERE id = ?
      `)
      .bind(transactionId)
      .first();

    if (!transaction) {
      return null;
    }

    const entries = await this.db
      .prepare(`
        SELECT
          id,
          transaction_id,
          account_id,
          currency_code,
          entry_side,
          amount_minor,
          description,
          created_at
        FROM ledger_entries
        WHERE transaction_id = ?
        ORDER BY created_at ASC, id ASC
      `)
      .bind(transactionId)
      .all();

    return {
      ...transaction,
      metadata: parseMetadata(transaction.metadata_json),
      entries: entries.results || [],
    };
  }

  async findByIdempotencyKey(scope, key) {
    const transaction = await this.db
      .prepare(`
        SELECT
          id,
          status,
          metadata_json
        FROM ledger_transactions
        WHERE idempotency_scope = ?
          AND idempotency_key = ?
      `)
      .bind(scope, key)
      .first();

    return transaction || null;
  }

    async validateAccounts(entries, allowInactiveAccounts = false) {
    const accountIds = [
      ...new Set(entries.map(entry => entry.accountId)),
    ];

    const placeholders = accountIds.map(() => '?').join(', ');

    const result = await this.db
      .prepare(`
        SELECT
          accounts.id,
          accounts.currency_code,
          accounts.status,
          currencies.is_enabled
        FROM ledger_accounts AS accounts
        JOIN financial_currencies AS currencies
          ON currencies.currency_code = accounts.currency_code
        WHERE accounts.id IN (${placeholders})
      `)
      .bind(...accountIds)
      .all();

    const accounts = new Map(
      (result.results || []).map(account => [
        account.id,
        account,
      ])
    );

    for (const entry of entries) {
      const account = accounts.get(entry.accountId);

      if (!account) {
        throw new Error(
          `Ledger account does not exist: ${entry.accountId}`
        );
      }

            if (!allowInactiveAccounts && account.status !== 'active') {
        throw new Error(
          `Ledger account is not active: ${entry.accountId}`
        );
      }

      if (!allowInactiveAccounts && account.is_enabled !== 1) {
        throw new Error(
          `Currency is not enabled: ${account.currency_code}`
        );
      }

      if (account.currency_code !== entry.currencyCode) {
        throw new Error(
          `Entry currency does not match account ${entry.accountId}`
        );
      }
    }
  }

    async postTransaction(input) {
  return this.#postTransaction(input, false);
}

  async #postTransaction({
    idempotencyScope,
    idempotencyKey,
    sourceModule,
    transactionType,
    actorType,
    actorId = null,
    requestId = null,
    description = null,
    reference = null,
    metadata = {},
    entries,
    reversalOfTransactionId = null,
  }, allowInactiveAccounts = false) {
    idempotencyScope = requireText(
      idempotencyScope,
      'Idempotency scope'
    );

    idempotencyKey = requireText(
      idempotencyKey,
      'Idempotency key'
    );

    sourceModule = requireText(sourceModule, 'Source module');
    transactionType = requireText(
      transactionType,
      'Transaction type'
    );

    if (!ACTOR_TYPES.includes(actorType)) {
      throw new Error('Invalid ledger actor type');
    }

    actorId = optionalText(actorId, 'Actor ID');
    requestId = optionalText(requestId, 'Request ID');
    description = optionalText(description, 'Description');
    reference = optionalText(reference, 'Reference');

    if (
      reversalOfTransactionId !== null &&
      reversalOfTransactionId !== undefined
    ) {
      reversalOfTransactionId = requireText(
        reversalOfTransactionId,
        'Original transaction ID'
      );
    } else {
      reversalOfTransactionId = null;
    }

    metadata = validateMetadata(metadata);

    const normalizedEntries = normalizeEntries(entries);

    validateJournalEntries(normalizedEntries);

    const fingerprintEntries = [...normalizedEntries]
      .sort(compareEntries);

    const fingerprint = await createRequestFingerprint({
      sourceModule,
      transactionType,
      actorType,
      actorId,
      requestId,
      description,
      reference,
      metadata,
      reversalOfTransactionId,
      entries: fingerprintEntries,
    });

    // Return the original result for a legitimate retry.
    const existing = await this.findByIdempotencyKey(
      idempotencyScope,
      idempotencyKey
    );

    if (existing) {
      const existingMetadata = parseMetadata(
        existing.metadata_json
      );

      if (
        existingMetadata._idempotency_fingerprint !== fingerprint
      ) {
        throw new Error(
          'Idempotency key was already used for different transaction data'
        );
      }

      if (existing.status !== 'posted') {
        throw new Error(
          'Existing idempotent ledger transaction is not posted'
        );
      }

      return {
        created: false,
        transaction: await this.getTransaction(existing.id),
      };
    }

    // Check every account before attempting the atomic posting batch.
        await this.validateAccounts(
      normalizedEntries,
      allowInactiveAccounts
    );

    const transactionId = crypto.randomUUID();
    const now = new Date().toISOString();

    const storedMetadata = {
      ...metadata,
      _idempotency_fingerprint: fingerprint,
    };

    const statements = [
      this.db.prepare(`
        INSERT INTO ledger_transactions (
          id,
          idempotency_scope,
          idempotency_key,
          source_module,
          transaction_type,
          status,
          description,
          reference,
          actor_type,
          actor_id,
          request_id,
          reversal_of_transaction_id,
          metadata_json
        )
        VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        transactionId,
        idempotencyScope,
        idempotencyKey,
        sourceModule,
        transactionType,
        description,
        reference,
        actorType,
        actorId,
        requestId,
        reversalOfTransactionId,
        JSON.stringify(storedMetadata)
      ),
    ];

    for (const entry of normalizedEntries) {
      statements.push(
        this.db.prepare(`
          INSERT INTO ledger_entries (
            id,
            transaction_id,
            account_id,
            currency_code,
            entry_side,
            amount_minor,
            description
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          crypto.randomUUID(),
          transactionId,
          entry.accountId,
          entry.currencyCode,
          entry.side,
          entry.amountMinor,
          entry.description
        )
      );
    }

    statements.push(
      this.db.prepare(`
        UPDATE ledger_transactions
        SET
          status = 'posted',
          posted_at = ?
        WHERE id = ?
          AND status = 'draft'
      `).bind(now, transactionId)
    );

    try {
      await this.db.batch(statements);
    } catch (error) {
      // A concurrent request may have won the same idempotency key.
      const racedTransaction = await this.findByIdempotencyKey(
        idempotencyScope,
        idempotencyKey
      );

      if (racedTransaction) {
        const racedMetadata = parseMetadata(
          racedTransaction.metadata_json
        );

        if (
          racedMetadata._idempotency_fingerprint !== fingerprint
        ) {
          throw new Error(
            'Idempotency key was concurrently used for different transaction data'
          );
        }

        if (racedTransaction.status === 'posted') {
          return {
            created: false,
            transaction: await this.getTransaction(
              racedTransaction.id
            ),
          };
        }
      }

      throw error;
    }

    return {
      created: true,
      transaction: await this.getTransaction(transactionId),
    };
  }

  async reverseTransaction({
    transactionId,
    idempotencyScope,
    idempotencyKey,
    actorType,
    actorId = null,
    requestId = null,
    reason,
  }) {
    transactionId = requireText(
      transactionId,
      'Transaction ID'
    );

    reason = requireText(reason, 'Reversal reason');

    const original = await this.getTransaction(transactionId);

    if (!original) {
      throw new Error('Original ledger transaction not found');
    }

    if (original.status !== 'posted') {
      throw new Error('Only posted transactions can be reversed');
    }

    const reversalEntries = original.entries.map(entry => ({
      accountId: entry.account_id,
      currencyCode: entry.currency_code,
      amountMinor: entry.amount_minor,
      side: entry.entry_side === 'debit' ? 'credit' : 'debit',
      description: `Reversal: ${reason}`,
    }));

    validateReversalEntries(
      original.entries.map(entry => ({
        accountId: entry.account_id,
        currencyCode: entry.currency_code,
        amountMinor: entry.amount_minor,
        side: entry.entry_side,
      })),
      reversalEntries
    );

      return this.#postTransaction({
      idempotencyScope,
      idempotencyKey,
      sourceModule: original.source_module,
      transactionType: 'reversal',
      actorType,
      actorId,
      requestId,
      description: `Reversal of ${transactionId}: ${reason}`,
      reference: transactionId,
      metadata: {
        reversal_reason: reason,
      },
      entries: reversalEntries,
      reversalOfTransactionId: transactionId,
    }, true);
  }
}
