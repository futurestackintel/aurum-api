import { PaystackProvider } from './paystack.js';
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

function validateAmount(amountMinor) {
  assertSafeMinorUnits(amountMinor);

  if (amountMinor === 0) {
    throw new Error('Payment amount must be greater than zero');
  }
}

export class PaystackAdapter {
  constructor(secretKey) {
    if (
      typeof secretKey !== 'string' ||
      secretKey.trim() === ''
    ) {
      throw new Error('Paystack secret key is required');
    }

    this.provider = new PaystackProvider(secretKey);
    this.providerName = 'paystack';
  }

  /**
   * Initialize a payment using integer minor units.
   * No major-unit conversion is performed here.
   */
  async initializePayment({
    email,
    amountMinor,
    currencyCode,
    reference,
    callbackUrl = null,
    metadata = {},
  }) {
    email = requireText(email, 'Customer email');
    reference = requireText(reference, 'Payment reference');

    validateAmount(amountMinor);
    currencyCode = validateCurrencyCode(currencyCode);

    if (
      typeof metadata !== 'object' ||
      metadata === null ||
      Array.isArray(metadata)
    ) {
      throw new Error('Payment metadata must be an object');
    }

    const result = await this.provider.request(
      'POST',
      '/transaction/initialize',
      {
        email,
        amount: amountMinor,
        currency: currencyCode,
        reference,
        callback_url: callbackUrl || undefined,
        metadata,
      }
    );

    return {
      provider: this.providerName,
      reference: result.reference,
      authorizationUrl: result.authorization_url,
      accessCode: result.access_code,
      amountMinor,
      currencyCode,
      status: 'pending',
    };
  }

  /**
   * Verify a payment and normalize the provider response.
   */
  async verifyPayment(reference) {
    reference = requireText(reference, 'Payment reference');

    const result = await this.provider.request(
      'GET',
      `/transaction/verify/${encodeURIComponent(reference)}`
    );

    const amountMinor = Number(result.amount);

    if (
      !Number.isSafeInteger(amountMinor) ||
      amountMinor < 0
    ) {
      throw new Error('Paystack returned an invalid payment amount');
    }

    return {
      provider: this.providerName,
      reference: result.reference,
      providerReference: result.id
        ? String(result.id)
        : null,
      amountMinor,
      currencyCode: validateCurrencyCode(result.currency),
      status: result.status,
      paidAt: result.paid_at || null,
      gatewayResponse: result.gateway_response || null,
    };
  }

  /**
   * Initiate a withdrawal using integer minor units.
   */
  async createTransfer({
    amountMinor,
    currencyCode,
    recipientCode,
    reference,
    reason,
  }) {
    validateAmount(amountMinor);

    currencyCode = validateCurrencyCode(currencyCode);
    recipientCode = requireText(
      recipientCode,
      'Transfer recipient'
    );
    reference = requireText(reference, 'Transfer reference');
    reason = requireText(reason, 'Transfer reason');

    const result = await this.provider.request(
      'POST',
      '/transfer',
      {
        source: 'balance',
        amount: amountMinor,
        currency: currencyCode,
        recipient: recipientCode,
        reference,
        reason,
      }
    );

    return {
      provider: this.providerName,
      reference: result.reference || reference,
      transferCode: result.transfer_code || null,
      amountMinor,
      currencyCode,
      status: result.status || 'pending',
    };
  }
  }
