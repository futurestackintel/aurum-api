import { LedgerService } from './ledger.js';
import { AccountProvisioningService } from './accountProvisioning.js';
import { PaymentService } from './payments.js';
import {
  assertSafeMinorUnits,
  validateCurrencyCode,
  calculateFeeMinor,
  addMinorUnits,
} from './money.js';
function requireText(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} is required`);
  }

  return value.trim();
}

async function createFingerprint(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export class DepositService {
  constructor(env, options = {}) {
    if (!env?.DB) {
      throw new Error('A D1 database binding is required');
    }

    this.env = env;
    this.db = env.DB;
    this.ledger = new LedgerService(this.db);
    this.accounts = new AccountProvisioningService(this.db);
    this.payments = options.payments || new PaymentService(env);
    this.provider = env.PAYMENT_PROVIDER || 'paystack';
  }

  async initializeDeposit({
    userId,
    email,
    amountMinor,
    currencyCode,
    idempotencyKey,
    callbackUrl,
    requestId = null,
  }) {
    userId = requireText(userId, 'User ID');
    email = requireText(email, 'Email');
    idempotencyKey = requireText(
      idempotencyKey,
      'Idempotency key'
    );
    currencyCode = validateCurrencyCode(currencyCode);

    assertSafeMinorUnits(amountMinor);

    if (amountMinor === 0) {
      throw new Error('Deposit amount must be greater than zero');
    }
		    this.payments.assertCurrencySupported(
      currencyCode,
      'deposit',
      this.provider
    );

    const feeMinor = calculateFeeMinor(amountMinor, 500);
    const providerAmountMinor = addMinorUnits(
      amountMinor,
      feeMinor
    );

    if (
      callbackUrl !== undefined &&
      callbackUrl !== null &&
      typeof callbackUrl !== 'string'
    ) {
      throw new Error('Callback URL must be a string');
    }

    const scope = 'wallet-deposit';
    const fingerprint = await createFingerprint({
      userId,
      amountMinor,
      currencyCode,
      provider: this.provider,
    });

    const existing = await this.db
      .prepare(`
        SELECT *
        FROM financial_payment_operations
        WHERE idempotency_scope = ?
          AND idempotency_key = ?
      `)
      .bind(scope, idempotencyKey)
      .first();

    if (existing) {
      if (existing.request_fingerprint !== fingerprint) {
        throw new Error(
          'Idempotency key was already used for a different deposit'
        );
      }

      if (existing.status !== 'pending') {
        throw new Error(
          'This deposit operation is no longer pending'
        );
      }

      if (existing.provider_reference) {
  let metadata = {};

  try {
    metadata = JSON.parse(existing.metadata_json || '{}');
  } catch {
    throw new Error('Stored deposit metadata is invalid');
  }

  return {
    operationId: existing.id,
    reference: existing.provider_reference,
    authorizationUrl: metadata.authorization_url || null,
    status: existing.status,
  };
}
    }

    const operationId = crypto.randomUUID();
    const reference = `aurum_deposit_${operationId}`;

    await this.db
      .prepare(`
        INSERT INTO financial_payment_operations (
          id,
          user_id,
          operation_type,
          status,
          amount_minor,
          provider_amount_minor,
          currency_code,
          provider,
          idempotency_scope,
          idempotency_key,
          request_fingerprint,
          provider_reference,
          metadata_json
        )
         VALUES (?, ?, 'deposit', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        operationId,
        userId,
        amountMinor,
				providerAmountMinor
        currencyCode,
        this.provider,
        scope,
        idempotencyKey,
        fingerprint,
        reference,
          JSON.stringify({
          request_id: requestId,
          principal_amount_minor: amountMinor,
          fee_minor: feeMinor,
          provider_amount_minor: providerAmountMinor,
        })
      )
      .run();

    try {
      const result = await this.payments.initializePayment({
        provider: this.provider,
        email,
        amountMinor: providerAmountMinor,
        currencyCode,
        reference,
        callbackUrl,
        metadata: {
          type: 'wallet_deposit',
          operation_id: operationId,
          user_id: userId,
        },
      });

      if (
  result.reference !== reference ||
  typeof result.authorizationUrl !== 'string' ||
  result.authorizationUrl.trim() === ''
) {
  throw new Error('Provider returned an invalid payment initialization response');
}

await this.db
  .prepare(`
    UPDATE financial_payment_operations
    SET
      metadata_json = ?,
      updated_at = ?
    WHERE id = ?
      AND status = 'pending'
  `)
  .bind(
    JSON.stringify({
      request_id: requestId,
      authorization_url: result.authorizationUrl,
      principal_amount_minor: amountMinor,
      fee_minor: feeMinor,
      provider_amount_minor: providerAmountMinor,
    }),
    new Date().toISOString(),
    operationId
  )
  .run();

return {
  operationId,
  reference,
  authorizationUrl: result.authorizationUrl,
  status: 'pending',
};
    } catch (error) {
      await this.db
        .prepare(`
          UPDATE financial_payment_operations
          SET
            status = 'reconciliation_required',
            failure_code = 'PROVIDER_INITIALIZATION_OUTCOME_UNKNOWN',
            failure_message = ?,
            updated_at = ?
          WHERE id = ?
            AND status = 'pending'
        `)
        .bind(
          String(error.message || 'Provider initialization failed').slice(0, 500),
          new Date().toISOString(),
          operationId
        )
        .run();

      throw error;
    }
  }

  async confirmDeposit({
    userId,
    reference,
    requestId = null,
  }) {
    userId = requireText(userId, 'User ID');
    reference = requireText(reference, 'Payment reference');

    const operation = await this.db
      .prepare(`
        SELECT *
        FROM financial_payment_operations
        WHERE provider = ?
          AND provider_reference = ?
          AND operation_type = 'deposit'
      `)
      .bind(this.provider, reference)
      .first();

    if (!operation) {
      throw new Error('Deposit operation not found');
    }

    if (operation.user_id !== userId) {
      throw new Error('Deposit does not belong to this user');
    }

    if (operation.status === 'succeeded') {
      return {
        operationId: operation.id,
        status: 'succeeded',
        alreadyCompleted: true,
        ledgerTransactionId:
          operation.settlement_ledger_transaction_id,
      };
    }

    if (operation.status !== 'pending') {
      throw new Error(
        `Deposit cannot be confirmed from status: ${operation.status}`
      );
    }

    const payment = await this.payments.verifyPayment(
      reference,
      this.provider
    );

    if (payment.status !== 'success') {
      throw new Error('Provider payment has not succeeded');
    }

    if (payment.reference !== reference) {
      throw new Error('Provider payment reference mismatch');
    }

      const expectedProviderAmount =
      operation.provider_amount_minor ?? operation.amount_minor;

    if (payment.amountMinor !== expectedProviderAmount) {
      throw new Error('Provider payment amount mismatch');
    }

    if (payment.currencyCode !== operation.currency_code) {
      throw new Error('Provider payment currency mismatch');
    }

    if (
      payment.metadata?.type !== 'wallet_deposit' ||
      payment.metadata?.operation_id !== operation.id ||
      payment.metadata?.user_id !== userId
    ) {
      throw new Error('Provider payment metadata mismatch');
    }

    const userAccounts =
      await this.accounts.provisionUserAccounts(
        userId,
        operation.currency_code
      );

    const availableAccount = userAccounts.accounts.find(
      account =>
        account.account_code ===
        `USER:AVAILABLE:${userId}:${operation.currency_code}`
    );

    if (!availableAccount) {
      throw new Error('User available-wallet account not found');
    }

    const providerAccount =
      await this.accounts.provisionProviderClearingAccount({
        provider: this.provider,
        currencyCode: operation.currency_code,
      });

		    let depositMetadata = {};

    try {
      depositMetadata = JSON.parse(operation.metadata_json || '{}');
    } catch {
      throw new Error('Stored deposit metadata is invalid');
    }

    const principalMinor = operation.amount_minor;
    const providerGrossMinor =
      operation.provider_amount_minor ?? operation.amount_minor;

    const feeMinor = depositMetadata.fee_minor ??
      (providerGrossMinor - principalMinor);

    const feeAccount = feeMinor > 0
      ? await this.accounts.provisionPlatformAccount({
          accountType: 'fee_revenue',
          currencyCode: operation.currency_code,
        })
      : null;

    const posting = await this.ledger.postTransaction({
      idempotencyScope: 'wallet-deposit-settlement',
      idempotencyKey: operation.id,
      sourceModule: 'deposit_service',
      transactionType: 'wallet_deposit',
      actorType: 'system',
      actorId: null,
      requestId,
      description: 'Verified wallet deposit',
      reference,
      metadata: {
        payment_operation_id: operation.id,
        provider: this.provider,
        provider_reference: reference,
      },
            entries: [
        {
          accountId: providerAccount.id,
          currencyCode: operation.currency_code,
          side: 'debit',
          amountMinor: providerGrossMinor,
          description: 'Gross provider deposit',
        },
        {
          accountId: availableAccount.id,
          currencyCode: operation.currency_code,
          side: 'credit',
          amountMinor: principalMinor,
          description: 'User wallet deposit principal',
        },
        ...(feeMinor > 0 ? [{
          accountId: feeAccount.id,
          currencyCode: operation.currency_code,
          side: 'credit',
          amountMinor: feeMinor,
          description: 'Platform deposit fee',
        }] : []),
      ],
    });

    const now = new Date().toISOString();

    const update = await this.db
      .prepare(`
        UPDATE financial_payment_operations
        SET
          status = 'succeeded',
          provider_currency_code = ?,
          provider_amount_minor = ?,
          settlement_ledger_transaction_id = ?,
          completed_at = ?,
          updated_at = ?
        WHERE id = ?
          AND status = 'pending'
      `)
      .bind(
        payment.currencyCode,
        payment.amountMinor,
        posting.transaction.id,
        now,
        now,
        operation.id
      )
      .run();

    if (update.meta?.changes !== 1) {
      const latest = await this.db
        .prepare(`
          SELECT status, settlement_ledger_transaction_id
          FROM financial_payment_operations
          WHERE id = ?
        `)
        .bind(operation.id)
        .first();

      if (
        latest?.status !== 'succeeded' ||
        latest.settlement_ledger_transaction_id !==
          posting.transaction.id
      ) {
        throw new Error(
          'Deposit ledger posting succeeded but operation finalization requires reconciliation'
        );
      }
    }

    return {
      operationId: operation.id,
      status: 'succeeded',
      alreadyCompleted: !posting.created,
      ledgerTransactionId: posting.transaction.id,
    };
  }
}
