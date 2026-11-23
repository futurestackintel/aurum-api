import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { confirmDepositMock } = vi.hoisted(() => ({
  confirmDepositMock: vi.fn(),
}));

vi.mock('../src/services/deposits.js', () => ({
  DepositService: class {
    confirmDeposit(...args) {
      return confirmDepositMock(...args);
    }
  },
}));

import { handleWebhookRoutes } from '../src/routes/webhook.js';

const SECRET = 'test-paystack-secret';

async function signBody(body) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body)
  );

  return Array.from(new Uint8Array(signature))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function createDepositOperation() {
  const userId = `webhook-user-${crypto.randomUUID()}`;
  const operationId = crypto.randomUUID();
  const reference = `aurum_deposit_${operationId}`;

  await env.DB.prepare(`
    INSERT INTO users (
      id, clerk_id, username, display_name, email
    )
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    userId,
    `clerk-${userId}`,
    `user-${crypto.randomUUID()}`,
    'Webhook Test User',
    `${userId}@example.com`
  ).run();

  await env.DB.prepare(`
    INSERT INTO financial_currencies (
      currency_code,
      minor_unit_exponent,
      is_enabled
    )
    VALUES ('NGN', 2, 1)
    ON CONFLICT(currency_code)
    DO UPDATE SET is_enabled = 1
  `).run();

  await env.DB.prepare(`
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
      provider_reference
    )
    VALUES (?, ?, 'deposit', 'pending', 500000, 'NGN',
      'paystack', 'wallet-deposit', ?, ?, ?)
  `).bind(
    operationId,
    userId,
    crypto.randomUUID(),
    'a'.repeat(64),
    reference
  ).run();

  return { userId, operationId, reference };
}

function createEvent(operation) {
  return {
    event: 'charge.success',
    data: {
      id: operation.operationId,
      reference: operation.reference,
      amount: 500000,
      currency: 'NGN',
      status: 'success',
      metadata: {
        type: 'wallet_deposit',
        operation_id: operation.operationId,
        user_id: operation.userId,
      },
    },
  };
}

async function sendWebhook(event, signatureOverride = null) {
  const body = JSON.stringify(event);
  const signature = signatureOverride || await signBody(body);

  const request = new Request(
    'https://aurum.test/webhook/paystack',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-paystack-signature': signature,
      },
      body,
      }
);
}

beforeEach(() => {

  return handleWebhookRoutes(
  '/webhook/paystack',
  request,
  {
    DB: env.DB,
    PAYSTACK_SECRET_KEY: SECRET,
  },
  {
    DepositServiceClass: class {
      async confirmDeposit(...args) {
        return confirmDepositMock(...args);
      }
    },
  }
);

beforeEach(() => {
  confirmDepositMock.mockReset();
  confirmDepositMock.mockResolvedValue({
    status: 'succeeded',
    alreadyCompleted: false,
  });
});

describe('Paystack wallet deposit webhook', () => {
  it('rejects a missing signature', async () => {
    const request = new Request(
      'https://aurum.test/webhook/paystack',
      {
        method: 'POST',
        body: '{}',
      }
    );

    const response = await handleWebhookRoutes(
      '/webhook/paystack',
      request,
      { DB: env.DB, PAYSTACK_SECRET_KEY: SECRET }
    );

    expect(response.status).toBe(401);
    expect(confirmDepositMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature', async () => {
    const response = await sendWebhook(
      { event: 'charge.success', data: {} },
      'invalid-signature'
    );

    expect(response.status).toBe(401);
    expect(confirmDepositMock).not.toHaveBeenCalled();
  });

  it('processes a verified deposit webhook and records the event', async () => {
    const operation = await createDepositOperation();
    const event = createEvent(operation);

    const response = await sendWebhook(event);

    expect(response.status).toBe(200);
    expect(confirmDepositMock).toHaveBeenCalledOnce();
    expect(confirmDepositMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: operation.userId,
        reference: operation.reference,
      })
    );

    const stored = await env.DB.prepare(`
      SELECT *
      FROM financial_provider_events
      WHERE provider_reference = ?
    `).bind(operation.reference).first();

    expect(stored).toBeTruthy();
    expect(stored.signature_verified).toBe(1);
    expect(stored.processing_status).toBe('processed');
    expect(stored.attempt_count).toBe(1);
    expect(stored.payment_operation_id).toBe(operation.operationId);
  });

  it('does not process an identical webhook event twice', async () => {
    const operation = await createDepositOperation();
    const event = createEvent(operation);

    const first = await sendWebhook(event);
    const second = await sendWebhook(event);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(confirmDepositMock).toHaveBeenCalledOnce();

    const stored = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM financial_provider_events
      WHERE provider_reference = ?
    `).bind(operation.reference).first();

    expect(stored.total).toBe(1);
  });

  it('retries a failed webhook event and processes it successfully', async () => {
  const operation = await createDepositOperation();
  const event = createEvent(operation);

  confirmDepositMock.mockRejectedValueOnce(
    new Error('Simulated deposit settlement failure')
  );

  const firstResponse = await sendWebhook(event);

  expect(firstResponse.status).toBe(500);

  const failed = await env.DB.prepare(`
    SELECT processing_status, attempt_count, last_error
    FROM financial_provider_events
    WHERE provider_reference = ?
  `).bind(operation.reference).first();

  expect(failed.processing_status).toBe('failed');
  expect(failed.attempt_count).toBe(1);
  expect(failed.last_error).toContain(
    'Simulated deposit settlement failure'
  );

  // Retry the exact same provider event.
  const retryResponse = await sendWebhook(event);

  expect(retryResponse.status).toBe(200);
  expect(confirmDepositMock).toHaveBeenCalledTimes(2);

  const retried = await env.DB.prepare(`
    SELECT processing_status, attempt_count, last_error
    FROM financial_provider_events
    WHERE provider_reference = ?
  `).bind(operation.reference).first();

  expect(retried.processing_status).toBe('processed');
  expect(retried.attempt_count).toBe(2);
  expect(retried.last_error).toBeNull();
});
});
