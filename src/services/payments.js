// ============================================================
// AURUM Payment Service
// Wrapper around PaystackProvider.
// All payment logic goes through here — never call
// PaystackProvider directly from routes.
// ============================================================

import { PaystackProvider } from "./paystack.js";

export class PaymentService {
  constructor(env) {
    this.provider = new PaystackProvider(env.PAYSTACK_SECRET_KEY);
    this.PLATFORM_FEE_PERCENT = 0.05;
  }

  // ── Customers ───────────────────────────────────────────────

  async createCustomer({ email, firstName, lastName, userId }) {
    return this.provider.createCustomer({
      email,
      first_name: firstName,
      last_name: lastName,
      metadata: { aurum_user_id: userId },
    });
  }

  // ── Verification ────────────────────────────────────────────

  async verifyPayment(reference) {
    return this.provider.verifyTransaction(reference);
  }

  // ── Wallet ──────────────────────────────────────────────────

  async initializeWalletDeposit({ email, amount, userId, callbackUrl }) {
    const reference = `wallet_${userId}_${Date.now()}`;

    const result = await this.provider.initializeTransaction({
      email,
      amount,
      callback_url: callbackUrl,
      metadata: {
        type: "wallet_deposit",
        user_id: userId,
        reference,
      },
    });

    return {
      authorization_url: result.authorization_url,
      reference: result.reference || reference,
    };
  }

  async createTransferRecipient({ name, account_number, bank_code, currency = "NGN" }) {
    return this.provider.createTransferRecipient({
      name,
      account_number,
      bank_code,
      currency,
    });
  }

  async initiateWithdrawal({ amount, recipientCode, userId }) {
    return this.provider.transfer({
      amount,
      recipient: recipientCode,
      reason: `AURUM wallet withdrawal for user ${userId}`,
    });
  }

  // ── Subscriptions ────────────────────────────────────────────

  async initializeSubscriptionPayment({ email, amount, tier, userId, callbackUrl }) {
    const reference = `sub_${tier}_${userId}_${Date.now()}`;

    const result = await this.provider.initializeTransaction({
      email,
      amount,
      callback_url: callbackUrl,
      metadata: {
        type: "subscription",
        tier,
        user_id: userId,
        reference,
      },
    });

    return {
      authorization_url: result.authorization_url,
      reference: result.reference || reference,
      tier,
    };
  }

  // ── Challenges ───────────────────────────────────────────────

  async initializeChallengePayment({ email, amount, challengeId, userId, callbackUrl }) {
    const reference = `challenge_${userId}_${challengeId}_${Date.now()}`;

    const result = await this.provider.initializeTransaction({
      email,
      amount,
      callback_url: callbackUrl,
      metadata: {
        type: "challenge_entry",
        challenge_id: challengeId,
        user_id: userId,
        reference,
      },
    });

    return {
      authorization_url: result.authorization_url,
      reference: result.reference || reference,
    };
  }

  async payoutWinner({ amount, recipientCode, challengeId }) {
    const fee    = parseFloat((amount * this.PLATFORM_FEE_PERCENT).toFixed(2));
    const payout = amount - fee;

    return this.provider.transfer({
      amount: payout,
      recipient: recipientCode,
      reason: `AURUM Challenge #${challengeId} winnings`,
    });
  }

  // ── Helpers ──────────────────────────────────────────────────

  calculateFee(amount) {
    return parseFloat((amount * this.PLATFORM_FEE_PERCENT).toFixed(2));
  }

  getSubscriptionPlans() {
    return {
      contender: "PLN_pro_contender",
      sovereign:  "PLN_sovereign",
    };
  }
}
