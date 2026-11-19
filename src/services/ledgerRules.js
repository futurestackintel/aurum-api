
import {
  assertSafeMinorUnits,
  validateCurrencyCode,
} from './money.js';

function validateEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Invalid ledger entry');
  }

  if (
    typeof entry.accountId !== 'string' ||
    entry.accountId.trim() === ''
  ) {
    throw new Error('Ledger entry requires an account ID');
  }

  validateCurrencyCode(entry.currencyCode);
  assertSafeMinorUnits(entry.amountMinor);

  if (entry.amountMinor === 0) {
    throw new Error('Ledger entry amount must be greater than zero');
  }

  if (
    entry.side !== 'debit' &&
    entry.side !== 'credit'
  ) {
    throw new Error('Ledger entry side must be debit or credit');
  }
}

/**
 * Validate a journal transaction before it is posted.
 *
 * Every currency must balance independently.
 * At least two entries are required.
 */
export function validateJournalEntries(entries) {
  if (!Array.isArray(entries) || entries.length < 2) {
    throw new Error(
      'A ledger transaction requires at least two entries'
    );
  }

  const balances = new Map();

  for (const entry of entries) {
    validateEntry(entry);

    if (!balances.has(entry.currencyCode)) {
      balances.set(entry.currencyCode, {
        debit: 0n,
        credit: 0n,
      });
    }

    const balance = balances.get(entry.currencyCode);

    balance[entry.side] += BigInt(entry.amountMinor);
  }

  for (const [currencyCode, balance] of balances) {
    if (balance.debit !== balance.credit) {
      throw new Error(
        `Ledger transaction is not balanced in ${currencyCode}`
      );
    }

    if (balance.debit === 0n || balance.credit === 0n) {
      throw new Error(
        `Ledger transaction requires debits and credits in ${currencyCode}`
      );
    }
  }

  return true;
}

/**
 * Ensure reversal entries exactly invert the original entries.
 *
 * Each original debit must become a credit, and each original
 * credit must become a debit, using the same account, currency
 * and amount.
 */
export function validateReversalEntries(
  originalEntries,
  reversalEntries
) {
  validateJournalEntries(originalEntries);
  validateJournalEntries(reversalEntries);

  if (originalEntries.length !== reversalEntries.length) {
    throw new Error(
      'Reversal must contain the same number of entries as the original'
    );
  }

  const original = originalEntries.map(entry => ({
    accountId: entry.accountId,
    currencyCode: entry.currencyCode,
    amountMinor: entry.amountMinor,
    side: entry.side === 'debit' ? 'credit' : 'debit',
  }));

  const remaining = [...reversalEntries];

  for (const expected of original) {
    const index = remaining.findIndex(entry =>
      entry.accountId === expected.accountId &&
      entry.currencyCode === expected.currencyCode &&
      entry.amountMinor === expected.amountMinor &&
      entry.side === expected.side
    );

    if (index === -1) {
      throw new Error(
        'Reversal entries must exactly invert the original transaction'
      );
    }

    remaining.splice(index, 1);
  }

  if (remaining.length !== 0) {
    throw new Error('Unexpected entries in reversal transaction');
  }

  return true;
}
