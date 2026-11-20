
import { LedgerService } from './ledger.js';
import { AccountProvisioningService } from './accountProvisioning.js';
import {
  assertSafeMinorUnits,
  validateCurrencyCode,
} from './money.js';

const PLATFORM_FEE_BPS = 200;
const BASIS_POINTS = 10000;

function requireText(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} is required`);
  }

  return value.trim();
}

function validateOwnerType(ownerType) {
  if (!['user', 'crew'].includes(ownerType)) {
    throw new Error('Owner type must be user or crew');
  }

  return ownerType;
}

function validateActorType(actorType) {
  if (!['member', 'platform_admin', 'system'].includes(actorType)) {
    throw new Error('Invalid financial actor type');
  }

  return actorType;
}

function validateEscrowType(escrowType) {
  if (!['DUEL', 'CHALLENGE', 'CREW_BATTLE'].includes(escrowType)) {
    throw new Error('Unsupported escrow type');
  }

  return escrowType;
}

function validateFinancialMetadata(metadata) {
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    throw new Error('Financial metadata must be an object');
  }

  return metadata;
}

function getAccount(accounts, accountCode) {
  const account = accounts.find(
    item => item.account_code === accountCode
  );

  if (!account) {
    throw new Error(`Required financial account not found: ${accountCode}`);
  }

  return account;
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

  async getOwnerAvailableAccount({
    ownerType,
    ownerId,
    currencyCode,
  }) {
    ownerType = validateOwnerType(ownerType);
    ownerId = requireText(ownerId, 'Owner ID');
    currencyCode = validateCurrencyCode(currencyCode);

    const provisioned = ownerType === 'user'
      ? await this.accounts.provisionUserAccounts(ownerId, currencyCode)
      : await this.accounts.provisionCrewAccounts(ownerId, currencyCode);

    const prefix = ownerType === 'user' ? 'USER' : 'CREW';

    return getAccount(
      provisioned.accounts,
      `${prefix}:AVAILABLE:${ownerId}:${currencyCode}`
    );
  }

  async getEscrowAccount({
    escrowType,
    escrowId,
    currencyCode,
  }) {
		escrowType = validateEscrowType(escrowType);
    return this.accounts.provisionEscrowAccount({
      escrowType,
      escrowId,
      currencyCode,
    });
  }

  /**
   * Move available user or crew funds into feature escrow.
   * This is an internal ledger movement, not a provider payment.
   */
  async fundEscrow({
    ownerType,
    ownerId,
    escrowType,
    escrowId,
    currencyCode,
    amountMinor,
    idempotencyKey,
    actorType = 'system',
    actorId = null,
    requestId = null,
    reference = null,
    metadata = {},
  }) {
    ownerType = validateOwnerType(ownerType);
    ownerId = requireText(ownerId, 'Owner ID');
    escrowId = requireText(escrowId, 'Escrow ID');
    idempotencyKey = requireText(idempotencyKey, 'Idempotency key');
    currencyCode = validateCurrencyCode(currencyCode);
    assertSafeMinorUnits(amountMinor);
    actorType = validateActorType(actorType);
		    escrowType = validateEscrowType(escrowType);
    metadata = validateFinancialMetadata(metadata);

    if (amountMinor === 0) {
      throw new Error('Escrow funding amount must be greater than zero');
    }

    const source = await this.getOwnerAvailableAccount({
      ownerType,
      ownerId,
      currencyCode,
    });

    const escrow = await this.getEscrowAccount({
      escrowType,
      escrowId,
      currencyCode,
    });

    return this.ledger.postTransaction({
      idempotencyScope: `financial-escrow-fund:${escrowType.toLowerCase()}`,
      idempotencyKey,
      sourceModule: 'financial_service',
      transactionType: 'escrow_funding',
      actorType,
      actorId,
      requestId,
      description: `Fund ${escrowType} escrow`,
      reference,
      metadata: {
        ...metadata,
        owner_type: ownerType,
        owner_id: ownerId,
        escrow_type: escrowType,
        escrow_id: escrowId,
        amount_minor: amountMinor,
        currency_code: currencyCode,
      },
      entries: [
        {
          accountId: source.id,
          currencyCode,
          side: 'debit',
          amountMinor,
          description: 'Funds moved into escrow',
        },
        {
          accountId: escrow.id,
          currencyCode,
          side: 'credit',
          amountMinor,
          description: 'Escrow funded',
        },
      ],
    });
  }

  /**
   * Settle an escrow once.
   * The fixed 2% platform fee is calculated from the gross settlement.
   * The recipient receives the remaining amount.
   */
  async settleEscrow({
    escrowType,
    escrowId,
    currencyCode,
    grossAmountMinor,
    recipientType,
    recipientId,
    idempotencyKey,
    actorType = 'system',
    actorId = null,
    requestId = null,
    reference = null,
    metadata = {},
  }) {
    escrowId = requireText(escrowId, 'Escrow ID');
    recipientType = validateOwnerType(recipientType);
    recipientId = requireText(recipientId, 'Recipient ID');
    idempotencyKey = requireText(idempotencyKey, 'Idempotency key');
    currencyCode = validateCurrencyCode(currencyCode);
    assertSafeMinorUnits(grossAmountMinor);
    actorType = validateActorType(actorType);
	escrowType = validateEscrowType(escrowType);
    metadata = validateFinancialMetadata(metadata);

    if (grossAmountMinor === 0) {
      throw new Error('Settlement amount must be greater than zero');
    }

    const escrow = await this.getEscrowAccount({
      escrowType,
      escrowId,
      currencyCode,
    });

    const recipient = await this.getOwnerAvailableAccount({
      ownerType: recipientType,
      ownerId: recipientId,
      currencyCode,
    });

    const feeMinor = Number(
      (BigInt(grossAmountMinor) * BigInt(PLATFORM_FEE_BPS)) /
      BigInt(BASIS_POINTS)
    );

    const recipientAmountMinor = grossAmountMinor - feeMinor;

    if (recipientAmountMinor <= 0) {
      throw new Error('Settlement amount is too small after platform fee');
    }

    const entries = [
      {
        accountId: escrow.id,
        currencyCode,
        side: 'debit',
        amountMinor: grossAmountMinor,
        description: 'Gross escrow settlement',
      },
      {
        accountId: recipient.id,
        currencyCode,
        side: 'credit',
        amountMinor: recipientAmountMinor,
        description: 'Net settlement received',
      },
    ];

    if (feeMinor > 0) {
      const revenue = await this.accounts.provisionPlatformAccount({
        accountType: 'fee_revenue',
        currencyCode,
      });

      entries.push({
        accountId: revenue.id,
        currencyCode,
        side: 'credit',
        amountMinor: feeMinor,
        description: 'AURUM 2% settlement revenue',
      });
    }

            const transactionId = crypto.randomUUID();

    return this.ledger.postTransaction({
      transactionId,
      atomicStatements: [
        this.db.prepare(`
          INSERT INTO financial_escrow_terminal_operations (
            id,
            escrow_type,
            escrow_id,
            currency_code,
            outcome,
            ledger_transaction_id
          )
          VALUES (?, ?, ?, ?, 'settlement', ?)
        `).bind(
          crypto.randomUUID(),
          escrowType,
          escrowId,
          currencyCode,
          transactionId
        ),
      ],
      idempotencyScope: `financial-escrow-settle:${escrowType.toLowerCase()}`,
      idempotencyKey,
      sourceModule: 'financial_service',
      transactionType: 'escrow_settlement',
      actorType,
      actorId,
      requestId,
      description: `Settle ${escrowType} escrow`,
      reference,
      metadata: {
        ...metadata,
        escrow_type: escrowType,
        escrow_id: escrowId,
        recipient_type: recipientType,
        recipient_id: recipientId,
        currency_code: currencyCode,
        gross_amount_minor: grossAmountMinor,
        platform_fee_bps: PLATFORM_FEE_BPS,
        platform_fee_minor: feeMinor,
        recipient_amount_minor: recipientAmountMinor,
      },
      entries,
    });
  }

  /**
   * Return escrow funds to their original user or crew.
   * Refunds never generate platform revenue.
   */
  async refundEscrow({
    ownerType,
    ownerId,
    escrowType,
    escrowId,
    currencyCode,
    amountMinor,
    idempotencyKey,
    actorType = 'system',
    actorId = null,
    requestId = null,
    reference = null,
    metadata = {},
  }) {
    ownerType = validateOwnerType(ownerType);
    ownerId = requireText(ownerId, 'Owner ID');
    escrowId = requireText(escrowId, 'Escrow ID');
    idempotencyKey = requireText(idempotencyKey, 'Idempotency key');
    currencyCode = validateCurrencyCode(currencyCode);
    assertSafeMinorUnits(amountMinor);
    actorType = validateActorType(actorType);
		escrowType = validateEscrowType(escrowType);
    metadata = validateFinancialMetadata(metadata);

    if (amountMinor === 0) {
      throw new Error('Refund amount must be greater than zero');
    }

    const escrow = await this.getEscrowAccount({
      escrowType,
      escrowId,
      currencyCode,
    });

    const recipient = await this.getOwnerAvailableAccount({
      ownerType,
      ownerId,
      currencyCode,
    });

		const transactionId = crypto.randomUUID();

    return this.ledger.postTransaction({
			transactionId,
      atomicStatements: [
        this.db.prepare(`
          INSERT INTO financial_escrow_terminal_operations (
            id,
            escrow_type,
            escrow_id,
            currency_code,
            outcome,
            ledger_transaction_id
          )
          VALUES (?, ?, ?, ?, 'refund', ?)
        `).bind(
          crypto.randomUUID(),
          escrowType,
          escrowId,
          currencyCode,
          transactionId
        ),
      ],
      idempotencyScope: `financial-escrow-refund:${escrowType.toLowerCase()}`,
      idempotencyKey,
      sourceModule: 'financial_service',
      transactionType: 'escrow_refund',
      actorType,
      actorId,
      requestId,
      description: `Refund ${escrowType} escrow`,
      reference,
      metadata: {
        ...metadata,
        owner_type: ownerType,
        owner_id: ownerId,
        escrow_type: escrowType,
        escrow_id: escrowId,
        amount_minor: amountMinor,
        currency_code: currencyCode,
        platform_fee_minor: 0,
      },
      entries: [
        {
          accountId: escrow.id,
          currencyCode,
          side: 'debit',
          amountMinor,
          description: 'Funds returned from escrow',
        },
        {
          accountId: recipient.id,
          currencyCode,
          side: 'credit',
          amountMinor,
          description: 'Escrow refund received',
        },
      ],
    });
  }

  /**
   * Transfer money between two users' available wallet accounts.
   * No payment-provider request, fee or currency conversion.
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
    recipientUserId = requireText(recipientUserId, 'Recipient user ID');
    actorUserId = requireText(actorUserId, 'Actor user ID');
    idempotencyKey = requireText(idempotencyKey, 'Idempotency key');

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

    const senderAvailable = await this.getOwnerAvailableAccount({
      ownerType: 'user',
      ownerId: senderUserId,
      currencyCode,
    });

    const recipientAvailable = await this.getOwnerAvailableAccount({
      ownerType: 'user',
      ownerId: recipientUserId,
      currencyCode,
    });

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
