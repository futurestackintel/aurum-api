// ============================================================
// AURUM Payment Service
// Provider-independent payment orchestration.
// Provider-specific API operations belong in adapters.
// ============================================================

import { PaystackAdapter } from "./paystackAdapter.js";

export class PaymentService {
  constructor(env, options = {}) {
    this.adapters = options.adapters || {
      paystack: new PaystackAdapter(env.PAYSTACK_SECRET_KEY),
    };

    this.defaultProvider = env.PAYMENT_PROVIDER || "paystack";
    this.currency = env.PAYMENT_CURRENCY || env.PAYSTACK_CURRENCY || "NGN";

    // Preserved for legacy callers during migration.
    this.PLATFORM_FEE_PERCENT = 0.05;
    this.usdToNgnRate = parseFloat(env.USD_TO_NGN_RATE) || 1600;
  }

  getProvider(providerName = this.defaultProvider) {
    const provider = this.adapters[providerName];

    if (!provider) {
      throw new Error(`Unsupported payment provider: ${providerName}`);
    }

    return provider;
  }

  // ----------------------------------------------------------
  // Provider-independent payment operations
  // ----------------------------------------------------------

  async initializePayment({
    provider,
    email,
    amountMinor,
    currencyCode,
    reference,
    callbackUrl,
    metadata,
  }) {
    return this.getProvider(provider).initializePayment({
      email,
      amountMinor,
      currencyCode,
      reference,
      callbackUrl,
      metadata,
    });
  }

  async verifyPayment(reference, provider) {
    return this.getProvider(provider).verifyPayment(reference);
  }

  async createTransfer({
    provider,
    amountMinor,
    currencyCode,
    recipientCode,
    reference,
    reason,
  }) {
    return this.getProvider(provider).createTransfer({
      amountMinor,
      currencyCode,
      recipientCode,
      reference,
      reason,
    });
  }

  async verifyTransfer(reference, provider) {
    return this.getProvider(provider).verifyTransfer(reference);
  }

  // ----------------------------------------------------------
  // Legacy compatibility helpers
  // ----------------------------------------------------------

  toChargeAmount(usdAmount) {
    if (this.currency === "USD") {
      return usdAmount;
    }

    return Math.round(usdAmount * this.usdToNgnRate * 100) / 100;
  }

  async createCustomer({ email, firstName, lastName, userId }) {
    const provider = this.getProvider();

    if (typeof provider.createCustomer !== "function") {
      throw new Error("Selected payment provider does not support customer creation");
    }

    return provider.createCustomer({
      email,
      first_name: firstName,
      last_name: lastName,
      metadata: { aurum_user_id: userId },
    });
  }

  async initializeWalletDeposit({
    email,
    amount,
    userId,
    callbackUrl,
  }) {
    const reference = `wallet_${userId}_${Date.now()}`;

    const result = await this.getProvider().initializePayment({
      email,
      amountMinor: Math.round(this.toChargeAmount(amount) * 100),
      currencyCode: this.currency,
      reference,
      callbackUrl,
      metadata: {
        type: "wallet_deposit",
        user_id: userId,
        reference,
        usd_amount: amount,
      },
    });

    return {
      authorization_url: result.authorizationUrl,
      reference: result.reference || reference,
    };
  }

  async createTransferRecipient({
    name,
    account_number,
    bank_code,
    currency = "NGN",
  }) {
    const provider = this.getProvider();

    if (typeof provider.createTransferRecipient !== "function") {
      throw new Error("Selected payment provider does not support transfer recipients");
    }

    return provider.createTransferRecipient({
      name,
      account_number,
      bank_code,
      currency,
    });
  }

    async initiateWithdrawal({
    amount,
    recipientCode,
    userId,
  }) {
    const provider = this.getProvider();

    if (typeof provider.createTransfer !== 'function') {
      throw new Error(
        'Selected payment provider does not support transfers'
      );
    }

    if (
      typeof amount !== 'number' ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      throw new Error('Withdrawal amount must be positive');
    }

    const amountMinor = Math.round(amount * 100);

    return provider.createTransfer({
      amountMinor,
      currencyCode: this.currency,
      recipientCode,
      reference: `withdrawal_${userId}_${Date.now()}`,
      reason: `AURUM wallet withdrawal for user ${userId}`,
    });
  }

  async initializeSubscriptionPayment({
    email,
    amount,
    tier,
    userId,
    callbackUrl,
  }) {
    const reference = `sub_${tier}_${userId}_${Date.now()}`;

    const result = await this.getProvider().initializePayment({
      email,
      amountMinor: Math.round(this.toChargeAmount(amount) * 100),
      currencyCode: this.currency,
      reference,
      callbackUrl,
      metadata: {
        type: "subscription",
        tier,
        user_id: userId,
        reference,
        usd_amount: amount,
      },
    });

    return {
      authorization_url: result.authorizationUrl,
      reference: result.reference || reference,
      tier,
    };
  }

  async initializeChallengePayment({
    email,
    amount,
    challengeId,
    userId,
    callbackUrl,
  }) {
    const reference = `challenge_${userId}_${challengeId}_${Date.now()}`;

    const result = await this.getProvider().initializePayment({
      email,
      amountMinor: Math.round(this.toChargeAmount(amount) * 100),
      currencyCode: this.currency,
      reference,
      callbackUrl,
      metadata: {
        type: "challenge_entry",
        challenge_id: challengeId,
        user_id: userId,
        reference,
        usd_amount: amount,
      },
    });

    return {
      authorization_url: result.authorizationUrl,
      reference: result.reference || reference,
    };
  }

  async payoutWinner({
    amount,
    recipientCode,
    challengeId,
  }) {
    const fee = parseFloat(
      (amount * this.PLATFORM_FEE_PERCENT).toFixed(2)
    );

    const payout = amount - fee;

    return this.initiateWithdrawal({
      amount: payout,
      recipientCode,
      userId: `challenge_${challengeId}`,
    });
  }

  calculateFee(amount) {
    return parseFloat(
      (amount * this.PLATFORM_FEE_PERCENT).toFixed(2)
    );
  }

  getSubscriptionPlans() {
    return {
      contender: "PLN_pro_contender",
      sovereign: "PLN_sovereign",
    };
  }
}
