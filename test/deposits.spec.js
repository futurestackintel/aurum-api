import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DepositService } from '../src/services/deposits.js';

async function seedCurrencies() {
await env.DB.batch([
env.DB.prepare("INSERT INTO financial_currencies ( currency_code, minor_unit_exponent, is_enabled ) VALUES ('NGN', 2, 1) ON CONFLICT(currency_code) DO UPDATE SET is_enabled = 1"),
]);
}

async function createUser() {
const id = `deposit-user-${crypto.randomUUID()}`;

await env.DB.prepare("INSERT INTO users ( id, clerk_id, username, display_name, email ) VALUES (?, ?, ?, ?, ?)").bind(
id,
`clerk-${id}`,
"user-${crypto.randomUUID()}",
'Deposit Test User',
"${id}@example.com"
).run();

return {
id,
email: `${id}@example.com`,
};
}

function createPayments() {
return {
initializePayment: vi.fn(async ({
reference,
}) => ({
provider: 'paystack',
reference,
authorizationUrl: 'https://example.com/authorize',
})),

verifyPayment: vi.fn(async reference => ({
  provider: 'paystack',
  providerReference: '123456',
  reference,
  amountMinor: 500000,
  currencyCode: 'NGN',
  status: 'success',
  metadata: {
    type: 'wallet_deposit',
    operation_id: currentOperationId,
    user_id: currentUserId,
  },
})),

};
}

let currentOperationId;
let currentUserId;

async function getAvailableBalance(userId) {
const result = await env.DB.prepare("SELECT COALESCE( SUM( CASE WHEN entries.entry_side = 'credit' THEN entries.amount_minor ELSE -entries.amount_minor END ), 0 ) AS balance FROM ledger_entries AS entries JOIN ledger_accounts AS accounts ON accounts.id = entries.account_id JOIN ledger_transactions AS transactions ON transactions.id = entries.transaction_id WHERE accounts.account_code = ? AND transactions.status = 'posted'").bind(
`USER:AVAILABLE:${userId}:NGN`
).first();

return result.balance;
}

beforeEach(async () => {
currentOperationId = null;
currentUserId = null;
await seedCurrencies();
});

