import { LedgerService } from './ledger.js';
import { AccountProvisioningService } from './accountProvisioning.js';
import { PaymentService } from './payments.js';
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

async function createFingerprint(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export class WithdrawalService {
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

  async initiateWithdrawal({
    userId,
    amountMinor,
    currencyCode,
    idempotencyKey,
    bankDetails,
    requestId = null,
  }) {
    userId = requireText(userId, 'User ID');

    idempotencyKey = requireText(
      idempotencyKey,
      'Idempotency key'
    );

    currencyCode = validateCurrencyCode(currencyCode);

    assertSafeMinorUnits(amountMinor);

    if (amountMinor === 0) {
      throw new Error('Withdrawal amount must be greater than zero');
    }

    if (currencyCode !== 'NGN') {
      throw new Error('Bank withdrawals currently support NGN only');
    }

    if (
      !bankDetails ||
      typeof bankDetails !== 'object'
    ) {
      throw new Error('Saved bank details are required');
    }

    const accountName = requireText(
      bankDetails.account_name,
      'Bank account name'
    );

    const accountNumber = requireText(
      bankDetails.account_number,
      'Bank account number'
    );

    const bankCode = requireText(
      bankDetails.bank_code,
      'Bank code'
    );

    const scope = 'wallet-withdrawal';

    const fingerprint = await createFingerprint({
      userId,
      amountMinor,
      currencyCode,
      provider: this.provider,
      accountNumber,
      bankCode,
      accountName,
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
          'Idempotency key was already used for a different withdrawal'
        );
      }

      return {
        operationId: existing.id,
        reference: existing.provider_reference,
        status: existing.status,
        alreadyCreated: true,
      };
    }

    // Create the provider recipient from the user's saved bank details.
    const recipient = await this.payments.createTransferRecipient({
      name: accountName,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: currencyCode,
    });

    const recipientCode = recipient?.recipient_code;

    if (
      typeof recipientCode !== 'string' ||
      recipientCode.trim() === ''
    ) {
      throw new Error(
        'Payment provider returned an invalid transfer recipient'
      );
    }

    const operationId = crypto.randomUUID();
    const reference = `aurum_withdrawal_${operationId}`;

    // Store only the provider recipient code, not the bank account number.
    await this.db
      .prepare(`
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
          provider_reference,
          metadata_json
        )
        VALUES (
          ?, ?, 'withdrawal', 'reserved', ?, ?, ?,
          ?, ?, ?, ?, ?
        )
      `)
      .bind(
        operationId,
        userId,
        amountMinor,
        currencyCode,
        this.provider,
        scope,
        idempotencyKey,
        fingerprint,
        reference,
        JSON.stringify({
          request_id: requestId,
          recipient_code: recipientCode,
        })
      )
      .run();

    try {
      const userAccounts =
        await this.accounts.provisionUserAccounts(
          userId,
          currencyCode
        );

      const availableAccount = userAccounts.accounts.find(
        account =>
          account.account_code ===
          `USER:AVAILABLE:${userId}:${currencyCode}`
      );

      const heldAccount = userAccounts.accounts.find(
        account =>
          account.account_code ===
          `USER:HELD:${userId}:${currencyCode}`
      );

      if (!availableAccount || !heldAccount) {
        throw new Error('User wallet ledger accounts are missing');
      }

      if (
        availableAccount.status !== 'active' ||
        heldAccount.status !== 'active'
      ) {
        throw new Error('User wallet ledger accounts are not active');
      }

      // Reserve funds before contacting the transfer endpoint.
      const reservation = await this.ledger.postTransaction({
        idempotencyScope: 'wallet-withdrawal-reservation',
        idempotencyKey: operationId,
        sourceModule: 'withdrawal_service',
        transactionType: 'withdrawal_reservation',
        actorType: 'system',
        requestId,
        description: 'Reserve funds for wallet withdrawal',
        reference,
        metadata: {
          payment_operation_id: operationId,
        },
        entries: [
          {
            accountId: availableAccount.id,
            currencyCode,
            side: 'debit',
            amountMinor,
            description: 'Move funds out of available wallet balance',
          },
          {
            accountId: heldAccount.id,
            currencyCode,
            side: 'credit',
            amountMinor,
            description: 'Hold funds for bank withdrawal',
          },
        ],
      });

      await this.db
        .prepare(`
          UPDATE financial_payment_operations
          SET
            reserve_ledger_transaction_id = ?,
            updated_at = ?
          WHERE id = ?
            AND status = 'reserved'
        `)
        .bind(
          reservation.transaction.id,
          new Date().toISOString(),
          operationId
        )
        .run();

      const processingUpdate = await this.db
        .prepare(`
          UPDATE financial_payment_operations
          SET
            status = 'processing',
            updated_at = ?
          WHERE id = ?
            AND status = 'reserved'
        `)
        .bind(new Date().toISOString(), operationId)
        .run();

      if (processingUpdate.meta?.changes !== 1) {
        throw new Error(
          'Withdrawal reservation requires reconciliation'
        );
      }

      // Use a stable reference so the provider operation can be investigated
      // if the network response is lost.
      let transfer;

      try {
        transfer = await this.payments.createTransfer({
          provider: this.provider,
          amountMinor,
          currencyCode,
          recipientCode,
          reference,
          reason: `AURUM wallet withdrawal ${operationId}`,
        });
      } catch (error) {
        await this.markReconciliationRequired(
          operationId,
          'TRANSFER_INITIALIZATION_OUTCOME_UNKNOWN',
          error
        );

        throw new Error(
          'Transfer outcome is uncertain. Funds remain reserved for reconciliation.'
        );
      }

      if (
        transfer.reference !== reference ||
        transfer.amountMinor !== amountMinor ||
        transfer.currencyCode !== currencyCode
      ) {
        await this.markReconciliationRequired(
          operationId,
          'TRANSFER_RESPONSE_MISMATCH',
          new Error('Provider transfer response did not match the request')
        );

        throw new Error(
          'Provider transfer response requires reconciliation'
        );
      }

      await this.db
        .prepare(`
          UPDATE financial_payment_operations
          SET
            provider_transfer_code = ?,
            updated_at = ?
          WHERE id = ?
        `)
        .bind(
          transfer.transferCode || null,
          new Date().toISOString(),
          operationId
        )
        .run();

      let verification;

      try {
        verification = await this.payments.verifyTransfer(
          reference,
          this.provider
        );
      } catch (error) {
        await this.markReconciliationRequired(
          operationId,
          'TRANSFER_VERIFICATION_UNAVAILABLE',
          error
        );

        throw new Error(
          'Transfer verification is unavailable. Funds remain reserved.'
        );
      }

      if (
        verification.reference !== reference ||
        verification.amountMinor !== amountMinor ||
        verification.currencyCode !== currencyCode
      ) {
        await this.markReconciliationRequired(
          operationId,
          'TRANSFER_VERIFICATION_MISMATCH',
          new Error('Verified transfer details did not match the withdrawal')
        );

        throw new Error(
          'Verified transfer details require reconciliation'
        );
      }

      if (
        verification.status === 'success'
      ) {
        return await this.settleWithdrawal({
          operationId,
          userId,
          amountMinor,
          currencyCode,
          reference,
          requestId,
        });
      }

      if (
        verification.status === 'failed' ||
        verification.status === 'reversed'
      ) {
        return await this.releaseWithdrawal({
          operationId,
          userId,
          amountMinor,
          currencyCode,
          reference,
          requestId,
          reason: `Provider transfer ${verification.status}`,
        });
      }

      await this.markReconciliationRequired(
        operationId,
        'TRANSFER_NOT_FINAL',
        new Error(`Provider transfer status: ${verification.status}`)
      );

      return {
        operationId,
        reference,
        status: 'reconciliation_required',
      };
    } catch (error) {
      const latest = await this.db
        .prepare(`
          SELECT status
          FROM financial_payment_operations
          WHERE id = ?
        `)
        .bind(operationId)
        .first();

      if (latest?.status === 'reserved') {
        await this.db
          .prepare(`
            UPDATE financial_payment_operations
            SET
              status = 'failed',
              failure_code = 'WITHDRAWAL_RESERVATION_FAILED',
              failure_message = ?,
              updated_at = ?,
              completed_at = ?
            WHERE id = ?
              AND status = 'reserved'
          `)
          .bind(
            String(error.message || 'Reservation failed').slice(0, 500),
            new Date().toISOString(),
            new Date().toISOString(),
            operationId
          )
          .run();
      }

      throw error;
    }
  }

  async settleWithdrawal({
    operationId,
    userId,
    amountMinor,
    currencyCode,
    reference,
    requestId = null,
  }) {
    const userAccounts =
      await this.accounts.provisionUserAccounts(
        userId,
        currencyCode
      );

    const heldAccount = userAccounts.accounts.find(
      account =>
        account.account_code ===
        `USER:HELD:${userId}:${currencyCode}`
    );

    if (!heldAccount || heldAccount.status !== 'active') {
      throw new Error('User held-wallet account is unavailable');
    }

    const providerAccount =
      await this.accounts.provisionProviderClearingAccount({
        provider: this.provider,
        currencyCode,
      });

    if (providerAccount.status !== 'active') {
      throw new Error('Provider clearing account is unavailable');
    }

    const posting = await this.ledger.postTransaction({
      idempotencyScope: 'wallet-withdrawal-settlement',
      idempotencyKey: operationId,
      sourceModule: 'withdrawal_service',
      transactionType: 'withdrawal_settlement',
      actorType: 'system',
      requestId,
      description: 'Verified bank withdrawal',
      reference,
      metadata: {
        payment_operation_id: operationId,
        provider: this.provider,
      },
      entries: [
        {
          accountId: heldAccount.id,
          currencyCode,
          side: 'debit',
          amountMinor,
          description: 'Settle reserved user withdrawal',
        },
        {
          accountId: providerAccount.id,
          currencyCode,
          side: 'credit',
          amountMinor,
          description: 'Provider transfer payout',
        },
      ],
    });

    const now = new Date().toISOString();

    await this.db
      .prepare(`
        UPDATE financial_payment_operations
        SET
          status = 'succeeded',
          settlement_ledger_transaction_id = ?,
          provider_amount_minor = ?,
          provider_currency_code = ?,
          completed_at = ?,
          updated_at = ?
        WHERE id = ?
          AND status IN ('processing', 'reconciliation_required')
      `)
      .bind(
        posting.transaction.id,
        amountMinor,
        currencyCode,
        now,
        now,
        operationId
      )
      .run();

    return {
      operationId,
      reference,
      status: 'succeeded',
      ledgerTransactionId: posting.transaction.id,
    };
  }

  async releaseWithdrawal({
    operationId,
    userId,
    amountMinor,
    currencyCode,
    reference,
    requestId = null,
    reason,
  }) {
    const userAccounts =
      await this.accounts.provisionUserAccounts(
        userId,
        currencyCode
      );

    const availableAccount = userAccounts.accounts.find(
      account =>
        account.account_code ===
        `USER:AVAILABLE:${userId}:${currencyCode}`
    );

    const heldAccount = userAccounts.accounts.find(
      account =>
        account.account_code ===
        `USER:HELD:${userId}:${currencyCode}`
    );

    if (
      !availableAccount ||
      !heldAccount ||
      availableAccount.status !== 'active' ||
      heldAccount.status !== 'active'
    ) {
      throw new Error('User wallet accounts are unavailable for release');
    }

    const posting = await this.ledger.postTransaction({
      idempotencyScope: 'wallet-withdrawal-release',
      idempotencyKey: operationId,
      sourceModule: 'withdrawal_service',
      transactionType: 'withdrawal_release',
      actorType: 'system',
      requestId,
      description: 'Release failed bank withdrawal reservation',
      reference,
      metadata: {
        payment_operation_id: operationId,
        release_reason: reason,
      },
      entries: [
        {
          accountId: heldAccount.id,
          currencyCode,
          side: 'debit',
          amountMinor,
          description: 'Release held withdrawal funds',
        },
        {
          accountId: availableAccount.id,
          currencyCode,
          side: 'credit',
          amountMinor,
          description: 'Return funds to available wallet balance',
        },
      ],
    });

    const now = new Date().toISOString();

    await this.db
      .prepare(`
        UPDATE financial_payment_operations
        SET
          status = 'failed',
          settlement_ledger_transaction_id = ?,
          failure_code = 'PROVIDER_TRANSFER_FAILED',
          failure_message = ?,
          completed_at = ?,
          updated_at = ?
        WHERE id = ?
          AND status IN ('processing', 'reconciliation_required')
      `)
      .bind(
        posting.transaction.id,
        String(reason).slice(0, 500),
        now,
        now,
        operationId
      )
      .run();

    return {
      operationId,
      reference,
      status: 'failed',
      fundsReleased: true,
      ledgerTransactionId: posting.transaction.id,
    };
  }

    async markReconciliationRequired(operationId, code, error) {
    await this.db
      .prepare(`
        UPDATE financial_payment_operations
        SET
          status = 'reconciliation_required',
          failure_code = ?,
          failure_message = ?,
          updated_at = ?
        WHERE id = ?
          AND status IN ('reserved', 'processing')
      `)
      .bind(
        code,
        String(error?.message || error || code).slice(0, 500),
        new Date().toISOString(),
        operationId
      )
      .run();
  }
}
