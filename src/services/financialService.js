import { LedgerService } from './ledger.js';
import { AccountProvisioningService } from './accountProvisioning.js';
import {
  assertSafeMinorUnits,
  validateCurrencyCode,
} from './money.js';

function requireText(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} is required`);
  }

  return value.trim();
}

export class FinancialService {
  constructor(db) {
    if (!db) {
      throw new Error('A D1 database binding is required');
    }

    this.db = db;
    this.ledger = new LedgerService(db);
    this.accounts = new AccountProvisioningService(db);
  }

  /**
   * Transfer money between two users' available wallet accounts.
   *
   * This is an internal ledger transfer:
   * - No payment-provider request.
   * - No platform fee.
   * - No currency conversion.
   * - Both sides post atomically.
   */
  async transferBetweenUsers({
    senderUserId,
    recipientUserId,
    actorUserId,
    currencyCode,
    amountMinor,
    idempotencyKey,
    requestId = null,
    description = 'Internal wallet transfer',
    reference = null,
    metadata = {},
  }) {
    senderUserId = requireText(senderUserId, 'Sender user ID');
    recipientUserId = requireText(
      recipientUserId,
      'Recipient user ID'
    );
    actorUserId = requireText(actorUserId, 'Actor user ID');
    idempotencyKey = requireText(
      idempotencyKey,
      'Idempotency key'
    );

    currencyCode = validateCurrencyCode(currencyCode);
    assertSafeMinorUnits(amountMinor);

    if (amountMinor === 0) {
      throw new Error('Transfer amount must be greater than zero');
    }

    if (senderUserId === recipientUserId) {
      throw new Error('Cannot transfer funds to the same user');
    }

    if (actorUserId !== senderUserId) {
      throw new Error('Actor must be the sender');
    }

    if (
      typeof metadata !== 'object' ||
      metadata === null ||
      Array.isArray(metadata)
    ) {
      throw new Error('Transfer metadata must be an object');
    }

    const senderAccounts =
      await this.accounts.provisionUserAccounts(
        senderUserId,
        currencyCode
      );

    const recipientAccounts =
      await this.accounts.provisionUserAccounts(
        recipientUserId,
        currencyCode
      );

    const senderAvailable = senderAccounts.accounts.find(
      account =>
        account.account_code ===
        `USER:AVAILABLE:${senderUserId}:${currencyCode}`
    );

    const recipientAvailable = recipientAccounts.accounts.find(
      account =>
        account.account_code ===
        `USER:AVAILABLE:${recipientUserId}:${currencyCode}`
    );

    if (!senderAvailable || !recipientAvailable) {
      throw new Error('Required wallet accounts could not be provisioned');
    }

    return this.ledger.postTransaction({
      idempotencyScope: 'financial-user-transfer',
      idempotencyKey,
      sourceModule: 'financial_service',
      transactionType: 'wallet_transfer',
      actorType: 'member',
      actorId: actorUserId,
      requestId,
      description,
      reference,
      metadata,
      entries: [
        {
          accountId: senderAvailable.id,
          currencyCode,
          side: 'debit',
          amountMinor,
          description: 'Wallet transfer sent',
        },
        {
          accountId: recipientAvailable.id,
          currencyCode,
          side: 'credit',
          amountMinor,
          description: 'Wallet transfer received',
        },
      ],
    });
  }
  }