describe('DepositService', () => {
it('initializes a deposit and stores its provider reference', async () => {
const user = await createUser();
const payments = createPayments();

const deposits = new DepositService(
  {
    DB: env.DB,
    PAYMENT_PROVIDER: 'paystack',
  },
  { payments }
);

const result = await deposits.initializeDeposit({
  userId: user.id,
  email: user.email,
  amountMinor: 500000,
  currencyCode: 'NGN',
  idempotencyKey: crypto.randomUUID(),
  callbackUrl: 'https://example.com/wallet',
});

expect(result.status).toBe('pending');
expect(result.reference).toContain('aurum_deposit_');
expect(result.authorizationUrl).toBe(
  'https://example.com/authorize'
);

expect(payments.initializePayment).toHaveBeenCalledOnce();

const operation = await env.DB.prepare(`
  SELECT *
  FROM financial_payment_operations
  WHERE id = ?
`).bind(result.operationId).first();

expect(operation.status).toBe('pending');
expect(operation.amount_minor).toBe(500000);
expect(operation.currency_code).toBe('NGN');
expect(operation.provider_reference).toBe(result.reference);

});

it('returns the original pending operation for an identical retry', async () => {
const user = await createUser();
const payments = createPayments();
const deposits = new DepositService(
{
DB: env.DB,
PAYMENT_PROVIDER: 'paystack',
},
{ payments }
);

const idempotencyKey = crypto.randomUUID();

const input = {
  userId: user.id,
  email: user.email,
  amountMinor: 500000,
  currencyCode: 'NGN',
  idempotencyKey,
};

const first = await deposits.initializeDeposit(input);
const second = await deposits.initializeDeposit(input);

expect(second.operationId).toBe(first.operationId);
expect(second.reference).toBe(first.reference);
expect(second.authorizationUrl).toBe(
  first.authorizationUrl
);

expect(payments.initializePayment).toHaveBeenCalledOnce();

});

it('rejects reuse of an idempotency key with different deposit data', async () => {
const user = await createUser();
const payments = createPayments();
const deposits = new DepositService(
{
DB: env.DB,
PAYMENT_PROVIDER: 'paystack',
},
{ payments }
);

const idempotencyKey = crypto.randomUUID();

await deposits.initializeDeposit({
  userId: user.id,
  email: user.email,
  amountMinor: 500000,
  currencyCode: 'NGN',
  idempotencyKey,
});

await expect(
  deposits.initializeDeposit({
    userId: user.id,
    email: user.email,
    amountMinor: 700000,
    currencyCode: 'NGN',
    idempotencyKey,
  })
).rejects.toThrow(
  'Idempotency key was already used for a different deposit'
);

});

it('settles a verified deposit into the user ledger exactly once', async () => {
const user = await createUser();
const payments = createPayments();
const deposits = new DepositService(
{
DB: env.DB,
PAYMENT_PROVIDER: 'paystack',
},
{ payments }
);

const initialized = await deposits.initializeDeposit({
  userId: user.id,
  email: user.email,
  amountMinor: 500000,
  currencyCode: 'NGN',
  idempotencyKey: crypto.randomUUID(),
});

currentOperationId = initialized.operationId;
currentUserId = user.id;

const first = await deposits.confirmDeposit({
  userId: user.id,
  reference: initialized.reference,
});

const second = await deposits.confirmDeposit({
  userId: user.id,
  reference: initialized.reference,
});

expect(first.status).toBe('succeeded');
expect(second.status).toBe('succeeded');
expect(second.alreadyCompleted).toBe(true);

expect(await getAvailableBalance(user.id)).toBe(500000);

const transactions = await env.DB.prepare(`
  SELECT COUNT(*) AS total
  FROM ledger_transactions
  WHERE idempotency_scope = 'wallet-deposit-settlement'
    AND idempotency_key = ?
`).bind(initialized.operationId).first();

expect(transactions.total).toBe(1);

});

it('rejects a provider amount mismatch without crediting the wallet', async () => {
const user = await createUser();
const payments = createPayments();

payments.verifyPayment.mockImplementation(async reference => ({
  provider: 'paystack',
  reference,
  amountMinor: 400000,
  currencyCode: 'NGN',
  status: 'success',
  metadata: {
    type: 'wallet_deposit',
    operation_id: currentOperationId,
    user_id: currentUserId,
  },
}));

const deposits = new DepositService(
  {
    DB: env.DB,
    PAYMENT_PROVIDER: 'paystack',
  },
  { payments }
);

const initialized = await deposits.initializeDeposit({
  userId: user.id,
  email: user.email,
  amountMinor: 500000,
  currencyCode: 'NGN',
  idempotencyKey: crypto.randomUUID(),
});

currentOperationId = initialized.operationId;
currentUserId = user.id;

await expect(
  deposits.confirmDeposit({
    userId: user.id,
    reference: initialized.reference,
  })
).rejects.toThrow('Provider payment amount mismatch');

expect(await getAvailableBalance(user.id)).toBe(0);

});

it('rejects confirmation by a different user', async () => {
const user = await createUser();
const otherUser = await createUser();
const payments = createPayments();

const deposits = new DepositService(
  {
    DB: env.DB,
    PAYMENT_PROVIDER: 'paystack',
  },
  { payments }
);

const initialized = await deposits.initializeDeposit({
  userId: user.id,
  email: user.email,
  amountMinor: 500000,
  currencyCode: 'NGN',
  idempotencyKey: crypto.randomUUID(),
});

await expect(
  deposits.confirmDeposit({
    userId: otherUser.id,
    reference: initialized.reference,
  })
).rejects.toThrow('Deposit does not belong to this user');

expect(payments.verifyPayment).not.toHaveBeenCalled();

});
});
