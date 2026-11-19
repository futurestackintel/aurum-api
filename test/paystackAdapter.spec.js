import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { PaystackAdapter } from '../src/services/paystackAdapter.js';

const adapter = new PaystackAdapter('test-secret-key');

function mockPaystackResponse(data) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: true,
          message: 'Success',
          data,
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    )
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PaystackAdapter', () => {
  it('initializes a payment using integer minor units', async () => {
    mockPaystackResponse({
      authorization_url: 'https://example.com/pay',
      access_code: 'access_123',
      reference: 'deposit_001',
    });

    const result = await adapter.initializePayment({
      email: 'test@example.com',
      amountMinor: 150000,
      currencyCode: 'NGN',
      reference: 'deposit_001',
      metadata: {
        type: 'wallet_deposit',
      },
    });

    expect(result.provider).toBe('paystack');
    expect(result.amountMinor).toBe(150000);
    expect(result.currencyCode).toBe('NGN');
    expect(result.reference).toBe('deposit_001');
    expect(result.authorizationUrl).toBe(
      'https://example.com/pay'
    );

    const [, options] = fetch.mock.calls[0];

    const body = JSON.parse(options.body);

    expect(body.amount).toBe(150000);
    expect(body.currency).toBe('NGN');
    expect(body.reference).toBe('deposit_001');
  });

  it('verifies a payment and normalizes the response', async () => {
    mockPaystackResponse({
      id: 12345,
      reference: 'deposit_002',
      amount: 250000,
      currency: 'NGN',
      status: 'success',
      paid_at: '2026-11-19T10:00:00.000Z',
      gateway_response: 'Successful',
    });

    const result = await adapter.verifyPayment(
      'deposit_002'
    );

    expect(result.provider).toBe('paystack');
    expect(result.reference).toBe('deposit_002');
    expect(result.providerReference).toBe('12345');
    expect(result.amountMinor).toBe(250000);
    expect(result.currencyCode).toBe('NGN');
    expect(result.status).toBe('success');
    expect(result.paidAt).toBeTruthy();
  });

  it('creates a transfer using integer minor units', async () => {
    mockPaystackResponse({
      reference: 'withdrawal_001',
      transfer_code: 'TRF_123',
      status: 'pending',
    });

    const result = await adapter.createTransfer({
      amountMinor: 50000,
      currencyCode: 'NGN',
      recipientCode: 'RCP_123',
      reference: 'withdrawal_001',
      reason: 'AURUM withdrawal',
    });

    expect(result.provider).toBe('paystack');
    expect(result.amountMinor).toBe(50000);
    expect(result.currencyCode).toBe('NGN');
    expect(result.reference).toBe('withdrawal_001');
    expect(result.transferCode).toBe('TRF_123');
    expect(result.status).toBe('pending');

    const [, options] = fetch.mock.calls[0];

    const body = JSON.parse(options.body);

    expect(body.amount).toBe(50000);
    expect(body.currency).toBe('NGN');
    expect(body.reference).toBe('withdrawal_001');
    expect(body.recipient).toBe('RCP_123');
  });

  it('rejects zero payment amounts', async () => {
    await expect(
      adapter.initializePayment({
        email: 'test@example.com',
        amountMinor: 0,
        currencyCode: 'NGN',
        reference: 'invalid_001',
      })
    ).rejects.toThrow(
      'Payment amount must be greater than zero'
    );
  });

  it('rejects floating-point payment amounts', async () => {
    await expect(
      adapter.initializePayment({
        email: 'test@example.com',
        amountMinor: 150.50,
        currencyCode: 'NGN',
        reference: 'invalid_002',
      })
    ).rejects.toThrow('Invalid minor-unit amount');
  });

  it('rejects invalid currency codes', async () => {
    await expect(
      adapter.initializePayment({
        email: 'test@example.com',
        amountMinor: 15000,
        currencyCode: 'ngn',
        reference: 'invalid_003',
      })
    ).rejects.toThrow('Invalid currency code');
  });

  it('rejects invalid payment metadata', async () => {
    await expect(
      adapter.initializePayment({
        email: 'test@example.com',
        amountMinor: 15000,
        currencyCode: 'NGN',
        reference: 'invalid_004',
        metadata: [],
      })
    ).rejects.toThrow(
      'Payment metadata must be an object'
    );
  });

  it('rejects a transfer without a provider reference', async () => {
    await expect(
      adapter.createTransfer({
        amountMinor: 50000,
        currencyCode: 'NGN',
        recipientCode: 'RCP_123',
        reference: '',
        reason: 'AURUM withdrawal',
      })
    ).rejects.toThrow('Transfer reference is required');
  });

  it('rejects a verification request without a reference', async () => {
    await expect(
      adapter.verifyPayment('')
    ).rejects.toThrow('Payment reference is required');
  });
});
