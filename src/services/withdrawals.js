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

    if (!bankDetails || typeof bankDetails !== 'object') {
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

    // ----------------------------------------------------------
    // IDEMPOTENCY
    // ----------------------------------------------------------

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

    const operationId = crypto.randomUUID();
    const reference = `aurum_withdrawal_${operationId}`;

    // ----------------------------------------------------------
    // CREATE DURABLE OPERATION BEFORE EXTERNAL PROVIDER CALLS
    // ----------------------------------------------------------

    try {
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
          })
        )
        .run();
    } catch (error) {
      // Another concurrent request may have won the idempotency race.
      const racedOperation = await this.db
        .prepare(`
          SELECT *
          FROM financial_payment_operations
          WHERE idempotency_scope = ?
            AND idempotency_key = ?
        `)
        .bind(scope, idempotencyKey)
        .first();

      if (racedOperation) {
        if (
          racedOperation.request_fingerprint !== fingerprint
        ) {
          throw new Error(
            'Idempotency key was already used for a different withdrawal'
          );
        }

        return {
          operationId: racedOperation.id,
          reference: racedOperation.provider_reference,
          status: racedOperation.status,
          alreadyCreated: true,
        };
      }

      throw error;
    }

    let transferAttempted = false;

    try {
      // --------------------------------------------------------
      // PROVISION WALLET ACCOUNTS
      // --------------------------------------------------------

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

      // --------------------------------------------------------
      // RESERVE WITHDRAWAL FUNDS
      // --------------------------------------------------------

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

      const reservationUpdate = await this.db
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

      if (reservationUpdate.meta?.changes !== 1) {
        throw new Error(
          'Unable to record withdrawal reservation'
        );
      }

      // --------------------------------------------------------
      // CREATE PROVIDER RECIPIENT
      // --------------------------------------------------------

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

      // Persist recipient code. Never persist the bank account number.
      const metadata = {
        request_id: requestId,
        recipient_code: recipientCode,
      };

            const metadataUpdate = await this.db
        .prepare(`
          UPDATE financial_payment_operations
          SET
            metadata_json = ?,
            updated_at = ?
          WHERE id = ?
            AND status = 'reserved'
        `)
        .bind(
          JSON.stringify(metadata),
          new Date().toISOString(),
          operationId
        )
        .run();

      if (metadataUpdate.meta?.changes !== 1) {
        throw new Error(
          'Unable to persist withdrawal recipient details'
        );
      }

      // --------------------------------------------------------
      // MOVE OPERATION INTO PROCESSING
      // --------------------------------------------------------

      const processingUpdate = await this.db
        .prepare(`
          UPDATE financial_payment_operations
          SET
            status = 'processing',
            updated_at = ?
          WHERE id = ?
            AND status = 'reserved'
        `)
        .bind(
          new Date().toISOString(),
          operationId
        )
        .run();

      if (processingUpdate.meta?.changes !== 1) {
        throw new Error(
          'Withdrawal requires reconciliation before transfer'
        );
      }

      // --------------------------------------------------------
      // INITIATE PROVIDER TRANSFER
      // --------------------------------------------------------

      transferAttempted = true;

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

      // --------------------------------------------------------
      // VALIDATE PROVIDER RESPONSE
      // --------------------------------------------------------

      if (
        transfer.reference !== reference ||
        transfer.amountMinor !== amountMinor ||
        transfer.currencyCode !== currencyCode
      ) {
        await this.markReconciliationRequired(
          operationId,
          'TRANSFER_RESPONSE_MISMATCH',
          new Error(
            'Provider transfer response did not match the withdrawal'
          )
        );

        throw new Error(
          'Provider transfer response requires reconciliation'
        );
      }

      const transferCodeUpdate = await this.db
        .prepare(`
          UPDATE financial_payment_operations
          SET
            provider_transfer_code = ?,
            updated_at = ?
          WHERE id = ?
            AND status = 'processing'
        `)
        .bind(
          transfer.transferCode || null,
          new Date().toISOString(),
          operationId
        )
        .run();

      if (transferCodeUpdate.meta?.changes !== 1) {
        await this.markReconciliationRequired(
          operationId,
          'TRANSFER_CODE_PERSISTENCE_FAILED',
          new Error('Could not persist provider transfer code')
        );

        throw new Error(
          'Transfer requires reconciliation'
        );
      }

      // --------------------------------------------------------
      // VERIFY PROVIDER TRANSFER
      // --------------------------------------------------------

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
          new Error(
            'Verified transfer details did not match the withdrawal'
          )
        );

        throw new Error(
          'Verified transfer details require reconciliation'
        );
      }

      // --------------------------------------------------------
      // VERIFIED SUCCESS
      // --------------------------------------------------------

      if (verification.status === 'success') {
        return await this.settleWithdrawal({
          operationId,
          userId,
          amountMinor,
          currencyCode,
          reference,
          requestId,
        });
      }

      // --------------------------------------------------------
      // VERIFIED FAILURE
      // --------------------------------------------------------

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

      // --------------------------------------------------------
      // NON-FINAL PROVIDER STATUS
      // --------------------------------------------------------

      await this.markReconciliationRequired(
        operationId,
        'TRANSFER_NOT_FINAL',
        new Error(
          `Provider transfer status: ${verification.status}`
        )
      );

      return {
        operationId,
        reference,
        status: 'reconciliation_required',
      };
    } catch (error) {
      // --------------------------------------------------------
      // RECOVERY
      // --------------------------------------------------------

      const latest = await this.db
        .prepare(`
          SELECT
            status,
            reserve_ledger_transaction_id
          FROM financial_payment_operations
          WHERE id = ?
        `)
        .bind(operationId)
        .first();

      if (latest?.status === 'reserved') {
        const reservationRecord = await this.db
          .prepare(`
            SELECT id, status
            FROM ledger_transactions
            WHERE idempotency_scope = ?
              AND idempotency_key = ?
          `)
          .bind(
            'wallet-withdrawal-reservation',
            operationId
          )
          .first();

        if (reservationRecord?.status === 'posted') {
          await this.db
            .prepare(`
              UPDATE financial_payment_operations
              SET
                reserve_ledger_transaction_id = ?,
                status = 'reconciliation_required',
                failure_code = 'RESERVATION_RECOVERY_REQUIRED',
                failure_message = ?,
                updated_at = ?
              WHERE id = ?
                AND status = 'reserved'
            `)
            .bind(
              reservationRecord.id,
              'Ledger reservation posted; withdrawal requires recovery.',
              new Date().toISOString(),
              operationId
            )
            .run();
        } else {
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
      } else if (latest?.status === 'processing') {
        if (transferAttempted) {
          await this.markReconciliationRequired(
            operationId,
            'WITHDRAWAL_OUTCOME_UNKNOWN',
            error
          );
        } else {
          await this.releaseWithdrawal({
            operationId,
            userId,
            amountMinor,
            currencyCode,
            reference,
            requestId,
            reason: 'Transfer was not initiated',
          });
        }
      }

      throw error;
    }
  }

	  async claimWithdrawalFinalization(operationId, outcome) {
    const operation = await this.db
      .prepare(`
        SELECT
          id,
          operation_type,
          status,
          settlement_ledger_transaction_id
        FROM financial_payment_operations
        WHERE id = ?
      `)
      .bind(operationId)
      .first();

    if (!operation || operation.operation_type !== 'withdrawal') {
      throw new Error('Withdrawal operation not found');
    }

    if (
      operation.status === 'succeeded' ||
      operation.status === 'failed'
    ) {
      const expectedStatus =
        outcome === 'settle' ? 'succeeded' : 'failed';

      if (operation.status !== expectedStatus) {
        throw new Error(
          'Withdrawal was already finalized with a different outcome'
        );
      }

      return {
        alreadyFinalized: true,
        status: operation.status,
        ledgerTransactionId:
          operation.settlement_ledger_transaction_id,
      };
    }

    if (
      operation.status !== 'processing' &&
      operation.status !== 'reconciliation_required'
    ) {
      throw new Error(
        'Withdrawal is not eligible for finalization'
      );
    }

    await this.db
      .prepare(`
        INSERT OR IGNORE INTO financial_withdrawal_finalization_claims (
          payment_operation_id,
          outcome
        )
        VALUES (?, ?)
      `)
      .bind(operationId, outcome)
      .run();

    const claim = await this.db
      .prepare(`
        SELECT outcome
        FROM financial_withdrawal_finalization_claims
        WHERE payment_operation_id = ?
      `)
      .bind(operationId)
      .first();

    if (!claim || claim.outcome !== outcome) {
      throw new Error(
        'Withdrawal finalization is already claimed by a different outcome'
      );
    }

    return {
      alreadyFinalized: false,
      status: operation.status,
      ledgerTransactionId: null,
    };
	  }

  // ============================================================
  // SETTLE VERIFIED SUCCESSFUL WITHDRAWAL
  // ============================================================

  async settleWithdrawal({
    operationId,
    userId,
    amountMinor,
    currencyCode,
    reference,
    requestId = null,
    }) {
    const finalization = await this.claimWithdrawalFinalization(
      operationId,
      'settle'
    );

    if (finalization.alreadyFinalized) {
      return {
        operationId,
        reference,
        status: 'succeeded',
        ledgerTransactionId:
          finalization.ledgerTransactionId,
      };
    }

      }) {
    const finalization = await this.claimWithdrawalFinalization(
      operationId,
      'settle'
    );

    if (finalization.alreadyFinalized) {
      return {
        operationId,
        reference,
        status: 'succeeded',
        ledgerTransactionId:
          finalization.ledgerTransactionId,
      };
    }

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

    const update = await this.db
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

    if (update.meta?.changes !== 1) {
      const current = await this.db
        .prepare(`
          SELECT
            status,
            settlement_ledger_transaction_id
          FROM financial_payment_operations
          WHERE id = ?
        `)
        .bind(operationId)
        .first();

      if (
        current?.status !== 'succeeded' ||
        current.settlement_ledger_transaction_id !==
          posting.transaction.id
      ) {
        throw new Error(
          'Withdrawal ledger settlement posted but operation update requires reconciliation'
        );
      }
    }

    return {
      operationId,
      reference,
      status: 'succeeded',
      ledgerTransactionId: posting.transaction.id,
    };
  }

  // ============================================================
  // RELEASE FAILED WITHDRAWAL FUNDS
  // ============================================================

  async releaseWithdrawal({
    operationId,
    userId,
    amountMinor,
    currencyCode,
    reference,
    requestId = null,
    reason,
    }) {
    const finalization = await this.claimWithdrawalFinalization(
      operationId,
      'release'
    );

    if (finalization.alreadyFinalized) {
      return {
        operationId,
        reference,
        status: 'failed',
        fundsReleased: true,
        ledgerTransactionId:
          finalization.ledgerTransactionId,
      };
    }

      }) {
    const finalization = await this.claimWithdrawalFinalization(
      operationId,
      'release'
    );

    if (finalization.alreadyFinalized) {
      return {
        operationId,
        reference,
        status: 'failed',
        fundsReleased: true,
        ledgerTransactionId:
          finalization.ledgerTransactionId,
      };
    }

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
      throw new Error(
        'User wallet accounts are unavailable for release'
      );
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

    const update = await this.db
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

    if (update.meta?.changes !== 1) {
      const current = await this.db
        .prepare(`
          SELECT
            status,
            settlement_ledger_transaction_id
          FROM financial_payment_operations
          WHERE id = ?
        `)
        .bind(operationId)
        .first();

      if (
        current?.status !== 'failed' ||
        current.settlement_ledger_transaction_id !==
          posting.transaction.id
      ) {
        throw new Error(
          'Withdrawal funds released but operation update requires reconciliation'
        );
      }
    }

    return {
      operationId,
      reference,
      status: 'failed',
      fundsReleased: true,
      ledgerTransactionId: posting.transaction.id,
    };
  }

  // ============================================================
  // RECONCILIATION
  // ============================================================

  async markReconciliationRequired(
    operationId,
    code,
    error
  ) {
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
